// CoinGecko, API Demo (gratis con clave: COINGECKO_API_KEY). La clave va en el encabezado `x-cg-demo-api-key`, nunca
// en la dirección (lo recomienda su documentación). Plan Demo: 100 consultas por minuto y un cupo mensual. Su guía de
// atribución pide citar la fuente cerca de los datos, con enlace a coingecko.com.

import { ApiError } from './http';

const BASE = 'https://api.coingecko.com/api/v3';

async function call(path: string, params: Record<string, string>, key: string, f: typeof fetch): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await f(url.toString(), { headers: { 'x-cg-demo-api-key': key, Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `CoinGecko no respondió: ${(e as Error).message}`, 'coingecko');
  }
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'CoinGecko pidió esperar (límite de consultas).', 'coingecko');
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('not_configured', 502, 'CoinGecko rechazó la clave. Revisa COINGECKO_API_KEY.', 'coingecko');
  }
  if (!res.ok) throw new ApiError('upstream_error', 502, `CoinGecko: HTTP ${res.status}`, 'coingecko');
  const body: unknown = await res.json().catch(() => null);
  if (body == null) throw new ApiError('bad_response', 502, 'CoinGecko: respuesta vacía.', 'coingecko');
  return body;
}

const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number) => Math.round(v * 1e4) / 1e4;

export interface CoinQuote {
  id: string;
  symbol: string;
  name: string;
  price: number;
  /** Variación de las últimas 24 horas (fracción). */
  change24h: number | null;
  marketCap: number | null;
  rank: number | null;
  updated: string | null;
}

/** Precio de ahora de varias monedas (1 consulta). */
export async function getCoinMarkets(ids: string[], key: string, f: typeof fetch = fetch): Promise<CoinQuote[]> {
  const body = await call('/coins/markets', { vs_currency: 'usd', ids: ids.join(','), price_change_percentage: '24h' }, key, f);
  if (!Array.isArray(body)) throw new ApiError('bad_response', 502, 'CoinGecko: lista de monedas inesperada.', 'coingecko');
  const out: CoinQuote[] = [];
  for (const raw of body) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const price = numOr(r.current_price);
    if (typeof r.id !== 'string' || price === null) continue;
    const ch = numOr(r.price_change_percentage_24h);
    out.push({
      id: r.id,
      symbol: String(r.symbol ?? '').toUpperCase(),
      name: String(r.name ?? r.id),
      price: round(price),
      change24h: ch === null ? null : Math.round(ch * 100) / 1e4,
      marketCap: numOr(r.market_cap),
      rank: numOr(r.market_cap_rank),
      updated: typeof r.last_updated === 'string' ? r.last_updated : null,
    });
  }
  return out;
}

/** Precio diario en US$ de los últimos `days` días: un punto por día (UTC), del más viejo al más nuevo (1 consulta). */
export async function getCoinDaily(id: string, days: number, key: string, f: typeof fetch = fetch): Promise<[string, number][]> {
  const body = await call(`/coins/${encodeURIComponent(id)}/market_chart`, { vs_currency: 'usd', days: String(days) }, key, f);
  const prices = (body as { prices?: unknown }).prices;
  if (!Array.isArray(prices)) throw new ApiError('bad_response', 502, `CoinGecko (${id}): serie sin precios.`, 'coingecko');
  // Con más de 90 días la serie viene por día; el último punto es el de ahora (puede caer el mismo día que el anterior).
  const byDay = new Map<string, number>();
  for (const p of prices) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[1])) {
      byDay.set(new Date(p[0]).toISOString().slice(0, 10), round(p[1]));
    }
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
