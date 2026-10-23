// API de FRED: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
// Los valores llegan como texto; los días sin dato se marcan con ".".

import { ApiError } from './http';
import { num } from './num';

const BASE = 'https://api.stlouisfed.org/fred/series/observations';

export const FRED_SERIES = {
  treasury10y: 'DGS10', // rendimiento del bono del Tesoro a 10 años (%, diario)
  fedFunds: 'DFF', // tasa efectiva de fondos federales (%, diario)
  cpi: 'CPIAUCSL', // IPC; con units=pc1 es la variación % frente a un año antes (mensual)
  fedTargetUpper: 'DFEDTARU', // rango objetivo de la Fed, límite superior (%, diario)
  fedTargetLower: 'DFEDTARL', // rango objetivo de la Fed, límite inferior (%, diario)
} as const;

/** Curva del Tesoro de EE. UU. (rendimientos a plazo constante, %, diarios): plazo → serie. */
export const FRED_CURVE: [tenor: string, series: string][] = [
  ['1M', 'DGS1MO'],
  ['3M', 'DGS3MO'],
  ['6M', 'DGS6MO'],
  ['1A', 'DGS1'],
  ['2A', 'DGS2'],
  ['3A', 'DGS3'],
  ['5A', 'DGS5'],
  ['7A', 'DGS7'],
  ['10A', 'DGS10'],
  ['20A', 'DGS20'],
  ['30A', 'DGS30'],
];

export interface FredPoint {
  date: string;
  value: number;
}

export function parseFred(raw: unknown): FredPoint[] {
  const obs = (raw as { observations?: unknown })?.observations;
  if (!Array.isArray(obs)) {
    const msg = (raw as { error_message?: unknown })?.error_message;
    throw new ApiError('bad_response', 502, `FRED: ${typeof msg === 'string' ? msg : 'respuesta sin observaciones'}`, 'fred');
  }
  const out: FredPoint[] = [];
  for (const o of obs) {
    const date = String((o as Record<string, unknown>)?.date ?? '');
    const value = num((o as Record<string, unknown>)?.value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) out.push({ date, value });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function getFred(
  seriesId: string,
  opts: { start: string; units?: 'lin' | 'pc1' },
  apiKey: string,
  f: typeof fetch = fetch,
): Promise<FredPoint[]> {
  const url = new URL(BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', opts.start);
  if (opts.units) url.searchParams.set('units', opts.units);
  let res: Response;
  try {
    res = await f(url.toString());
  } catch (e) {
    throw new ApiError('upstream_error', 502, `FRED no respondió: ${(e as Error).message}`, 'fred');
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'FRED: demasiadas solicitudes.', 'fred');
  if (!res.ok) {
    const msg = (body as { error_message?: unknown })?.error_message;
    throw new ApiError('upstream_error', 502, `FRED: ${typeof msg === 'string' ? msg : `HTTP ${res.status}`}`, 'fred');
  }
  return parseFred(body);
}
