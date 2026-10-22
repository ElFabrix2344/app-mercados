// Datos de la empresa para la ficha (Finnhub, con la clave gratis del dueño; solo el dueño): perfil, múltiplos
// y rentabilidad, recomendación de analistas, sorpresas del BPA de los últimos trimestres y comparables.
// Se piden al abrir la ficha y se guardan 24 h por símbolo: a lo más una escritura por símbolo al día.

import {
  finnhubGet,
  parseMetrics,
  parsePeers,
  parseProfile,
  parseRecommendations,
  parseSurprises,
  type CompanyMetrics,
  type CompanyProfile,
  type EpsSurprise,
  type Recommendation,
} from '../lib/finnhub';
import { ApiError } from '../lib/http';
import { cached, isUsEquity, type Deps, type Fresh } from './market';

export const COMPANY_TTL_MS = 24 * 3_600_000;

export interface CompanyData {
  symbol: string;
  /** null si Finnhub no conoce la empresa (pasa con los ETF). */
  profile: CompanyProfile | null;
  metrics: CompanyMetrics | null;
  /** Del mes más nuevo al más viejo. */
  recommendations: Recommendation[];
  /** Del trimestre más nuevo al más viejo. */
  surprises: EpsSurprise[];
  peers: string[];
  /** Partes que fallaron en la última lectura (las demás se muestran igual). */
  errors: Record<string, string>;
}

export type CompanyResult =
  /** Sin FINNHUB_API_KEY: la función queda apagada (no es un error). */
  | { enabled: false; note: string }
  /** Divisas y cripto no tienen datos de empresa. */
  | { enabled: true; applicable: false; note: string }
  | ({ enabled: true; applicable: true } & Fresh<CompanyData>);

export const NO_KEY_NOTE = 'Falta la clave de Finnhub (FINNHUB_API_KEY): sin ella no hay datos de la empresa.';

/** Las cinco partes que se piden, con el nombre que se muestra si una falla. */
const PARTS = ['perfil', 'indicadores', 'analistas', 'sorpresas del BPA', 'comparables'] as const;

export async function companyData(d: Deps, symbol: string): Promise<CompanyResult> {
  const key = d.finnhubKey;
  if (!key) return { enabled: false, note: NO_KEY_NOTE };
  if (!isUsEquity(symbol)) return { enabled: true, applicable: false, note: 'Las divisas y las criptomonedas no tienen datos de empresa.' };
  const r = await cached<CompanyData>(d, `company:${symbol}`, COMPANY_TTL_MS, async () => {
    const get = (path: string, params: Record<string, string> = {}) => finnhubGet(path, { symbol, ...params }, key, d.fetch);
    // Cinco pedidos de los 60 por minuto del plan gratis.
    const results = await Promise.allSettled([
      get('/stock/profile2').then(parseProfile),
      get('/stock/metric', { metric: 'all' }).then(parseMetrics),
      get('/stock/recommendation').then((x) => parseRecommendations(x)),
      get('/stock/earnings', { limit: '4' }).then((x) => parseSurprises(x)),
      get('/stock/peers').then((x) => parsePeers(x, symbol)),
    ]);
    // Si fallan todas (clave mal puesta, Finnhub caído), mejor lo guardado antes que un registro vacío.
    if (results.every((x) => x.status === 'rejected')) {
      const first = (results[0] as PromiseRejectedResult).reason;
      throw first instanceof ApiError ? first : new ApiError('upstream_error', 502, 'Finnhub no respondió.', 'finnhub');
    }
    const errors: Record<string, string> = {};
    const value = <T>(i: number, fallback: T): T => {
      const x = results[i]!;
      if (x.status === 'fulfilled') return x.value as T;
      errors[PARTS[i]!] = x.reason instanceof Error ? x.reason.message : 'no respondió';
      return fallback;
    };
    return {
      symbol,
      profile: value<CompanyProfile | null>(0, null),
      metrics: value<CompanyMetrics | null>(1, null),
      recommendations: value<Recommendation[]>(2, []),
      surprises: value<EpsSurprise[]>(3, []),
      peers: value<string[]>(4, []),
      errors,
    };
  });
  return { enabled: true, applicable: true, ...r };
}
