import { describe, expect, it } from 'vitest';
import { closeAt, dcfValue, impliedGrowth, latestOf, median, multiples, multiplesHistory, peerMetrics, splitAdjusted, splitFactor, standing } from '../public/valuation-core.js';

/** Una empresa inventada: tres años, con trimestres y un split de 10 por 1 a mediados de 2025. */
const fin = {
  symbol: 'XYZ',
  cik: 1,
  currency: 'USD',
  adrRatio: 1,
  years: [
    { year: 2023, end: '2023-12-31', revenue: 800, operatingIncome: 160, netIncome: 100 },
    { year: 2024, end: '2024-12-31', revenue: 900, operatingIncome: 190, netIncome: 120 },
    { year: 2025, end: '2025-12-31', revenue: 1000, operatingIncome: 220, netIncome: 150 },
  ],
  shares: [
    { date: '2024-02-15', value: 100 },
    { date: '2025-02-15', value: 98 },
    { date: '2025-08-15', value: 970 }, // después del split
    { date: '2026-02-15', value: 960 },
    { date: '2026-10-25', value: 950 },
  ],
  ttm: { start: '2025-10-01', end: '2026-09-30', revenue: 1100, operatingIncome: 250, netIncome: 170 },
  ttmPrev: { start: '2024-10-01', end: '2025-09-30', revenue: 980, operatingIncome: 210, netIncome: 140 },
};
const fundYear = (year: number, o = {}) => ({ year, end: `${year}-12-31`, ocf: 200, capex: 50, da: 30, cash: 100, debt: 300, equity: 500, assets: 1500, ...o });
const fund = {
  years: [fundYear(2023, { equity: 400 }), fundYear(2024, { equity: 450 }), fundYear(2025)],
  latest: { year: 2026, end: '2026-09-30', ocf: 240, capex: 60, da: 35, cash: 150, debt: 280, equity: 560, assets: 1600 },
};

describe('splits', () => {
  it('un salto de 2, 3, 10… entre dos portadas es un split; una emisión o una recompra, no', () => {
    expect(splitFactor(2_460e6, 24_500e6)).toBe(10); // 10 por 1, con algo de recompra en el medio
    expect(splitFactor(1_000, 3_050)).toBe(3);
    expect(splitFactor(1_000, 20_100)).toBe(20);
    expect(splitFactor(500, 49)).toBeCloseTo(0.1); // split inverso de 1 por 10
    expect(splitFactor(1_200e6, 1_600e6)).toBe(1); // una compra pagada con acciones (+33 %)
    expect(splitFactor(1_000, 2_600)).toBe(1); // 2,6 veces no es ninguna proporción usual
    expect(splitFactor(1_000, 990)).toBe(1);
    expect(splitFactor(0, 100)).toBe(1);
  });

  it('las acciones de antes del split se llevan a acciones de hoy; las de después quedan igual', () => {
    expect(splitAdjusted(fin.shares).map((s) => [s.date, s.adj])).toEqual([
      ['2024-02-15', 1000],
      ['2025-02-15', 980],
      ['2025-08-15', 970],
      ['2026-02-15', 960],
      ['2026-10-25', 950],
    ]);
    expect(splitAdjusted([])).toEqual([]);
  });
});

describe('múltiplos', () => {
  it('con un precio: capitalización, valor de la empresa y cada múltiplo', () => {
    const m = multiples({ price: 3, shares: 1000 }, fin.years[2], fund.years[2]);
    expect(m).toMatchObject({ cap: 3000, ev: 3200, ebitda: 250, fcf: 150 });
    expect(m.pe).toBeCloseTo(20);
    expect(m.ps).toBeCloseTo(3);
    expect(m.pb).toBeCloseTo(6);
    expect(m.evEbitda).toBeCloseTo(12.8);
    expect(m.fcfYield).toBeCloseTo(0.05);
    expect(m.earningsYield).toBeCloseTo(0.05);
  });

  it('lo que no se puede calcular queda en null; los ADR y la moneda se toman en cuenta', () => {
    const loss = multiples({ price: 3, shares: 1000 }, { revenue: 1000, operatingIncome: -10, netIncome: -50 }, { ...fund.years[2], debt: null, da: null, equity: -20 });
    expect(loss).toMatchObject({ pe: null, pb: null, ev: null, evEbitda: null });
    expect(loss.earningsYield).toBeCloseTo(-50 / 3000);
    // Sin balance (todavía no llegó): solo lo que sale de los resultados.
    expect(multiples({ price: 3, shares: 1000 }, fin.years[2], null)).toMatchObject({ pb: null, fcfYield: null, evEbitda: null });
    // 5 acciones por ADR y montos en soles a 4 por dólar.
    const adr = multiples({ price: 10, shares: 1000, adr: 5, k: 0.25 }, { revenue: 4000, operatingIncome: 800, netIncome: 400 }, null);
    expect(adr.cap).toBe(2000);
    expect(adr.ps).toBeCloseTo(2);
    expect(adr.pe).toBeCloseTo(20);
  });

  it('el cierre de una fecha: el de ese día o el último anterior, a no más de 10 días', () => {
    const points: [string, number][] = [
      ['2025-12-29', 10],
      ['2025-12-30', 11],
      ['2026-01-02', 12],
    ];
    expect(closeAt(points, '2025-12-31')).toEqual(['2025-12-30', 11]);
    expect(closeAt(points, '2026-01-20')).toBeNull();
    expect(closeAt(points, '2025-01-01')).toBeNull();
  });

  it('la historia: cada cierre fiscal con el precio de ese día y las acciones ajustadas por el split', () => {
    // Precios ya ajustados (en acciones de hoy): 2 a fines de 2023, 2,5 a fines de 2024 y 3 a fines de 2025.
    const points: [string, number][] = [
      ['2023-12-29', 2],
      ['2024-12-31', 2.5],
      ['2025-12-31', 3],
    ];
    const hist = multiplesHistory(fin, fund, points, 1);
    expect(hist.map((y) => [y.year, y.price, y.cap])).toEqual([
      [2023, 2, 2000], // 100 acciones de la portada de feb 2024 × 10 del split
      [2024, 2.5, 2450],
      [2025, 3, 2880],
    ]);
    expect(hist[0]!.pe).toBeCloseTo(20);
    expect(hist[0]!.pb).toBeCloseTo(5);
    expect(hist[2]!.ps).toBeCloseTo(2.88);
    // Sin fundamentales, solo los múltiplos de los resultados; sin precio de ese día, ese año no sale.
    expect(multiplesHistory(fin, null, points.slice(1), 1).map((y) => [y.year, y.pb])).toEqual([
      [2024, null],
      [2025, null],
    ]);
  });

  it('dónde está hoy frente a su historia: mediana, rango y posición', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    const s = standing(30, [10, 20, 15, 25])!;
    expect(s).toMatchObject({ n: 4, median: 17.5, min: 10, max: 25, at: 1, minAt: 0 });
    expect(s.rel).toBeCloseTo(30 / 17.5 - 1);
    expect(s.maxAt).toBeCloseTo(0.75); // hoy queda más allá del máximo: la barra se estira hasta hoy
    expect(standing(15, [10, 20, 15])).toMatchObject({ at: 0.5, medianAt: 0.5, rel: 0 });
    expect(standing(15, [10, 20])).toBeNull(); // dos años no son historia
    expect(standing(null, [1, 2, 3])).toBeNull();
    expect(standing(0.02, [-0.01, 0, 0.01])!.rel).toBeNull(); // mediana que no es positiva
  });
});

describe('DCF', () => {
  const base = { g: 8, gt: 2.5, r: 9, nd: 100 };

  it('el valor por acción: cinco años de crecimiento, valor terminal y deuda neta', () => {
    const v = dcfValue(150e6, 100e6, base)!;
    let f = 150e6;
    let pv = 0;
    for (let t = 1; t <= 5; t++) {
      f *= 1.08;
      pv += f / 1.09 ** t;
    }
    const tv = (f * 1.025) / (0.09 - 0.025) / 1.09 ** 5;
    expect(v.perShare).toBeCloseTo((pv + tv - 100e6) / 100e6, 6);
    expect(dcfValue(150e6, 100e6, { ...base, r: 2.9 })).toBeNull();
  });

  it('al revés: el crecimiento que ya descuenta el precio', () => {
    const price = dcfValue(150e6, 100e6, base)!.perShare;
    expect(impliedGrowth(price, 150e6, 100e6, base)).toEqual({ g: 8 });
    // Más cara, descuenta más crecimiento; más barata, menos.
    expect(impliedGrowth(price * 1.5, 150e6, 100e6, base)!.g).toBeGreaterThan(8);
    expect(impliedGrowth(price * 0.7, 150e6, 100e6, base)!.g).toBeLessThan(8);
    // Fuera de lo que el DCF simple puede describir.
    expect(impliedGrowth(price * 50, 150e6, 100e6, base)).toEqual({ above: true });
    expect(impliedGrowth(price * 0.01, 150e6, 100e6, base)).toEqual({ below: true });
    // Sin flujo de caja libre positivo, o con una tasa que no supera al crecimiento perpetuo, no hay cuenta.
    expect(impliedGrowth(price, -5, 100e6, base)).toBeNull();
    expect(impliedGrowth(price, 150e6, 100e6, { ...base, r: 2.6 })).toBeNull();
  });
});

describe('lo más nuevo de una empresa y la comparación lado a lado', () => {
  it('con trimestres: los últimos 12 meses y el balance del mismo cierre; si no coinciden, el año fiscal', () => {
    expect(latestOf(fin, fund)).toMatchObject({ ttm: true, end: '2026-09-30', inc: { revenue: 1100 }, prev: { revenue: 980 }, bal: { equity: 560 } });
    // Los fundamentales todavía no llegaron: los resultados de 12 meses, sin balance.
    expect(latestOf(fin, null)).toMatchObject({ ttm: true, bal: null });
    // El balance es de otro trimestre: no se mezclan fechas.
    expect(latestOf(fin, { ...fund, latest: { ...fund.latest, end: '2026-06-30' } })).toMatchObject({ ttm: false, year: 2025, inc: { revenue: 1000 }, prev: { revenue: 900 }, bal: { equity: 500 } });
    // Sin trimestres (una que presenta 20-F): el último año.
    expect(latestOf({ ...fin, ttm: null, ttmPrev: null }, { ...fund, latest: null })).toMatchObject({ ttm: false, end: '2025-12-31' });
    expect(latestOf({ years: [] }, null)).toBeNull();
  });

  it('lado a lado: crecimiento, márgenes, ROE y deuda sin precio; con precio, también los múltiplos', () => {
    const m = peerMetrics(fin, fund, 1, null)!;
    expect(m).toMatchObject({ ttm: true, end: '2026-09-30', revenueUsd: 1100, pe: null, ps: null });
    expect(m.growth).toBeCloseTo(1100 / 980 - 1);
    expect(m.opMargin).toBeCloseTo(250 / 1100);
    expect(m.netMargin).toBeCloseTo(170 / 1100);
    expect(m.roe).toBeCloseTo(170 / 560);
    expect(m.roa).toBeCloseTo(170 / 1600);
    expect(m.debtToEquity).toBeCloseTo(280 / 560);
    expect(m).toMatchObject({ debtUsd: 280, cashUsd: 150 });
    expect(m.netDebtToEbitda).toBeCloseTo((280 - 150) / (250 + 35));
    expect(m.fcfMargin).toBeCloseTo((240 - 60) / 1100);
    const priced = peerMetrics(fin, fund, 1, 3)!;
    expect(priced.ps).toBeCloseTo((3 * 950) / 1100);
    expect(priced.pe).toBeCloseTo((3 * 950) / 170);
    // Un banco: sin ventas ni flujo, queda lo que se puede.
    const bank = peerMetrics({ ...fin, ttm: null, years: [{ year: 2025, end: '2025-12-31', revenue: null, operatingIncome: null, netIncome: 150 }] }, { years: [fundYear(2025, { ocf: null, capex: null, debt: null })], latest: null }, 1, null)!;
    expect(bank).toMatchObject({ ttm: false, revenueUsd: null, growth: null, opMargin: null, netMargin: null, netDebtToEbitda: null, fcfMargin: null });
    expect(bank.roe).toBeCloseTo(0.3);
  });
});
