import { describe, expect, it } from 'vitest';
import { parseMetrics, parsePeers, parseProfile, parseRecommendations, parseSurprises } from '../src/lib/finnhub';
import { ApiError } from '../src/lib/http';
import { COMPANY_TTL_MS, companyData } from '../src/services/company';
import type { Deps } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

const NOW = new Date('2026-10-22T15:00:00Z');

const PROFILE = {
  country: 'PE',
  currency: 'USD',
  exchange: 'NEW YORK STOCK EXCHANGE, INC.',
  ipo: '1995-10-25',
  marketCapitalization: 21486.3,
  name: 'Credicorp Ltd',
  shareOutstanding: 79.5,
  ticker: 'BAP',
  weburl: 'https://www.grupocredicorp.com/',
  finnhubIndustry: 'Banking',
};
const METRIC = {
  metric: { peTTM: 11.2, pbQuarterly: 1.9, beta: 1.05, currentDividendYieldTTM: 4.1, epsTTM: 24.13, netProfitMarginTTM: 28.4, roeTTM: 17.2, revenueGrowthTTMYoy: 8.1, '52WeekHigh': 250.4, '52WeekLow': 180.2, '52WeekHighDate': '2026-07-30' },
  series: { annual: { netMargin: [{ period: '2025-12-31', v: 0.27 }] } },
  metricType: 'all',
  symbol: 'BAP',
};
const RECS = [
  { buy: 6, hold: 3, period: '2026-09-01', sell: 1, strongBuy: 4, strongSell: 0, symbol: 'BAP' },
  { buy: 7, hold: 2, period: '2026-10-01', sell: 0, strongBuy: 5, strongSell: 0, symbol: 'BAP' },
];
const SURPRISES = [
  { actual: 6.12, estimate: 5.7, period: '2026-06-30', quarter: 2, surprise: 0.42, surprisePercent: 7.3684, symbol: 'BAP', year: 2026 },
  { actual: 5.5, estimate: 5.6, period: '2026-03-31', quarter: 1, surprise: -0.1, surprisePercent: -1.7857, symbol: 'BAP', year: 2026 },
];

/** Finnhub falso con las cinco rutas de datos de empresa. */
const finnhub = (over: Partial<Record<string, { status?: number; body: unknown }>> = {}) =>
  fakeFetch((url) => {
    const path = url.pathname.replace('/api/v1', '');
    const fixed = over[path];
    if (fixed) return fixed;
    const bodies: Record<string, unknown> = {
      '/stock/profile2': PROFILE,
      '/stock/metric': METRIC,
      '/stock/recommendation': RECS,
      '/stock/earnings': SURPRISES,
      '/stock/peers': ['BAP', 'IFS', 'bbva', 'IFS', 'no válido'],
    };
    return { body: bodies[path] ?? {} };
  });

/** `finnhubKey: null` = sin clave cargada. */
function deps(f?: typeof fetch, kvInit: Record<string, unknown> = {}, finnhubKey: string | null = 'clave') {
  const mem = memoryKV(kvInit);
  const d: Deps = { kv: mem.kv, now: NOW, fetch: f, finnhubKey: finnhubKey ?? undefined };
  return { d, mem };
}

describe('lectores de Finnhub para la empresa', () => {
  it('perfil: null si Finnhub no la conoce (ETF) y solo enlaces http(s)', () => {
    expect(parseProfile({})).toBeNull();
    const p = parseProfile({ ...PROFILE, weburl: 'javascript:alert(1)' })!;
    expect(p).toMatchObject({ name: 'Credicorp Ltd', industry: 'Banking', marketCap: 21486.3, currency: 'USD', weburl: null });
    expect(parseProfile(PROFILE)!.weburl).toBe('https://www.grupocredicorp.com/');
  });

  it('indicadores: toma el primer nombre que traiga un número y descarta las series', () => {
    const m = parseMetrics(METRIC)!;
    expect(m).toMatchObject({ pe: 11.2, pb: 1.9, beta: 1.05, dividendYield: 4.1, eps: 24.13, netMargin: 28.4, roe: 17.2, revenueGrowth: 8.1, high52: 250.4, high52Date: '2026-07-30', low52: 180.2, low52Date: null });
    // Nombres viejos de Finnhub.
    expect(parseMetrics({ metric: { peBasicExclExtraTTM: 9.5, dividendYieldIndicatedAnnual: 2 } })).toMatchObject({ pe: 9.5, dividendYield: 2, beta: null });
    expect(parseMetrics({ metric: {} })).toBeNull();
    expect(parseMetrics({})).toBeNull();
  });

  it('analistas y sorpresas: del más nuevo al más viejo', () => {
    expect(parseRecommendations(RECS).map((r) => r.period)).toEqual(['2026-10-01', '2026-09-01']);
    expect(parseRecommendations(RECS)[0]).toEqual({ period: '2026-10-01', strongBuy: 5, buy: 7, hold: 2, sell: 0, strongSell: 0 });
    expect(parseRecommendations({ error: 'x' })).toEqual([]);
    const s = parseSurprises(SURPRISES);
    expect(s.map((x) => x.period)).toEqual(['2026-06-30', '2026-03-31']);
    expect(s[0]).toEqual({ period: '2026-06-30', year: 2026, quarter: 2, actual: 6.12, estimate: 5.7, surprisePct: 7.3684 });
  });

  it('comparables: sin la propia, sin repetidos y solo tickers válidos', () => {
    expect(parsePeers(['BAP', 'IFS', 'bbva', 'IFS', 'no válido'], 'BAP')).toEqual(['IFS', 'BBVA']);
  });
});

describe('companyData', () => {
  it('sin clave queda apagado y no llama a nadie', async () => {
    const { f, calls } = finnhub();
    const r = await companyData(deps(f, {}, null).d, 'BAP');
    expect(r).toMatchObject({ enabled: false });
    expect(calls).toHaveLength(0);
  });

  it('las divisas y la cripto no tienen datos de empresa', async () => {
    const { f, calls } = finnhub();
    expect(await companyData(deps(f).d, 'USD/PEN')).toMatchObject({ enabled: true, applicable: false });
    expect(calls).toHaveLength(0);
  });

  it('pide las cinco partes con la clave y lo guarda 24 horas', async () => {
    const { f, calls } = finnhub();
    const { d, mem } = deps(f);
    const r = await companyData(d, 'BAP');
    expect(calls.map((u) => u.pathname.replace('/api/v1', '')).sort()).toEqual(['/stock/earnings', '/stock/metric', '/stock/peers', '/stock/profile2', '/stock/recommendation']);
    expect(calls.every((u) => u.searchParams.get('symbol') === 'BAP' && u.searchParams.get('token') === 'clave')).toBe(true);
    expect(calls.find((u) => u.pathname.endsWith('/metric'))!.searchParams.get('metric')).toBe('all');
    if (!r.enabled || !r.applicable) throw new Error('debía traer datos');
    expect(r.data.profile?.name).toBe('Credicorp Ltd');
    expect(r.data.metrics?.pe).toBe(11.2);
    expect(r.data.recommendations[0]?.period).toBe('2026-10-01');
    expect(r.data.surprises).toHaveLength(2);
    expect(r.data.peers).toEqual(['IFS', 'BBVA']);
    expect(r.data.errors).toEqual({});
    expect(mem.store.has('company:BAP')).toBe(true);

    // Dentro de las 24 horas sale de KV.
    await companyData({ ...d, now: new Date(NOW.getTime() + COMPANY_TTL_MS - 60_000) }, 'BAP');
    expect(calls).toHaveLength(5);
  });

  it('si falla una parte muestra las demás y dice cuál falló', async () => {
    const { f } = finnhub({ '/stock/recommendation': { status: 500, body: {} } });
    const r = await companyData(deps(f).d, 'BAP');
    if (!r.enabled || !r.applicable) throw new Error('debía traer datos');
    expect(r.data.recommendations).toEqual([]);
    expect(r.data.errors.analistas).toContain('HTTP 500');
    expect(r.data.metrics?.pe).toBe(11.2);
  });

  it('si fallan todas no guarda nada y avisa (con lo guardado antes, lo muestra)', async () => {
    const bad = { status: 401, body: { error: 'Invalid API key' } };
    const all = { '/stock/profile2': bad, '/stock/metric': bad, '/stock/recommendation': bad, '/stock/earnings': bad, '/stock/peers': bad };
    const { f } = finnhub(all);
    const { d, mem } = deps(f);
    const err = await companyData(d, 'BAP').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('FINNHUB_API_KEY');
    expect(mem.writes()).toBe(0);

    const stored = { fetchedAt: '2026-10-20T00:00:00.000Z', data: { symbol: 'BAP', profile: null, metrics: null, recommendations: [], surprises: [], peers: ['IFS'], errors: {} } };
    const r = await companyData(deps(f, { 'company:BAP': stored }).d, 'BAP');
    if (!r.enabled || !r.applicable) throw new Error('debía traer lo guardado');
    expect(r.stale).toBe(true);
    expect(r.data.peers).toEqual(['IFS']);
  });
});
