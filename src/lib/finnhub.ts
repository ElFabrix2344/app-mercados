// API de Finnhub (plan gratis con clave propia): https://finnhub.io/docs/api
// Del plan gratis se usan: calendario de resultados (fechas que vienen y 1 mes de historia), perfil, indicadores
// básicos, recomendación de analistas, sorpresas del BPA (últimos 4 trimestres) y comparables. Sus términos no
// permiten mostrar los datos a otras personas: en Rueda solo los ve el dueño.

import { ApiError } from './http';
import { num } from './num';

const BASE = 'https://finnhub.io/api/v1';

const errorText = (body: unknown) => {
  const e = (body as { error?: unknown })?.error;
  return typeof e === 'string' && e ? e : null;
};

/** GET a la API con los errores traducidos (la clave va como parámetro `token`, como pide su especificación). */
export async function finnhubGet(path: string, params: Record<string, string>, apiKey: string, f: typeof fetch = fetch): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
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
  return body;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoDay = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const desc = <T extends { period: string }>(a: T, b: T) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0);

// ---------- calendario de resultados ----------

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
  const body = await finnhubGet('/calendar/earnings', { from, to, symbol }, apiKey, f);
  // Solo las de ese símbolo, por si la API mezclara otras.
  return parseEarnings(body).filter((r) => r.symbol === symbol);
}

// ---------- datos de la empresa ----------

export interface CompanyProfile {
  name: string;
  country: string | null;
  /** Moneda en que reporta (y en la que va la capitalización). */
  currency: string | null;
  exchange: string | null;
  industry: string | null;
  ipo: string | null;
  weburl: string | null;
  /** En millones de `currency`. */
  marketCap: number | null;
  /** En millones de acciones. */
  sharesOutstanding: number | null;
}

/** Perfil de la empresa; null si Finnhub no la conoce (responde `{}`, como con los ETF). */
export function parseProfile(raw: unknown): CompanyProfile | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  const web = str(o.weburl);
  return {
    name,
    country: str(o.country),
    currency: str(o.currency),
    exchange: str(o.exchange),
    industry: str(o.finnhubIndustry),
    ipo: isoDay(o.ipo),
    // Solo enlaces http(s): el panel lo muestra como enlace.
    weburl: web && /^https?:\/\//i.test(web) ? web : null,
    marketCap: num(o.marketCapitalization),
    sharesOutstanding: num(o.shareOutstanding),
  };
}

/** Indicadores básicos. Los márgenes, el ROE, el dividendo y los crecimientos vienen en %. */
export interface CompanyMetrics {
  /** PER de los últimos 12 meses. */
  pe: number | null;
  /** Precio / valor contable. */
  pb: number | null;
  /** Precio / ventas. */
  ps: number | null;
  beta: number | null;
  dividendYield: number | null;
  /** BPA de los últimos 12 meses, en la moneda en que reporta la empresa. */
  eps: number | null;
  netMargin: number | null;
  operatingMargin: number | null;
  roe: number | null;
  /** Crecimiento de los ingresos y del BPA frente a un año antes. */
  revenueGrowth: number | null;
  epsGrowth: number | null;
  high52: number | null;
  high52Date: string | null;
  low52: number | null;
  low52Date: string | null;
  /** Rendimiento del precio en 26 y 52 semanas (%). */
  return26w: number | null;
  return52w: number | null;
}

/** El primero de los nombres que traiga un número: Finnhub cambió algunos nombres con los años. */
function pick(m: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = num(m[k]);
    if (v !== null) return v;
  }
  return null;
}

export function parseMetrics(raw: unknown): CompanyMetrics | null {
  const m = (raw as { metric?: unknown })?.metric;
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const out: CompanyMetrics = {
    pe: pick(r, ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peNormalizedAnnual']),
    pb: pick(r, ['pbQuarterly', 'pbAnnual', 'pb']),
    ps: pick(r, ['psTTM', 'psAnnual']),
    beta: pick(r, ['beta']),
    dividendYield: pick(r, ['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual']),
    eps: pick(r, ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsExclExtraItemsTTM']),
    netMargin: pick(r, ['netProfitMarginTTM', 'netProfitMarginAnnual']),
    operatingMargin: pick(r, ['operatingMarginTTM', 'operatingMarginAnnual']),
    roe: pick(r, ['roeTTM', 'roeRfy']),
    revenueGrowth: pick(r, ['revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy']),
    epsGrowth: pick(r, ['epsGrowthTTMYoy', 'epsGrowthQuarterlyYoy']),
    high52: pick(r, ['52WeekHigh']),
    high52Date: isoDay(r['52WeekHighDate']),
    low52: pick(r, ['52WeekLow']),
    low52Date: isoDay(r['52WeekLowDate']),
    return26w: pick(r, ['26WeekPriceReturnDaily']),
    return52w: pick(r, ['52WeekPriceReturnDaily']),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Recomendaciones de los analistas en un mes (cuántos dicen cada cosa). */
export interface Recommendation {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/** Del mes más nuevo al más viejo, hasta `max`. */
export function parseRecommendations(raw: unknown, max = 4): Recommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: Recommendation[] = [];
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const period = isoDay(o.period);
    if (!period) continue;
    const n = (v: unknown) => Math.max(0, Math.round(num(v) ?? 0));
    out.push({ period, strongBuy: n(o.strongBuy), buy: n(o.buy), hold: n(o.hold), sell: n(o.sell), strongSell: n(o.strongSell) });
  }
  return out.sort(desc).slice(0, max);
}

/** BPA real frente al esperado en un trimestre ya presentado. `surprisePct` viene en %. */
export interface EpsSurprise {
  period: string;
  year: number | null;
  quarter: number | null;
  actual: number | null;
  estimate: number | null;
  surprisePct: number | null;
}

/** Del trimestre más nuevo al más viejo, hasta `max` (el plan gratis da los últimos 4). */
export function parseSurprises(raw: unknown, max = 4): EpsSurprise[] {
  if (!Array.isArray(raw)) return [];
  const out: EpsSurprise[] = [];
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const period = isoDay(o.period);
    if (!period) continue;
    const quarter = num(o.quarter);
    out.push({
      period,
      year: num(o.year),
      quarter: quarter !== null && quarter >= 1 && quarter <= 4 ? quarter : null,
      actual: num(o.actual),
      estimate: num(o.estimate),
      surprisePct: num(o.surprisePercent),
    });
  }
  return out.sort(desc).slice(0, max);
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

/** Empresas comparables (misma subindustria según Finnhub), sin la propia y hasta `max`. */
export function parsePeers(raw: unknown, symbol: string, max = 8): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
    if (TICKER_RE.test(s) && s !== symbol && !out.includes(s)) out.push(s);
  }
  return out.slice(0, max);
}
