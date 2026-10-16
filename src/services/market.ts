// Datos del panel con caché en KV y freno de créditos de Twelve Data.
// KV del plan gratis: 1.000 escrituras/día → se guarda poco y en registros agrupados.

import { BCRP_SERIES, getBcrp, lastWithValue, type BcrpPoint } from '../lib/bcrp';
import { FRED_SERIES, getFred, type FredPoint } from '../lib/fred';
import { ApiError } from '../lib/http';
import { lastSessionDate, usMarketOpen } from '../lib/market-hours';
import { addDays, isoDate } from '../lib/num';
import { seriesStats, type SeriesStats } from '../lib/stats';
import { getDailySeries, getQuotes, type DailyPoint, type Quote } from '../lib/twelvedata';

export const DEFAULT_WATCHLIST = ['BAP', 'SCCO', 'BVN', 'SPY', 'USD/PEN', 'BTC/USD'];
export const MAX_SYMBOLS = 8; // el plan gratis permite 8 créditos por minuto
/** El panel pide precios cada 10 min; la caché vence un poco antes para que cada pedido renueve. */
export const QUOTE_TTL_MS = 9 * 60_000;
export const FORCE_MIN_MS = 30_000; // «Actualizar» no renueva si el dato tiene menos de 30 s
export const HISTORY_TTL_MS = 12 * 3_600_000;
export const MACRO_TTL_MS = 6 * 3_600_000;
/** Créditos diarios que la app se permite gastar; el resto (de 800) queda para el conector en los chats. */
export const DAILY_CREDIT_CAP = 600;

export interface Deps {
  kv: KVNamespace;
  now: Date;
  fetch?: typeof fetch;
  twelveKey?: string;
  fredKey?: string;
}

export interface Fresh<T> {
  data: T;
  fetchedAt: string;
  /** true si se muestra un dato guardado porque no se pudo (o no convenía) renovarlo. */
  stale: boolean;
  note: string | null;
}

interface Stored<T> {
  fetchedAt: string;
  data: T;
}

// ---------- lista de seguimiento ----------

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}(\/[A-Z0-9]{2,10})?$/;

export function validateWatchlist(input: unknown): string[] {
  const raw = (input as { symbols?: unknown })?.symbols;
  if (!Array.isArray(raw)) throw new ApiError('bad_request', 400, 'Envía {"symbols": ["BAP", ...]}.');
  const out: string[] = [];
  for (const v of raw) {
    const s = String(v ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) throw new ApiError('bad_request', 400, `Símbolo no válido: «${String(v).slice(0, 20)}».`);
    if (!out.includes(s)) out.push(s);
  }
  if (!out.length) throw new ApiError('bad_request', 400, 'La lista no puede quedar vacía.');
  if (out.length > MAX_SYMBOLS) throw new ApiError('bad_request', 400, `Máximo ${MAX_SYMBOLS} símbolos (límite de 8 créditos por minuto).`);
  return out;
}

export async function getWatchlist(kv: KVNamespace): Promise<string[]> {
  const saved = await kv.get<string[]>('watchlist', 'json');
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_WATCHLIST;
}

export async function saveWatchlist(kv: KVNamespace, symbols: string[]): Promise<void> {
  await kv.put('watchlist', JSON.stringify(symbols));
}

// ---------- freno de créditos ----------

interface BudgetRec {
  day: string; // día UTC
  used: number;
}

export async function creditsUsed(kv: KVNamespace, now: Date): Promise<number> {
  const b = await kv.get<BudgetRec>('budget', 'json');
  return b && b.day === isoDate(now) ? b.used : 0;
}

async function spendCredits(kv: KVNamespace, now: Date, n: number): Promise<void> {
  const used = await creditsUsed(kv, now);
  await kv.put('budget', JSON.stringify({ day: isoDate(now), used: used + n } satisfies BudgetRec));
}

function needKey(key: string | undefined, name: string, provider: 'twelvedata' | 'fred'): string {
  if (!key) throw new ApiError('not_configured', 503, `Falta ${name}.`, provider);
  return key;
}

// ---------- caché genérica ----------

async function cached<T>(
  d: Deps,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts: { credits?: number } = {},
): Promise<Fresh<T>> {
  const prev = await d.kv.get<Stored<T>>(key, 'json');
  const age = prev ? d.now.getTime() - Date.parse(prev.fetchedAt) : Infinity;
  if (prev && age < ttlMs) return { data: prev.data, fetchedAt: prev.fetchedAt, stale: false, note: null };

  const credits = opts.credits ?? 0;
  if (credits && (await creditsUsed(d.kv, d.now)) + credits > DAILY_CREDIT_CAP) {
    if (prev) return { data: prev.data, fetchedAt: prev.fetchedAt, stale: true, note: 'Freno de créditos del día: se muestra el último dato guardado.' };
    throw new ApiError('rate_limited', 429, 'Se alcanzó el freno de créditos del día.', 'twelvedata');
  }
  let data: T;
  try {
    data = await load();
  } catch (e) {
    if (prev && e instanceof ApiError) return { data: prev.data, fetchedAt: prev.fetchedAt, stale: true, note: e.message };
    throw e;
  }
  if (credits) await spendCredits(d.kv, d.now, credits);
  const fetchedAt = d.now.toISOString();
  await d.kv.put(key, JSON.stringify({ fetchedAt, data } satisfies Stored<T>));
  return { data, fetchedAt, stale: false, note: null };
}

// ---------- precios ----------

export interface QuotesData {
  quotes: Quote[];
  errors: Record<string, string>;
  symbols: string[];
  /** Cuándo se pidió por última vez cada símbolo (ISO): cada uno se renueva a su ritmo. */
  fetched: Record<string, string>;
}

/** Acciones y ETF de EE. UU. no llevan «/»; divisas y cripto sí (USD/PEN, BTC/USD). */
export const isUsEquity = (symbol: string) => !symbol.includes('/');

/**
 * Qué símbolos hay que pedir ahora. Divisas y cripto: cuando vence la caché (o con «Actualizar»).
 * Acciones: igual con la bolsa abierta; con la bolsa cerrada el precio no cambia, así que solo se
 * piden si nunca se pidieron, si hubo una sesión desde el último pedido, o una vez después del
 * cierre para tomar el precio final (si el último pedido fue en plena sesión).
 */
export function symbolsToRefresh(prev: QuotesData | null, symbols: string[], now: Date, force: boolean): string[] {
  const open = usMarketOpen(now);
  const minAge = force ? FORCE_MIN_MS : QUOTE_TTL_MS;
  return symbols.filter((s) => {
    const at = prev?.fetched[s];
    if (!at) return true;
    const last = new Date(at);
    const age = now.getTime() - last.getTime();
    if (isUsEquity(s) && !open) {
      return lastSessionDate(last) !== lastSessionDate(now) || (usMarketOpen(last) && age >= QUOTE_TTL_MS);
    }
    return age >= minAge;
  });
}

/** Lo guardado antes de este cambio no tenía `fetched`: se asume la hora del registro para todos. */
function readQuotes(stored: Stored<QuotesData> | null): QuotesData | null {
  if (!stored) return null;
  const d = stored.data;
  return { ...d, fetched: d.fetched ?? Object.fromEntries(d.symbols.map((s) => [s, stored.fetchedAt])) };
}

function mergeQuotes(prev: QuotesData | null, batch: { quotes: Quote[]; errors: Record<string, string> }, due: string[], symbols: string[], now: Date): QuotesData {
  const bySymbol = new Map((prev?.quotes ?? []).map((q) => [q.symbol, q]));
  const errors = { ...(prev?.errors ?? {}) };
  const fetched = { ...(prev?.fetched ?? {}) };
  for (const s of due) {
    bySymbol.delete(s);
    delete errors[s];
    fetched[s] = now.toISOString();
  }
  for (const q of batch.quotes) bySymbol.set(q.symbol, q);
  Object.assign(errors, batch.errors);
  return onlySymbols({ quotes: [...bySymbol.values()], errors, symbols, fetched }, symbols);
}

/** Deja solo los símbolos de la lista actual (lo guardado puede traer otros de una lista anterior). */
function onlySymbols(data: QuotesData, symbols: string[]): QuotesData {
  const keep = new Set(symbols);
  return {
    quotes: data.quotes.filter((q) => keep.has(q.symbol)),
    errors: Object.fromEntries(Object.entries(data.errors).filter(([s]) => keep.has(s))),
    symbols,
    fetched: Object.fromEntries(Object.entries(data.fetched).filter(([s]) => keep.has(s))),
  };
}

/** Hora del pedido más reciente entre los símbolos de la lista. */
function latestFetch(data: QuotesData, now: Date): string {
  const times = Object.values(data.fetched);
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : now.toISOString();
}

export async function quotes(d: Deps, symbols: string[], force: boolean): Promise<Fresh<QuotesData> & { market: { open: boolean } }> {
  const market = { open: usMarketOpen(d.now) };
  const prev = readQuotes(await d.kv.get<Stored<QuotesData>>('quotes', 'json'));
  const due = symbolsToRefresh(prev, symbols, d.now, force);
  const view = (data: QuotesData, stale: boolean, note: string | null) => {
    const shown = onlySymbols(data, symbols);
    return { data: shown, fetchedAt: latestFetch(shown, d.now), stale, note, market };
  };
  if (!due.length) return view(prev ?? { quotes: [], errors: {}, symbols, fetched: {} }, false, null);

  try {
    const key = needKey(d.twelveKey, 'TWELVE_DATA_API_KEY', 'twelvedata');
    if ((await creditsUsed(d.kv, d.now)) + due.length > DAILY_CREDIT_CAP) {
      throw new ApiError('rate_limited', 429, 'Freno de créditos del día: se muestra el último dato guardado.', 'twelvedata');
    }
    const batch = await getQuotes(due, key, d.fetch);
    await spendCredits(d.kv, d.now, due.length);
    const data = mergeQuotes(prev, batch, due, symbols, d.now);
    await d.kv.put('quotes', JSON.stringify({ fetchedAt: d.now.toISOString(), data } satisfies Stored<QuotesData>));
    return view(data, false, null);
  } catch (e) {
    // Si falla y hay un dato guardado, mejor eso que nada.
    if (prev && e instanceof ApiError) return view(prev, true, e.message);
    throw e;
  }
}

// ---------- historial de 1 año ----------

export interface HistoryData {
  symbol: string;
  points: [string, number][];
}

export async function history(d: Deps, symbol: string): Promise<Fresh<HistoryData> & { stats: SeriesStats | null }> {
  const today = isoDate(d.now);
  const res = await cached<HistoryData>(
    d,
    `hist:${symbol}`,
    HISTORY_TTL_MS,
    async () => {
      // end_date no incluye ese día: la serie llega hasta el último cierre.
      const pts = await getDailySeries(symbol, addDays(today, -366), today, needKey(d.twelveKey, 'TWELVE_DATA_API_KEY', 'twelvedata'), d.fetch);
      return { symbol, points: pts.map((p) => [p.date, p.close] as [string, number]) };
    },
    { credits: 1 },
  );
  const pts: DailyPoint[] = res.data.points.map(([date, close]) => ({ date, close }));
  return { ...res, stats: seriesStats(pts) };
}

// ---------- Perú (BCRP) ----------

export interface PeruData {
  fx: { date: string; buy: number; sell: number }[];
  policyRate: { date: string; value: number } | null;
  inflation: { date: string; value: number }[];
}

export function shapePeru(daily: BcrpPoint[], monthly: BcrpPoint[]): PeruData {
  const fx = daily
    .filter((p) => p.values[0] != null && p.values[1] != null)
    .map((p) => ({ date: p.date, buy: p.values[0]!, sell: p.values[1]! }))
    .slice(-30);
  const inflation = monthly.filter((p) => p.values[0] != null).map((p) => ({ date: p.date, value: p.values[0]! }));
  return { fx, policyRate: lastWithValue(daily, 2), inflation };
}

export async function peru(d: Deps): Promise<Fresh<PeruData>> {
  const today = isoDate(d.now);
  return cached<PeruData>(d, 'peru', MACRO_TTL_MS, async () => {
    const [daily, monthly] = await Promise.all([
      getBcrp([BCRP_SERIES.fxBuy, BCRP_SERIES.fxSell, BCRP_SERIES.policyRate], addDays(today, -60), today, d.fetch),
      getBcrp([BCRP_SERIES.inflation12m], addDays(today, -430).slice(0, 7), today.slice(0, 7), d.fetch),
    ]);
    return shapePeru(daily, monthly);
  });
}

// ---------- EE. UU. (FRED) ----------

export interface UsaData {
  treasury10y: FredPoint[];
  fedFunds: FredPoint | null;
  cpiYoY: FredPoint[];
}

export async function usa(d: Deps): Promise<Fresh<UsaData>> {
  const today = isoDate(d.now);
  return cached<UsaData>(d, 'usa', MACRO_TTL_MS, async () => {
    const key = needKey(d.fredKey, 'FRED_API_KEY', 'fred');
    const [t10, dff, cpi] = await Promise.all([
      getFred(FRED_SERIES.treasury10y, { start: addDays(today, -95) }, key, d.fetch),
      getFred(FRED_SERIES.fedFunds, { start: addDays(today, -20) }, key, d.fetch),
      getFred(FRED_SERIES.cpi, { start: addDays(today, -430), units: 'pc1' }, key, d.fetch),
    ]);
    return { treasury10y: t10.slice(-60), fedFunds: dff.at(-1) ?? null, cpiYoY: cpi.slice(-13) };
  });
}

export type { Quote };
