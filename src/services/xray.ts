// Rayos X de la cartera simulada: de qué está hecha (posición, sector, país y tipo) y cuánto riesgo tiene con los
// pesos de hoy (volatilidad, beta frente al SPY, peor caída del último año y correlaciones). Usa solo lo guardado:
// los precios de la cartera, los historiales de 5 años (sin pedir nuevos: no gasta créditos) y el perfil de Finnhub.

import { alignByDate, pearson, returnsOf } from '../lib/indicators';
import { addDays, isoDate } from '../lib/num';
import type { PortfolioView, PriceSource } from './portfolio';

export type HoldingKind = 'stock' | 'etf' | 'crypto';

/**
 * Sector y país de una empresa según Finnhub; «etf» si Finnhub no la conoce como empresa (ETF o fondo); null si no se
 * sabe (sin clave de Finnhub o si falló).
 */
export type ProfileOf = (symbol: string) => Promise<{ industry: string | null; country: string | null } | 'etf' | null>;

export interface XrayView {
  /** Valor de las posiciones abiertas (US$). */
  total: number;
  positions: { symbol: string; value: number; weight: number; kind: HoldingKind; sector: string; country: string | null }[];
  bySector: { name: string; weight: number }[];
  /** Código de país (PE, US…) o «Varios» para ETF y cripto. */
  byCountry: { name: string; weight: number }[];
  concentration: {
    largest: { symbol: string; weight: number } | null;
    top3: number;
    /** Cuántas posiciones parejas equivaldrían a esta cartera: 1 / Σ peso². */
    effective: number;
  };
  /** Con los pesos de hoy, sobre el último año (solo los días en que todas cotizan). */
  risk: {
    from: string;
    to: string;
    days: number;
    volatility: number | null;
    beta: number | null;
    maxDrawdown: number;
    correlation: { symbols: string[]; matrix: (number | null)[][] };
  } | null;
  notes: string[];
}

const BENCHMARK = 'SPY';

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function covariance(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - ma) * (b[i]! - mb);
  return s / (n - 1);
}

/** Pesos agrupados, de mayor a menor. */
function group(items: { name: string; weight: number }[]): { name: string; weight: number }[] {
  const by = new Map<string, number>();
  for (const it of items) by.set(it.name, (by.get(it.name) ?? 0) + it.weight);
  return [...by.entries()].map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
}

export async function portfolioXray(view: PortfolioView, src: PriceSource, profileOf: ProfileOf, now: Date): Promise<XrayView> {
  const notes: string[] = [];
  const open = view.positions.filter((p) => p.value !== null && p.value > 0);
  const missing = view.positions.filter((p) => p.value === null).map((p) => p.symbol);
  if (missing.length) notes.push(`Sin precio para ${missing.join(', ')}: quedan fuera.`);
  const total = open.reduce((a, p) => a + p.value!, 0);
  if (!total) return { total: 0, positions: [], bySector: [], byCountry: [], concentration: { largest: null, top3: 0, effective: 0 }, risk: null, notes };

  const positions = await Promise.all(
    open.map(async (p) => {
      const crypto = p.symbol.includes('/');
      const prof = crypto ? null : await profileOf(p.symbol).catch(() => null);
      const kind: HoldingKind = crypto ? 'crypto' : prof === 'etf' ? 'etf' : 'stock';
      const info = prof && prof !== 'etf' ? prof : null;
      return {
        symbol: p.symbol,
        value: p.value!,
        weight: p.value! / total,
        kind,
        sector: kind === 'crypto' ? 'Cripto' : kind === 'etf' ? 'ETF o fondo (varios)' : info?.industry ?? 'Sin datos',
        country: kind === 'stock' ? info?.country ?? null : null,
      };
    }),
  );
  positions.sort((a, b) => b.weight - a.weight);
  const bySector = group(positions.map((p) => ({ name: p.sector, weight: p.weight })));
  const byCountry = group(positions.map((p) => ({ name: p.country ?? 'Varios', weight: p.weight })));
  const concentration = {
    largest: positions[0] ? { symbol: positions[0].symbol, weight: positions[0].weight } : null,
    top3: positions.slice(0, 3).reduce((a, p) => a + p.weight, 0),
    effective: 1 / positions.reduce((a, p) => a + p.weight ** 2, 0),
  };

  // Riesgo del último año con los pesos de hoy: solo con lo guardado, sin pedir historiales nuevos.
  const since = addDays(isoDate(now), -366);
  const series: [string, number][][] = [];
  const used: typeof positions = [];
  for (const p of positions) {
    const closes = (await src.closes(p.symbol, false))?.filter(([d]) => d >= since) ?? [];
    if (closes.length > 20) {
      series.push(closes);
      used.push(p);
    } else notes.push(`Sin historial guardado de ${p.symbol}: no entra al cálculo de riesgo.`);
  }
  let risk: XrayView['risk'] = null;
  if (used.length) {
    const bench = (await src.closes(BENCHMARK, false))?.filter(([d]) => d >= since) ?? [];
    const withBench = bench.length > 20;
    const { dates, values } = alignByDate(withBench ? [...series, bench] : series);
    if (dates.length > 20) {
      const rets = values.map(returnsOf);
      const usedWeight = used.reduce((a, p) => a + p.weight, 0);
      const port = rets[0]!.map((_, t) => used.reduce((a, p, i) => a + (p.weight / usedWeight) * rets[i]![t]!, 0));
      const sd = stdev(port);
      const benchRets = withBench ? rets[used.length]! : null;
      const varB = benchRets ? stdev(benchRets) : null;
      const cov = benchRets ? covariance(port, benchRets) : null;
      // Peor caída del índice de la cartera.
      let idx = 1;
      let peak = 1;
      let worst = 0;
      for (const r of port) {
        idx *= 1 + r;
        peak = Math.max(peak, idx);
        worst = Math.min(worst, idx / peak - 1);
      }
      risk = {
        from: dates[0]!,
        to: dates.at(-1)!,
        days: port.length,
        volatility: sd === null ? null : sd * Math.sqrt(252),
        beta: cov !== null && varB ? cov / varB ** 2 : null,
        maxDrawdown: worst,
        correlation: {
          symbols: used.map((p) => p.symbol),
          matrix: used.map((_, i) => used.map((__, j) => (i === j ? 1 : pearson(rets[i]!, rets[j]!)))),
        },
      };
      if (!withBench) notes.push('Sin historial guardado del SPY: no hay beta.');
    }
  }
  return { total, positions, bySector, byCountry, concentration, risk, notes };
}
