// Notas por factores (A–F) de una acción frente a sus comparables de Finnhub, al estilo de las calificaciones de las
// apps de pago: valor, crecimiento, rentabilidad, impulso y dividendo. Cada indicador da un percentil dentro del grupo
// (la empresa y sus comparables); la nota del factor es el promedio de sus percentiles. Solo el dueño (Finnhub).
// Los indicadores de las comparables se guardan 24 h en un solo registro por símbolo (`factors:<símbolo>`).

import { finnhubGet, parseMetrics, type CompanyMetrics } from '../lib/finnhub';
import { ApiError } from '../lib/http';
import { companyData } from './company';
import { cached, type Deps, type Fresh } from './market';

export const FACTORS_TTL_MS = 24 * 3_600_000;
/** Con menos empresas con dato que esto, un indicador no se califica (el percentil no diría nada). */
const MIN_GROUP = 3;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type FactorKey = 'value' | 'growth' | 'profit' | 'momentum' | 'dividend';

interface MetricDef {
  key: keyof CompanyMetrics;
  label: string;
  /** Mejor más alto o más bajo (los múltiplos de valor: más bajo es más barato). */
  better: 'higher' | 'lower';
  /** Solo valores positivos (un PER negativo no es «barato»: hay pérdidas). */
  positive?: boolean;
}

export const FACTORS: { key: FactorKey; label: string; metrics: MetricDef[] }[] = [
  {
    key: 'value',
    label: 'Valor',
    metrics: [
      { key: 'pe', label: 'PER (12 meses)', better: 'lower', positive: true },
      { key: 'pb', label: 'Precio / valor contable', better: 'lower', positive: true },
      { key: 'ps', label: 'Precio / ventas', better: 'lower', positive: true },
    ],
  },
  {
    key: 'growth',
    label: 'Crecimiento',
    metrics: [
      { key: 'revenueGrowth', label: 'Crecimiento de ingresos (%)', better: 'higher' },
      { key: 'epsGrowth', label: 'Crecimiento del BPA (%)', better: 'higher' },
    ],
  },
  {
    key: 'profit',
    label: 'Rentabilidad',
    metrics: [
      { key: 'netMargin', label: 'Margen neto (%)', better: 'higher' },
      { key: 'operatingMargin', label: 'Margen operativo (%)', better: 'higher' },
      { key: 'roe', label: 'ROE (%)', better: 'higher' },
    ],
  },
  {
    key: 'momentum',
    label: 'Impulso',
    metrics: [
      { key: 'return26w', label: 'Rendimiento 26 semanas (%)', better: 'higher' },
      { key: 'return52w', label: 'Rendimiento 52 semanas (%)', better: 'higher' },
    ],
  },
  {
    key: 'dividend',
    label: 'Dividendo',
    metrics: [{ key: 'dividendYield', label: 'Rendimiento por dividendo (%)', better: 'higher', positive: true }],
  },
];

export interface MetricScore {
  label: string;
  value: number | null;
  /** Mediana de las comparables con dato. */
  median: number | null;
  /** Percentil de la empresa en el grupo (0 = peor, 1 = mejor); null si no se puede calificar. */
  percentile: number | null;
  better: 'higher' | 'lower';
  /** Cuántas empresas del grupo tienen el dato (contando la propia). */
  n: number;
}

export interface FactorScore {
  key: FactorKey;
  label: string;
  grade: Grade | null;
  score: number | null;
  metrics: MetricScore[];
}

export const gradeOf = (score: number): Grade => (score >= 0.8 ? 'A' : score >= 0.6 ? 'B' : score >= 0.4 ? 'C' : score >= 0.2 ? 'D' : 'F');

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Notas de la empresa frente a las comparables. Pura: recibe los indicadores ya leídos. */
export function gradeFactors(own: CompanyMetrics, peers: (CompanyMetrics | null)[]): FactorScore[] {
  return FACTORS.map((f) => {
    const metrics = f.metrics.map((m): MetricScore => {
      const ok = (v: number | null): v is number => v !== null && Number.isFinite(v) && (!m.positive || v > 0);
      const mine = own[m.key] as number | null;
      const others = peers.map((p) => (p ? (p[m.key] as number | null) : null)).filter(ok);
      const n = others.length + (ok(mine) ? 1 : 0);
      let percentile: number | null = null;
      if (ok(mine) && n >= MIN_GROUP) {
        const worse = others.filter((v) => (m.better === 'higher' ? v < mine : v > mine)).length;
        const ties = others.filter((v) => v === mine).length;
        percentile = (worse + ties / 2) / others.length;
      }
      return { label: m.label, value: ok(mine) ? mine : null, median: median(others), percentile, better: m.better, n };
    });
    const scored = metrics.filter((m) => m.percentile !== null);
    const score = scored.length ? scored.reduce((a, m) => a + m.percentile!, 0) / scored.length : null;
    return { key: f.key, label: f.label, grade: score === null ? null : gradeOf(score), score, metrics };
  });
}

export interface FactorsData {
  symbol: string;
  /** Comparables que tenían indicadores. */
  peers: string[];
  factors: FactorScore[];
}

export type FactorsResult =
  | { enabled: false; note: string }
  | { enabled: true; applicable: false; note: string }
  | ({ enabled: true; applicable: true } & Fresh<FactorsData>);

/** Notas por factores de un símbolo: sus indicadores (de los datos de la empresa) y los de sus comparables (24 h). */
export async function factorGrades(d: Deps, symbol: string): Promise<FactorsResult> {
  const company = await companyData(d, symbol);
  if (!company.enabled || !company.applicable) return company;
  const own = company.data.metrics;
  const peerList = company.data.peers;
  if (!own || !peerList.length) {
    return { enabled: true, applicable: false, note: 'Finnhub no tiene indicadores o comparables de esta empresa (pasa con los ETF).' };
  }
  const key = d.finnhubKey!;
  const peers = await cached<Record<string, CompanyMetrics | null>>(d, `factors:${symbol}`, FACTORS_TTL_MS, async () => {
    // Un pedido por comparable (hasta 8) de los 60 por minuto del plan gratis.
    const results = await Promise.allSettled(peerList.map((p) => finnhubGet('/stock/metric', { symbol: p, metric: 'all' }, key, d.fetch).then(parseMetrics)));
    if (results.every((r) => r.status === 'rejected')) {
      const first = (results[0] as PromiseRejectedResult).reason;
      throw first instanceof ApiError ? first : new ApiError('upstream_error', 502, 'Finnhub no respondió.', 'finnhub');
    }
    return Object.fromEntries(peerList.map((p, i) => [p, results[i]!.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<CompanyMetrics | null>).value : null]));
  });
  const used = Object.entries(peers.data).filter(([, m]) => m !== null);
  return {
    enabled: true,
    applicable: true,
    ...peers,
    data: { symbol, peers: used.map(([p]) => p), factors: gradeFactors(own, used.map(([, m]) => m)) },
  };
}
