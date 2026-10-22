// Lista diaria (lista ampliada): hasta 20 símbolos más, solo con el cierre de cada día, no precios en vivo. Una tarea
// programada (cron de wrangler.jsonc, cada 10 minutos) los renueva de a pocos después del cierre de Nueva York:
// 1 crédito por símbolo al día y nunca más de 5 por vez, por el límite de 8 créditos por minuto. El panel lee un solo
// registro resumido (`eod`) en vez de 20 historiales, por el límite de 10 ms de procesador.

import { finnhubGet, parseProfile } from '../lib/finnhub';
import { ApiError } from '../lib/http';
import { lastClosedSession } from '../lib/market-hours';
import { addDays, isoDate } from '../lib/num';
import { SYMBOL_RE, getWatchlist, rangeStartIndex, storedHistory, type Deps, type HistoryData } from './market';

export const EOD_MAX = 20;
/** Símbolos por ejecución de la tarea (8 créditos por minuto, compartidos con el panel). */
export const EOD_PER_RUN = 5;
/** Símbolos nuevos que se piden apenas se guardan; los demás, en la próxima ejecución. */
export const EOD_NEW_NOW = 4;
/** Minutos después del cierre para dar por firme el dato del día. */
export const EOD_SETTLE_MIN = 30;

export interface EodRow {
  symbol: string;
  name: string | null;
  /** Día del último cierre guardado. */
  date: string;
  close: number;
  prevClose: number | null;
  /** Cierre de cada semana del último año (para el minigráfico). */
  spark: [string, number][];
  /** Rendimiento de 1 año (fracción), desde el cierre de hace un año. */
  ret1y: number | null;
  /** Sesión (o día, en cripto y divisas) para la que ya se buscó el cierre: no se vuelve a pedir. Vacío = reintentar. */
  checked: string;
  fetchedAt: string;
}

export interface EodSummary {
  rows: Record<string, EodRow>;
}

export async function getEodList(kv: KVNamespace): Promise<string[]> {
  const saved = await kv.get<string[]>('watchlist-eod', 'json');
  return Array.isArray(saved) ? saved : [];
}

/** Las dos listas juntas, sin repetir: la de seguimiento primero. */
export async function knownSymbols(kv: KVNamespace): Promise<string[]> {
  const [main, eod] = await Promise.all([getWatchlist(kv), getEodList(kv)]);
  return [...main, ...eod.filter((s) => !main.includes(s))];
}

export function validateEodList(input: unknown, main: string[]): string[] {
  const raw = (input as { symbols?: unknown })?.symbols;
  if (!Array.isArray(raw)) throw new ApiError('bad_request', 400, 'Envía {"symbols": ["NVDA", ...]}.');
  const out: string[] = [];
  for (const v of raw) {
    const s = String(v ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) throw new ApiError('bad_request', 400, `Símbolo no válido: «${String(v).slice(0, 20)}».`);
    if (main.includes(s)) throw new ApiError('bad_request', 400, `${s} ya está en tu lista de seguimiento.`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > EOD_MAX) throw new ApiError('bad_request', 400, `Máximo ${EOD_MAX} símbolos en la lista diaria.`);
  return out;
}

/** Para qué día se busca el cierre: en acciones, el último de Nueva York ya firme; en cripto y divisas, ayer (UTC). */
export function eodTarget(symbol: string, now: Date): string {
  return symbol.includes('/') ? addDays(isoDate(now), -1) : lastClosedSession(now, EOD_SETTLE_MIN);
}

/** Lunes de la semana de esa fecha. */
function weekOf(date: string): string {
  const wd = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}

/** Lo que muestra la fila: último cierre, el anterior, el cierre de cada semana del año y el rendimiento de 1 año. */
export function summarizeHistory(h: HistoryData, name: string | null, checked: string, fetchedAt: string, today: string): EodRow | null {
  const pts = h.points;
  const last = pts.at(-1);
  if (!last) return null;
  const year = pts.slice(rangeStartIndex(pts.map(([date]) => date), '1A', today));
  const weeks = new Map<string, [string, number]>();
  for (const p of year) weeks.set(weekOf(p[0]), p);
  const first = year[0];
  return {
    symbol: h.symbol,
    name,
    date: last[0],
    close: last[1],
    prevClose: pts.at(-2)?.[1] ?? null,
    spark: [...weeks.values()],
    ret1y: first && first[1] ? last[1] / first[1] - 1 : null,
    checked,
    fetchedAt,
  };
}

/** Nombre de la empresa (Finnhub, si hay clave): se pide una sola vez por símbolo. */
async function nameOf(d: Deps, symbol: string, prev: EodRow | undefined): Promise<string | null> {
  if (prev?.name) return prev.name;
  if (symbol.includes('/') || !d.finnhubKey) return null;
  try {
    return parseProfile(await finnhubGet('/stock/profile2', { symbol }, d.finnhubKey, d.fetch))?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Renueva los símbolos de la lista diaria a los que les falta el último cierre (primero los que nunca se cargaron), hasta
 * `max` por vez. Uno por uno, porque el contador de créditos se lee y escribe en KV. Guarda el resumen una sola vez.
 * `onlyNew`: solo los que nunca se cargaron (al guardar la lista).
 */
export async function refreshEod(d: Deps, opts: { max?: number; onlyNew?: boolean } = {}): Promise<{ refreshed: string[]; errors: Record<string, string> }> {
  const out = { refreshed: [] as string[], errors: {} as Record<string, string> };
  const main = await getWatchlist(d.kv);
  const list = (await getEodList(d.kv)).filter((s) => !main.includes(s));
  const prev = await d.kv.get<EodSummary>('eod', 'json');
  const summary: EodSummary = prev ?? { rows: {} };
  const missing = list.filter((s) => !summary.rows[s]);
  const stale = opts.onlyNew ? [] : list.filter((s) => summary.rows[s] && summary.rows[s]!.checked < eodTarget(s, d.now));
  const due = [...missing, ...stale].slice(0, opts.max ?? EOD_PER_RUN);
  // Lo que ya no está en la lista se borra del resumen.
  const gone = Object.keys(summary.rows).filter((s) => !list.includes(s));
  if (!due.length && !gone.length) return out;
  for (const s of gone) delete summary.rows[s];

  const today = isoDate(d.now);
  for (const symbol of due) {
    const target = eodTarget(symbol, d.now);
    try {
      const h = await storedHistory(d, symbol, target);
      // Con el freno de créditos o un error se muestra lo guardado, pero queda para reintentar.
      const row = summarizeHistory(h.data, await nameOf(d, symbol, summary.rows[symbol]), h.stale ? '' : target, h.fetchedAt, today);
      if (row) summary.rows[symbol] = row;
      if (h.stale) out.errors[symbol] = h.note ?? 'no se pudo renovar';
      else out.refreshed.push(symbol);
    } catch (e) {
      out.errors[symbol] = e instanceof Error ? e.message : 'no respondió';
    }
  }
  await d.kv.put('eod', JSON.stringify(summary));
  return out;
}

export type EodViewRow =
  | { symbol: string; pending: true }
  | { symbol: string; pending: false; name: string | null; date: string; close: number; change: number | null; changePct: number | null; spark: [string, number][]; ret1y: number | null };

export interface EodView {
  symbols: string[];
  max: number;
  rows: EodViewRow[];
}

/** Lo que ve el panel: una fila por símbolo, en el orden de la lista («pendiente» si todavía no tiene cierre). */
export function shapeEod(symbols: string[], summary: EodSummary | null): EodView {
  return {
    symbols,
    max: EOD_MAX,
    rows: symbols.map((symbol): EodViewRow => {
      const r = summary?.rows[symbol];
      if (!r) return { symbol, pending: true };
      const change = r.prevClose ? r.close - r.prevClose : null;
      const changePct = change !== null && r.prevClose ? (change / r.prevClose) * 100 : null;
      return { symbol, pending: false, name: r.name, date: r.date, close: r.close, change, changePct, spark: r.spark, ret1y: r.ret1y };
    }),
  };
}

export async function eodView(kv: KVNamespace): Promise<EodView> {
  const main = await getWatchlist(kv);
  const symbols = (await getEodList(kv)).filter((s) => !main.includes(s));
  return shapeEod(symbols, await kv.get<EodSummary>('eod', 'json'));
}
