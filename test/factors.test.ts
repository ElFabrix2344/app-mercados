import { describe, expect, it } from 'vitest';
import type { CompanyMetrics } from '../src/lib/finnhub';
import { factorGrades, gradeFactors, gradeOf } from '../src/services/factors';
import type { Deps } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

const blank: CompanyMetrics = {
  pe: null,
  pb: null,
  ps: null,
  beta: null,
  dividendYield: null,
  eps: null,
  netMargin: null,
  operatingMargin: null,
  roe: null,
  revenueGrowth: null,
  epsGrowth: null,
  high52: null,
  high52Date: null,
  low52: null,
  low52Date: null,
  return26w: null,
  return52w: null,
};
const m = (over: Partial<CompanyMetrics>): CompanyMetrics => ({ ...blank, ...over });

describe('gradeFactors', () => {
  it('percentil dentro del grupo: en valor, lo más barato es lo mejor; en el resto, lo más alto', () => {
    const own = m({ pe: 10, netMargin: 30, dividendYield: 2 });
    const peers = [m({ pe: 20, netMargin: 10 }), m({ pe: 15, netMargin: 20 }), m({ pe: 30, netMargin: 40 }), m({ pe: -5, netMargin: 5 })];
    const [value, , profit, momentum, dividend] = gradeFactors(own, peers);
    // PER: el más barato de los positivos (el −5 no cuenta: hay pérdidas).
    expect(value!.metrics[0]).toMatchObject({ value: 10, percentile: 1, n: 4, median: 20 });
    expect(value!.grade).toBe('A');
    // Margen neto: mejor que 3 de 4 comparables.
    expect(profit!.metrics[0]!.percentile).toBe(0.75);
    expect(profit!.grade).toBe('B');
    // Sin datos de impulso, ni dividendos de las comparables: no se califica.
    expect(momentum).toMatchObject({ grade: null, score: null });
    expect(dividend!.metrics[0]).toMatchObject({ value: 2, percentile: null, n: 1 });
  });

  it('las notas: A desde 80, B desde 60, C desde 40, D desde 20 y F por debajo', () => {
    expect([0.85, 0.6, 0.45, 0.2, 0.1].map(gradeOf)).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
});

describe('factorGrades', () => {
  it('pide los indicadores de cada comparable una vez y los guarda 24 h', async () => {
    const metric = (pe: number) => ({ metric: { peTTM: pe, netProfitMarginTTM: 20, '26WeekPriceReturnDaily': 5 } });
    const pes: Record<string, number> = { BAP: 9, IFS: 12, BBVA: 8, SAN: 10 };
    const { f, calls } = fakeFetch((url) => {
      const path = url.pathname.replace('/api/v1', '');
      const symbol = url.searchParams.get('symbol')!;
      if (path === '/stock/profile2') return { body: { name: 'Credicorp Ltd', finnhubIndustry: 'Banking', country: 'PE' } };
      if (path === '/stock/metric') return { body: metric(pes[symbol] ?? 10) };
      if (path === '/stock/peers') return { body: ['BAP', 'IFS', 'BBVA', 'SAN'] };
      return { body: [] };
    });
    const mem = memoryKV();
    const d: Deps = { kv: mem.kv, now: new Date('2026-10-23T15:00:00Z'), fetch: f, finnhubKey: 'clave' };
    const r = await factorGrades(d, 'BAP');
    if (!r.enabled || !r.applicable) throw new Error('debía traer notas');
    expect(r.data.peers).toEqual(['IFS', 'BBVA', 'SAN']);
    // PER 9 frente a 12, 8 y 10: más barato que 2 de 3.
    expect(r.data.factors[0]!.metrics[0]!.percentile).toBeCloseTo(2 / 3, 9);
    const metricCalls = () => calls.filter((u) => u.pathname.endsWith('/stock/metric')).length;
    expect(metricCalls()).toBe(4); // la propia (datos de la empresa) y las 3 comparables
    await factorGrades(d, 'BAP');
    expect(metricCalls()).toBe(4);
  });

  it('sin clave de Finnhub queda apagado', async () => {
    const r = await factorGrades({ kv: memoryKV().kv, now: new Date() }, 'BAP');
    expect(r.enabled).toBe(false);
  });
});
