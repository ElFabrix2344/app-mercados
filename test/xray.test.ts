import { describe, expect, it } from 'vitest';
import type { PortfolioView, PriceSource } from '../src/services/portfolio';
import { portfolioXray, type ProfileOf } from '../src/services/xray';

const NOW = new Date('2026-10-23T15:00:00Z');

/** Cierres diarios desde hace 300 días que suben y bajan `step` (en fracción) día por medio. */
function series(step: number): [string, number][] {
  let price = 100;
  return Array.from({ length: 300 }, (_, i) => {
    const date = new Date(NOW.getTime() - (300 - i) * 86_400_000).toISOString().slice(0, 10);
    if (i) price *= i % 2 ? 1 + step : 1 - step;
    return [date, price] as [string, number];
  });
}

const view = {
  positions: [
    { symbol: 'AAA', value: 600 },
    { symbol: 'BBB', value: 400 },
    { symbol: 'BTC/USD', value: null },
  ],
} as unknown as PortfolioView;

const src: PriceSource = {
  quotes: async () => null,
  closes: async (symbol) => ({ AAA: series(0.01), BBB: series(0.02), SPY: series(0.01) })[symbol as 'AAA'] ?? null,
  usdPen: async () => ({ rate: 3.7, source: 'prueba' }),
};

const profileOf: ProfileOf = async (symbol) => (symbol === 'AAA' ? { industry: 'Banking', country: 'PE' } : 'etf');

describe('portfolioXray', () => {
  it('composición, concentración y riesgo con los pesos de hoy', async () => {
    const x = await portfolioXray(view, src, profileOf, NOW);
    expect(x.total).toBe(1000);
    expect(x.positions.map((p) => [p.symbol, p.weight, p.kind, p.sector, p.country])).toEqual([
      ['AAA', 0.6, 'stock', 'Banking', 'PE'],
      ['BBB', 0.4, 'etf', 'ETF o fondo (varios)', null],
    ]);
    expect(x.byCountry).toEqual([
      { name: 'PE', weight: 0.6 },
      { name: 'Varios', weight: 0.4 },
    ]);
    expect(x.concentration.largest).toEqual({ symbol: 'AAA', weight: 0.6 });
    expect(x.concentration.top3).toBe(1);
    expect(x.concentration.effective).toBeCloseTo(1 / (0.36 + 0.16), 9);
    expect(x.notes[0]).toContain('Sin precio para BTC/USD');
    // La cartera rinde 0,6·r + 0,4·2r = 1,4·r, y el SPY rinde r: beta 1,4 y las dos posiciones van juntas.
    expect(x.risk!.beta).toBeCloseTo(1.4, 6);
    expect(x.risk!.correlation.symbols).toEqual(['AAA', 'BBB']);
    expect(x.risk!.correlation.matrix[0]![1]).toBeCloseTo(1, 9);
    expect(x.risk!.maxDrawdown).toBeLessThan(0);
    expect(x.risk!.volatility).toBeGreaterThan(0);
  });

  it('sin perfil (sin clave de Finnhub) la acción queda como acción, con sector «Sin datos»', async () => {
    const x = await portfolioXray(view, src, async () => null, NOW);
    expect(x.positions.map((p) => [p.symbol, p.kind, p.sector])).toEqual([
      ['AAA', 'stock', 'Sin datos'],
      ['BBB', 'stock', 'Sin datos'],
    ]);
  });

  it('sin posiciones con precio no hay nada que mirar', async () => {
    const x = await portfolioXray({ positions: [] } as unknown as PortfolioView, src, profileOf, NOW);
    expect(x).toMatchObject({ total: 0, positions: [], risk: null });
  });
});
