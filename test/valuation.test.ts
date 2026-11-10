import { describe, expect, it } from 'vitest';
import type { FinancialsData } from '../src/services/financials';
import { isPsRow, median, priceAtPs, psHistory, psRow } from '../src/services/valuation';

/** Una empresa inventada: ventas de 2023 a 2025 y sus acciones. */
const fin = (o: Partial<FinancialsData> = {}): FinancialsData => ({
  symbol: 'XYZ',
  cik: 1,
  name: 'XYZ Corp',
  standard: 'us-gaap',
  currency: 'USD',
  years: [
    { year: 2023, end: '2023-12-31', revenue: 800e6, operatingIncome: null, netIncome: null },
    { year: 2024, end: '2024-12-31', revenue: 900e6, operatingIncome: null, netIncome: null },
    { year: 2025, end: '2025-12-31', revenue: 1_000e6, operatingIncome: null, netIncome: null },
  ],
  shares: [
    { date: '2024-02-15', value: 110e6 },
    { date: '2025-02-15', value: 105e6 },
    { date: '2026-02-15', value: 100e6 },
  ],
  foreign: false,
  adrRatio: 1,
  quarters: [],
  ttm: null,
  ttmPrev: null,
  ...o,
});

describe('P/S (precio / ventas)', () => {
  it('capitalización ÷ ventas del último año fiscal, y el precio al que tendría otro P/S', () => {
    const r = psRow(fin(), 30, null);
    if (!isPsRow(r)) throw new Error(r.error);
    expect(r).toMatchObject({ year: 2025, revenueUsd: 1_000e6, shares: 100e6, marketCapUsd: 3_000e6, ps: 3 });
    expect(priceAtPs(r, 2)).toBe(20);
  });

  it('en soles se pasa a dólares; en un ADR, la capitalización va entre las acciones por ADR', () => {
    const pen = psRow(fin({ currency: 'PEN' }), 30, 3.75);
    if (!isPsRow(pen)) throw new Error(pen.error);
    expect(pen.revenueUsd).toBe(Math.round(1_000e6 / 3.75));
    expect(pen.ps).toBeCloseTo(3_000e6 / (1_000e6 / 3.75), 2);
    expect(psRow(fin({ currency: 'PEN' }), 30, null)).toMatchObject({ error: expect.stringContaining('tipo de cambio') });
    const adr = psRow(fin({ adrRatio: 5 }), 30, null);
    if (!isPsRow(adr)) throw new Error(adr.error);
    expect(adr.marketCapUsd).toBe(600e6);
    expect(priceAtPs(adr, adr.ps)).toBe(30);
  });

  it('sin ventas (bancos), sin acciones, sin precio o fuera de la SEC, dice por qué', () => {
    expect(psRow(fin({ years: [{ year: 2025, end: '2025-12-31', revenue: null, operatingIncome: null, netIncome: 1e9 }] }), 30, null)).toMatchObject({ error: expect.stringMatching(/bancos/) });
    expect(psRow(fin({ shares: [] }), 30, null)).toMatchObject({ error: expect.stringMatching(/acciones/) });
    expect(psRow(fin(), 0, null)).toMatchObject({ error: expect.stringMatching(/precio/) });
    expect(psRow(fin({ cik: null }), 30, null)).toMatchObject({ error: expect.stringMatching(/SEC/) });
  });

  it('el P/S de cada cierre fiscal usa el precio de ese día y las acciones de la portada siguiente', () => {
    const closes: [string, number][] = [
      ['2023-12-29', 20],
      ['2024-12-31', 25],
      ['2025-12-31', 28],
    ];
    expect(psHistory(fin(), closes, null)).toEqual([
      { year: 2023, end: '2023-12-31', price: 20, ps: 2.75 }, // 20 × 110 M ÷ 800 M
      { year: 2024, end: '2024-12-31', price: 25, ps: 2.92 }, // 25 × 105 M ÷ 900 M
      { year: 2025, end: '2025-12-31', price: 28, ps: 2.8 }, // 28 × 100 M ÷ 1.000 M
    ]);
    // Sin precio cerca del cierre (más de 10 días antes), ese año no cuenta.
    expect(psHistory(fin(), [['2025-12-01', 28]], null)).toEqual([]);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
