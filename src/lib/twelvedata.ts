// Cliente mínimo de la API REST de Twelve Data (https://twelvedata.com/docs).
// Cada símbolo cuesta 1 crédito en /quote y en /time_series; el plan gratis da 8/min y 800/día.

import { ApiError } from './http';
import { num } from './num';

const BASE = 'https://api.twelvedata.com';

export interface Quote {
  symbol: string;
  name: string;
  exchange: string;
  currency: string | null;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** Hora del último precio (ISO). */
  asOf: string | null;
  isMarketOpen: boolean | null;
  low52: number | null;
  high52: number | null;
}

export type QuoteBatch = { quotes: Quote[]; errors: Record<string, string> };

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

type Fetch = typeof fetch;

async function call(path: string, params: Record<string, string>, apiKey: string, f: Fetch): Promise<unknown> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await f(url.toString(), { headers: { Authorization: `apikey ${apiKey}` } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `Twelve Data no respondió: ${(e as Error).message}`, 'twelvedata');
  }
  const body: unknown = await res.json().catch(() => null);
  const err = asError(body);
  // Errores globales (afectan a todos los símbolos). Un error de un solo símbolo
  // (p. ej. «symbol not found») lo decide quien llama.
  if (res.status === 429 || err?.code === 429) {
    throw new ApiError('rate_limited', 429, 'Twelve Data: se alcanzó el límite de créditos por minuto.', 'twelvedata');
  }
  if (res.status === 401 || err?.code === 401) {
    throw new ApiError('not_configured', 502, 'Twelve Data rechazó la clave (401). Revisa TWELVE_DATA_API_KEY.', 'twelvedata');
  }
  if (!res.ok) {
    throw new ApiError('upstream_error', 502, `Twelve Data: ${err?.message ?? `HTTP ${res.status}`}`, 'twelvedata');
  }
  return body;
}

function asError(body: unknown): { code: number; message: string } | null {
  if (body && typeof body === 'object' && (body as Record<string, unknown>).status === 'error') {
    const b = body as Record<string, unknown>;
    return { code: Number(b.code) || 0, message: String(b.message ?? 'error') };
  }
  return null;
}

export function parseQuote(raw: unknown, requested: string): Quote | string {
  if (!raw || typeof raw !== 'object') return 'respuesta vacía';
  const err = asError(raw);
  if (err) return err.message;
  const r = raw as Record<string, unknown>;
  const price = num(r.close);
  if (price === null) return 'sin precio';
  const ts = num(r.last_quote_at) ?? num(r.timestamp);
  const ftw = (r.fifty_two_week ?? {}) as Record<string, unknown>;
  return {
    symbol: typeof r.symbol === 'string' ? r.symbol : requested,
    name: typeof r.name === 'string' ? r.name : requested,
    exchange: typeof r.exchange === 'string' ? r.exchange : '',
    currency: typeof r.currency === 'string' ? r.currency : null,
    price,
    prevClose: num(r.previous_close),
    change: num(r.change),
    changePct: num(r.percent_change),
    asOf: ts ? new Date(ts * 1000).toISOString() : null,
    isMarketOpen: typeof r.is_market_open === 'boolean' ? r.is_market_open : null,
    low52: num(ftw.low),
    high52: num(ftw.high),
  };
}

export async function getQuotes(symbols: string[], apiKey: string, f: Fetch = fetch): Promise<QuoteBatch> {
  const out: QuoteBatch = { quotes: [], errors: {} };
  if (!symbols.length) return out;
  const body = await call('/quote', { symbol: symbols.join(',') }, apiKey, f);
  // Con varios símbolos la respuesta es {SIMBOLO: respuesta}; con uno, la respuesta directa.
  const bySymbol: Record<string, unknown> =
    symbols.length === 1 ? { [symbols[0]!]: body } : ((body ?? {}) as Record<string, unknown>);
  for (const s of symbols) {
    const q = parseQuote(bySymbol[s], s);
    if (typeof q === 'string') out.errors[s] = q;
    else out.quotes.push(q);
  }
  return out;
}

export function parseSeries(raw: unknown): DailyPoint[] {
  const values = (raw as { values?: unknown })?.values;
  if (!Array.isArray(values)) throw new ApiError('bad_response', 502, 'Twelve Data: serie sin valores.', 'twelvedata');
  const pts: DailyPoint[] = [];
  for (const v of values) {
    const date = String((v as Record<string, unknown>)?.datetime ?? '').slice(0, 10);
    const close = num((v as Record<string, unknown>)?.close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && close !== null) pts.push({ date, close });
  }
  // La API devuelve de más reciente a más antiguo: se ordena ascendente.
  return pts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Cierres diarios entre dos fechas (YYYY-MM-DD, ambas incluidas en lo posible). */
export async function getDailySeries(symbol: string, start: string, end: string, apiKey: string, f: Fetch = fetch): Promise<DailyPoint[]> {
  const body = await call('/time_series', { symbol, interval: '1day', start_date: start, end_date: end, outputsize: '5000' }, apiKey, f);
  const err = asError(body);
  if (err) throw new ApiError('upstream_error', 502, `Twelve Data (${symbol}): ${err.message}`, 'twelvedata');
  return parseSeries(body);
}
