// Datos del panel con caché en KV y freno de créditos de Twelve Data.
// KV del plan gratis: 1.000 escrituras/día → se guarda poco y en registros agrupados.

import { BCRP_SERIES, getBcrp, lastWithValue, type BcrpPoint } from '../lib/bcrp';
import { FRED_SERIES, getFred, type FredPoint } from '../lib/fred';
import { ApiError } from '../lib/http';
import { alignByDate, indicators, pearson, rebase, returnsOf, sliceIndicators, type Indicators } from '../lib/indicators';
import { lastSessionDate, usMarketOpen } from '../lib/market-hours';
import { addDays, isoDate } from '../lib/num';
import { seriesStats, type SeriesStats } from '../lib/stats';
import { getDailySeries, getQuotes, type Quote } from '../lib/twelvedata';

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
  finnhubKey?: string;
}

export interface Fresh<T> {
  data: T;
  fetchedAt: string;
  /** true si se muestra un dato guardado porque no se pudo (o no convenía) renovarlo. */
  stale: boolean;
  note: string | null;
}

export interface Stored<T> {
  fetchedAt: string;
  data: T;
}

// ---------- lista de seguimiento ----------

export const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}(\/[A-Z0-9]{2,10})?$/;

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

export async function cached<T>(
  d: Deps,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts: { credits?: number; valid?: (data: T) => boolean } = {},
): Promise<Fresh<T>> {
  const prev = await d.kv.get<Stored<T>>(key, 'json');
  // Un registro de antes de un cambio de formato se renueva aunque no haya vencido (y sirve de respaldo si falla).
  const current = prev && (!opts.valid || opts.valid(prev.data));
  const age = current ? d.now.getTime() - Date.parse(prev.fetchedAt) : Infinity;
  if (current && age < ttlMs) return { data: prev.data, fetchedAt: prev.fetchedAt, stale: false, note: null };

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

/**
 * Precios de la lista con las reglas de renovación de arriba. `only` limita qué símbolos se pueden
 * renovar (el conector de Claude pide algunos); el registro guardado sigue teniendo toda la lista.
 */
export async function quotes(
  d: Deps,
  symbols: string[],
  force: boolean,
  only: string[] = symbols,
): Promise<Fresh<QuotesData> & { market: { open: boolean } }> {
  const market = { open: usMarketOpen(d.now) };
  const prev = readQuotes(await d.kv.get<Stored<QuotesData>>('quotes', 'json'));
  const due = symbolsToRefresh(prev, only.filter((s) => symbols.includes(s)), d.now, force);
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

// ---------- historial de 5 años y rangos ----------

/** Rangos de los gráficos. Todos salen del mismo historial de 5 años: Twelve Data cobra 1 crédito por consulta, traiga los días que traiga. */
export const RANGES = ['1M', '3M', '6M', 'YTD', '1A', '3A', '5A'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '1A';
/** Algo más de 5 años, para que el rango 5A tenga su cierre base. */
const HISTORY_DAYS = 5 * 366 + 10;

export const isRange = (v: unknown): v is Range => typeof v === 'string' && (RANGES as readonly string[]).includes(v);

/** Fecha en que empieza el rango, contando hacia atrás desde hoy (YTD: 1 de enero). */
export function rangeStart(range: Range, today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const monthsBack = (n: number) => new Date(Date.UTC(y, m - 1 - n, d)).toISOString().slice(0, 10);
  switch (range) {
    case '1M':
      return monthsBack(1);
    case '3M':
      return monthsBack(3);
    case '6M':
      return monthsBack(6);
    case 'YTD':
      return `${y}-01-01`;
    case '1A':
      return monthsBack(12);
    case '3A':
      return monthsBack(36);
    case '5A':
      return monthsBack(60);
  }
}

/**
 * Dónde empieza el rango dentro de una lista de fechas: en el último cierre ANTERIOR al inicio, para
 * medir el rendimiento desde el cierre previo (YTD, desde el cierre del año anterior; 1A, desde el de
 * hace un año). Si falta historia, desde el primero; si no hay cierres en el rango, el último.
 */
export function rangeStartIndex(dates: string[], range: Range, today: string): number {
  const start = rangeStart(range, today);
  const i = dates.findIndex((date) => date >= start);
  return i === -1 ? Math.max(0, dates.length - 1) : Math.max(0, i - 1);
}

/** Cierres del rango (ver `rangeStartIndex`). */
export function sliceRange(points: [string, number][], range: Range, today: string): [string, number][] {
  return points.slice(rangeStartIndex(points.map(([date]) => date), range, today));
}

/** Apertura, máximo, mínimo y volumen de un día (alineado con `points`; las divisas no traen volumen). */
export type Bar = [open: number | null, high: number | null, low: number | null, volume: number | null];

export interface HistoryData {
  symbol: string;
  points: [string, number][];
  /** Falta en lo guardado antes del 22 oct 2026: esos registros se renuevan una vez (1 crédito). */
  bars?: Bar[];
}

/** Velas y volumen del rango, en columnas alineadas con los cierres. */
export interface HistoryBars {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  volume: (number | null)[];
}

export type HistoryResult = Fresh<HistoryData> & {
  stats: SeriesStats | null;
  range: Range;
  /** Lo que hay guardado (5 años), para saber si un rango quedó corto. */
  available: { from: string | null; to: string | null };
  /**
   * Medias de 50 y 200 días, Bollinger (20 días, 2 desviaciones) y RSI de 14 días, alineados con
   * `points`. Se calculan con los 5 años guardados: la media de 200 días existe desde el primer día
   * de cualquier rango.
   */
  indicators: Indicators;
  /** Apertura, máximo, mínimo y volumen alineados con `points` (null si lo guardado es de antes de tenerlos). */
  bars: HistoryBars | null;
  /** Lectura del último cierre (la misma en cualquier rango): va siempre, para las señales de la lista. */
  latest: { date: string; close: number; sma50: number | null; sma200: number | null; rsi14: number | null } | null;
};

/**
 * Los 5 años guardados de un símbolo (1 crédito cuando hay que pedirlos de nuevo). Con `through` (lista diaria), se
 * piden hasta ese día inclusive y lo guardado sirve mientras ya lo incluya, sin vencer por tiempo.
 */
export function storedHistory(d: Deps, symbol: string, through?: string): Promise<Fresh<HistoryData>> {
  const today = isoDate(d.now);
  const hasBars = (h: HistoryData) => Array.isArray(h.bars) && h.bars.length === h.points.length;
  return cached<HistoryData>(
    d,
    `hist5:${symbol}`,
    through ? Infinity : HISTORY_TTL_MS,
    async () => {
      // end_date no incluye ese día: sin `through`, la serie llega hasta el último cierre antes de hoy.
      const end = through ? addDays(through, 1) : today;
      const pts = await getDailySeries(symbol, addDays(today, -HISTORY_DAYS), end, needKey(d.twelveKey, 'TWELVE_DATA_API_KEY', 'twelvedata'), d.fetch);
      return {
        symbol,
        points: pts.map((p) => [p.date, p.close] as [string, number]),
        bars: pts.map((p): Bar => [p.open ?? null, p.high ?? null, p.low ?? null, p.volume ?? null]),
      };
    },
    { credits: 1, valid: through ? (h) => hasBars(h) && (h.points.at(-1)?.[0] ?? '') >= through : hasBars },
  );
}

/** Columnas de velas y volumen desde `start`; null si lo guardado no las tiene. */
function sliceBars(bars: Bar[] | undefined, start: number): HistoryBars | null {
  if (!bars) return null;
  const cut = bars.slice(start);
  return { open: cut.map((b) => b[0]), high: cut.map((b) => b[1]), low: cut.map((b) => b[2]), volume: cut.map((b) => b[3]) };
}

/** Recorta los 5 años guardados al rango y calcula sus estadísticas e indicadores. */
export function shapeHistory(stored: Fresh<HistoryData>, range: Range, today: string): HistoryResult {
  const all = stored.data.points;
  const start = rangeStartIndex(all.map(([date]) => date), range, today);
  const points = all.slice(start);
  const ind = sliceIndicators(indicators(all.map(([, close]) => close)), start);
  const last = all.at(-1);
  return {
    ...stored,
    data: { symbol: stored.data.symbol, points },
    stats: seriesStats(points.map(([date, close]) => ({ date, close }))),
    range,
    available: { from: all[0]?.[0] ?? null, to: last?.[0] ?? null },
    indicators: ind,
    bars: sliceBars(stored.data.bars, start),
    latest: last
      ? { date: last[0], close: last[1], sma50: ind.sma50.at(-1) ?? null, sma200: ind.sma200.at(-1) ?? null, rsi14: ind.rsi14.at(-1) ?? null }
      : null,
  };
}

export async function history(d: Deps, symbol: string, range: Range = DEFAULT_RANGE): Promise<HistoryResult> {
  return shapeHistory(await storedHistory(d, symbol), range, isoDate(d.now));
}

// ---------- comparar símbolos ----------

export const COMPARE_MAX = 4;

export interface CompareSeries {
  symbol: string;
  closes: number[];
  /** Cuánto valdrían 100 invertidos el primer día común. */
  rebased: number[];
  stats: { totalReturn: number; annualVol: number | null; maxDrawdown: number | null } | null;
}

export interface CompareData {
  range: Range;
  /** Días en que todos los símbolos tienen cierre (la cripto también cotiza los fines de semana). */
  dates: string[];
  series: CompareSeries[];
  /** Correlación de los rendimientos diarios, en el orden de `series` (null si no se puede calcular). */
  correlation: (number | null)[][];
}

export type CompareResult = CompareData & {
  /** El dato más antiguo entre los símbolos comparados. */
  fetchedAt: string;
  stale: boolean;
  notes: string[];
  /** Símbolos que no se pudieron cargar: se compara el resto. */
  errors: Record<string, string>;
};

/** Normaliza la selección: de 2 a 4 símbolos distintos. */
export function compareSymbols(raw: string[]): string[] {
  const symbols = [...new Set(raw.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (symbols.length < 2 || symbols.length > COMPARE_MAX) {
    throw new ApiError('bad_request', 400, `Elige de 2 a ${COMPARE_MAX} símbolos distintos para comparar.`);
  }
  return symbols;
}

const round4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

/**
 * Alinea los 5 años de cada símbolo por fecha y recién ahí recorta el rango (desde el último día
 * común anterior al inicio): base 100, estadísticas y correlaciones usan exactamente los mismos días.
 */
export function shapeCompare(stored: HistoryData[], range: Range, today: string): CompareData {
  const aligned = alignByDate(stored.map((h) => h.points));
  const start = rangeStartIndex(aligned.dates, range, today);
  const dates = aligned.dates.slice(start);
  const closes = aligned.values.map((v) => v.slice(start));
  const returns = closes.map(returnsOf);
  return {
    range,
    dates,
    series: stored.map((h, i) => {
      const st = seriesStats(dates.map((date, j) => ({ date, close: closes[i]![j]! })));
      return {
        symbol: h.symbol,
        closes: closes[i]!,
        rebased: rebase(closes[i]!),
        stats: st && { totalReturn: st.totalReturn, annualVol: st.annualVol, maxDrawdown: st.maxDrawdown?.value ?? null },
      };
    }),
    correlation: returns.map((a, i) => returns.map((b, j) => (i === j ? 1 : round4(pearson(a, b))))),
  };
}

export async function compare(d: Deps, symbols: string[], range: Range): Promise<CompareResult> {
  const loaded: Fresh<HistoryData>[] = [];
  const errors: Record<string, string> = {};
  let firstError: ApiError | null = null;
  // Uno por uno: el contador de créditos se lee y se escribe en KV, y en paralelo se perderían sumas.
  for (const s of symbols) {
    try {
      loaded.push(await storedHistory(d, s));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      errors[s] = e.message;
      firstError ??= e;
    }
  }
  if (loaded.length < 2) throw firstError ?? new ApiError('bad_request', 400, 'Hacen falta al menos 2 símbolos para comparar.');
  const data = shapeCompare(
    loaded.map((h) => h.data),
    range,
    isoDate(d.now),
  );
  return {
    ...data,
    fetchedAt: loaded.map((h) => h.fetchedAt).sort()[0]!,
    stale: loaded.some((h) => h.stale),
    notes: [...new Set(loaded.map((h) => h.note).filter((n): n is string => !!n))],
    errors,
  };
}

// ---------- Perú (BCRP) ----------

export interface PeruData {
  fx: { date: string; buy: number; sell: number }[];
  policyRate: { date: string; value: number } | null;
  /** Tasa de referencia día por día (últimos ~60 días): resuelve los pronósticos de las decisiones del BCRP. */
  policyRates: { date: string; value: number }[];
  inflation: { date: string; value: number }[];
}

export function shapePeru(daily: BcrpPoint[], monthly: BcrpPoint[]): PeruData {
  const fx = daily
    .filter((p) => p.values[0] != null && p.values[1] != null)
    .map((p) => ({ date: p.date, buy: p.values[0]!, sell: p.values[1]! }))
    .slice(-30);
  const policyRates = daily.filter((p) => p.values[2] != null).map((p) => ({ date: p.date, value: p.values[2]! }));
  const inflation = monthly.filter((p) => p.values[0] != null).map((p) => ({ date: p.date, value: p.values[0]! }));
  return { fx, policyRate: lastWithValue(daily, 2), policyRates, inflation };
}

export async function peru(d: Deps): Promise<Fresh<PeruData>> {
  const today = isoDate(d.now);
  // Lo guardado antes del 23 oct no traía la tasa día por día: se renueva una vez.
  return cached<PeruData>(
    d,
    'peru',
    MACRO_TTL_MS,
    async () => {
      const [daily, monthly] = await Promise.all([
        getBcrp([BCRP_SERIES.fxBuy, BCRP_SERIES.fxSell, BCRP_SERIES.policyRate], addDays(today, -60), today, d.fetch),
        getBcrp([BCRP_SERIES.inflation12m], addDays(today, -430).slice(0, 7), today.slice(0, 7), d.fetch),
      ]);
      return shapePeru(daily, monthly);
    },
    { valid: (p) => Array.isArray(p.policyRates) },
  );
}

// ---------- Perú: cobre, oro, reservas, BVL, bonos y riesgo país (BCRP) ----------

export interface PointChange {
  date: string;
  value: number;
  /** Variación porcentual (para precios e índices). */
  pct: number;
  /** Diferencia en la unidad de la serie (para tasas: puntos porcentuales; para el spread: puntos básicos). */
  diff: number;
}

export interface SeriesSummary {
  last: { date: string; value: number } | null;
  /** Variación frente al último dato anterior a hace 1 mes y a hace 12 meses (como los rangos 1M y 1A). */
  m1: PointChange | null;
  y1: PointChange | null;
}

export interface MarketSeries {
  points: [string, number][];
  summary: SeriesSummary;
}

export interface PeruMarkets {
  /** Cobre en Londres, US$ por libra (el BCRP lo publica en centavos). */
  copper: MarketSeries;
  /** Oro en Londres, US$ por onza troy. */
  gold: MarketSeries;
  /** Reservas internacionales netas, millones de US$. */
  reserves: MarketSeries;
  /** Índice general de la Bolsa de Valores de Lima. */
  bvl: MarketSeries;
  /** Rendimiento del bono del gobierno peruano a 10 años en soles, %. */
  bond10pen: MarketSeries;
  /** Rendimiento del bono del gobierno peruano a 10 años en dólares, %. */
  bond10usd: MarketSeries;
  /**
   * Riesgo país aproximado, en puntos básicos: bono peruano en dólares a 10 años menos el del Tesoro de EE. UU.
   * a 10 años, los días en que hay los dos. No es el EMBIG: el BCRP dejó de actualizarlo el 3 de setiembre de 2026.
   */
  spread10: MarketSeries;
}

/** Último dato y sus variaciones a 1 y 12 meses; null donde no hay historia suficiente. */
export function summarize(points: [string, number][]): SeriesSummary {
  const last = points.at(-1);
  if (!last) return { last: null, m1: null, y1: null };
  const dates = points.map(([date]) => date);
  const change = (range: Range): PointChange | null => {
    const start = rangeStart(range, last[0]);
    const base = points[rangeStartIndex(dates, range, last[0])]!;
    // Sin historia suficiente, o con un hueco largo justo antes del inicio, la variación no sería la del periodo.
    if (base[0] > start || base[0] < addDays(start, -15) || base[0] === last[0]) return null;
    return { date: base[0], value: base[1], pct: last[1] / base[1] - 1, diff: Math.round((last[1] - base[1]) * 1e4) / 1e4 };
  };
  return { last: { date: last[0], value: last[1] }, m1: change('1M'), y1: change('1A') };
}

const MARKET_CODES = [
  BCRP_SERIES.copper,
  BCRP_SERIES.gold,
  BCRP_SERIES.reserves,
  BCRP_SERIES.bvl,
  BCRP_SERIES.bond10pen,
  BCRP_SERIES.bond10usd,
  BCRP_SERIES.ust10,
];

/** Columnas del pedido (en el orden de MARKET_CODES) → series sin los días sin dato. */
export function shapeMarkets(points: BcrpPoint[]): PeruMarkets {
  const series = (pts: [string, number][]): MarketSeries => ({ points: pts, summary: summarize(pts) });
  const column = (i: number, scale = 1) =>
    series(points.filter((p) => p.values[i] != null).map((p) => [p.date, Math.round(p.values[i]! * scale * 1e4) / 1e4] as [string, number]));
  // Bono en US$ menos Tesoro de EE. UU., en puntos básicos, solo los días con los dos datos.
  const spread = series(
    points
      .filter((p) => p.values[5] != null && p.values[6] != null)
      .map((p) => [p.date, Math.round((p.values[5]! - p.values[6]!) * 1000) / 10] as [string, number]),
  );
  return {
    copper: column(0, 0.01),
    gold: column(1),
    reserves: column(2),
    bvl: column(3),
    bond10pen: column(4),
    bond10usd: column(5),
    spread10: spread,
  };
}

/** Un año y algo de datos diarios (para la variación a 12 meses). Datos públicos: también los ven los amigos. */
export async function peruMarkets(d: Deps): Promise<Fresh<PeruMarkets>> {
  const today = isoDate(d.now);
  // «peru-markets2»: desde que se sumaron los bonos y el riesgo país (el registro anterior no los tenía).
  return cached<PeruMarkets>(d, 'peru-markets2', MACRO_TTL_MS, async () =>
    shapeMarkets(await getBcrp(MARKET_CODES, addDays(today, -400), today, d.fetch)),
  );
}

// ---------- EE. UU. (FRED) ----------

export interface UsaData {
  treasury10y: FredPoint[];
  fedFunds: FredPoint | null;
  cpiYoY: FredPoint[];
  /** Rango objetivo de la Fed día por día (últimos ~60 días): resuelve los pronósticos de sus decisiones. */
  fedTarget: { date: string; lower: number; upper: number }[];
}

export async function usa(d: Deps): Promise<Fresh<UsaData>> {
  const today = isoDate(d.now);
  // Lo guardado antes del 23 oct no traía el rango objetivo: se renueva una vez.
  return cached<UsaData>(
    d,
    'usa',
    MACRO_TTL_MS,
    async () => {
      const key = needKey(d.fredKey, 'FRED_API_KEY', 'fred');
      const [t10, dff, cpi, upper, lower] = await Promise.all([
        getFred(FRED_SERIES.treasury10y, { start: addDays(today, -95) }, key, d.fetch),
        getFred(FRED_SERIES.fedFunds, { start: addDays(today, -20) }, key, d.fetch),
        getFred(FRED_SERIES.cpi, { start: addDays(today, -430), units: 'pc1' }, key, d.fetch),
        getFred(FRED_SERIES.fedTargetUpper, { start: addDays(today, -60) }, key, d.fetch),
        getFred(FRED_SERIES.fedTargetLower, { start: addDays(today, -60) }, key, d.fetch),
      ]);
      const low = new Map(lower.map((p) => [p.date, p.value]));
      const fedTarget = upper.filter((p) => low.has(p.date)).map((p) => ({ date: p.date, lower: low.get(p.date)!, upper: p.value }));
      return { treasury10y: t10.slice(-60), fedFunds: dff.at(-1) ?? null, cpiYoY: cpi.slice(-13), fedTarget };
    },
    { valid: (u) => Array.isArray(u.fedTarget) },
  );
}

export type { Quote };
