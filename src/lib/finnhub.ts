// API de Finnhub (plan gratis con clave propia): https://finnhub.io/docs/api/earnings-calendar
// El plan gratis da las próximas fechas de resultados y 1 mes de historia. Sus términos no permiten mostrar
// los datos a otras personas: en Rueda solo los ve el dueño.

import { ApiError } from './http';
import { num } from './num';

const BASE = 'https://finnhub.io/api/v1';

/** Antes de la apertura (bmo), después del cierre (amc) o durante la sesión (dmh) de la bolsa. */
export type EarningsHour = 'bmo' | 'amc' | 'dmh';
const HOURS: readonly string[] = ['bmo', 'amc', 'dmh'];

/**
 * Una presentación de resultados trimestrales. El BPA (beneficio por acción) y los ingresos son ajustados
 * (no GAAP), en la moneda en que reporta la empresa; las estimaciones son el consenso de analistas.
 */
export interface EarningsRelease {
  symbol: string;
  date: string;
  hour: EarningsHour | null;
  /** Año y trimestre fiscales de la empresa (no siempre coinciden con el calendario). */
  year: number | null;
  quarter: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
}

const errorText = (body: unknown) => {
  const e = (body as { error?: unknown })?.error;
  return typeof e === 'string' && e ? e : null;
};

const byDate = (a: EarningsRelease, b: EarningsRelease) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function parseEarnings(raw: unknown): EarningsRelease[] {
  const list = (raw as { earningsCalendar?: unknown })?.earningsCalendar;
  if (!Array.isArray(list)) {
    throw new ApiError('bad_response', 502, `Finnhub: ${errorText(raw) ?? 'respuesta sin calendario de resultados'}`, 'finnhub');
  }
  const out: EarningsRelease[] = [];
  for (const it of list) {
    const o = (it ?? {}) as Record<string, unknown>;
    const symbol = typeof o.symbol === 'string' ? o.symbol.trim().toUpperCase() : '';
    const date = String(o.date ?? '');
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const quarter = num(o.quarter);
    out.push({
      symbol,
      date,
      hour: typeof o.hour === 'string' && HOURS.includes(o.hour) ? (o.hour as EarningsHour) : null,
      year: num(o.year),
      quarter: quarter !== null && quarter >= 1 && quarter <= 4 ? quarter : null,
      epsEstimate: num(o.epsEstimate),
      epsActual: num(o.epsActual),
      revenueEstimate: num(o.revenueEstimate),
      revenueActual: num(o.revenueActual),
    });
  }
  return out.sort(byDate);
}

/** Resultados de un símbolo entre dos fechas (YYYY-MM-DD, ambas incluidas). */
export async function getEarnings(symbol: string, from: string, to: string, apiKey: string, f: typeof fetch = fetch): Promise<EarningsRelease[]> {
  const url = new URL(`${BASE}/calendar/earnings`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', apiKey);
  let res: Response;
  try {
    res = await f(url.toString());
  } catch (e) {
    throw new ApiError('upstream_error', 502, `Finnhub no respondió: ${(e as Error).message}`, 'finnhub');
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'Finnhub: demasiadas solicitudes por minuto.', 'finnhub');
  if (res.status === 401) throw new ApiError('upstream_error', 502, 'Finnhub no aceptó la clave: revisa FINNHUB_API_KEY.', 'finnhub');
  if (!res.ok) throw new ApiError('upstream_error', 502, `Finnhub: ${errorText(body) ?? `HTTP ${res.status}`}`, 'finnhub');
  // Solo las de ese símbolo, por si la API mezclara otras.
  return parseEarnings(body).filter((r) => r.symbol === symbol);
}
