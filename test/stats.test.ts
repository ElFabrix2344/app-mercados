import { describe, expect, it } from 'vitest';
import { maxDrawdown, periodsPerYear, seriesStats } from '../src/lib/stats';

const pts = [
  { date: '2026-01-05', close: 100 },
  { date: '2026-01-06', close: 110 },
  { date: '2026-01-07', close: 99 },
  { date: '2026-01-08', close: 120 },
  { date: '2026-01-09', close: 90 },
  { date: '2026-01-12', close: 108 },
];

describe('seriesStats', () => {
  it('calcula rendimiento, extremos y peores/mejores días', () => {
    const s = seriesStats(pts)!;
    expect(s.totalReturn).toBeCloseTo(0.08, 10);
    expect(s.maxClose).toEqual({ date: '2026-01-08', value: 120 });
    expect(s.minClose).toEqual({ date: '2026-01-09', value: 90 });
    expect(s.worstDay!.date).toBe('2026-01-09');
    expect(s.worstDay!.ret).toBeCloseTo(-0.25, 10);
    expect(s.bestDay!.date).toBe('2026-01-08');
    expect(s.bestDay!.ret).toBeCloseTo(120 / 99 - 1, 10);
    expect(s.annualVol).toBeGreaterThan(0);
  });

  it('devuelve null con menos de dos puntos', () => {
    expect(seriesStats([{ date: '2026-01-05', close: 1 }])).toBeNull();
  });
});

describe('maxDrawdown', () => {
  it('mide la mayor caída desde un pico previo', () => {
    expect(maxDrawdown(pts)).toEqual({ value: 90 / 120 - 1, peakDate: '2026-01-08', troughDate: '2026-01-09' });
  });

  it('es null si la serie solo sube', () => {
    expect(maxDrawdown([{ date: 'a', close: 1 }, { date: 'b', close: 2 }])).toBeNull();
  });
});

describe('periodsPerYear', () => {
  it('≈365 para una serie diaria sin fines de semana libres (cripto)', () => {
    const daily = Array.from({ length: 366 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), close: 1 }));
    expect(periodsPerYear(daily)).toBeCloseTo(365.25, 0);
  });
});
