import { describe, expect, it } from 'vitest';
import { alignByDate, bollinger, indicators, pearson, rebase, returnsOf, rsi, sliceIndicators, sma } from '../src/lib/indicators';

describe('sma', () => {
  it('promedia los últimos n cierres y deja null antes', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});

describe('bollinger', () => {
  it('con precios constantes las bandas coinciden con la media', () => {
    const b = bollinger([5, 5, 5, 5], 2, 2);
    expect(b.upper).toEqual([null, 5, 5, 5]);
    expect(b.lower).toEqual([null, 5, 5, 5]);
  });

  it('usa la desviación estándar poblacional', () => {
    // ventana [1, 3]: media 2, desviación 1 → bandas 0 y 4 con k = 2
    expect(bollinger([1, 3], 2, 2)).toEqual({ upper: [null, 4], lower: [null, 0] });
  });
});

describe('rsi', () => {
  it('es 100 si solo sube, 0 si solo baja y 50 si no se mueve', () => {
    const up = Array.from({ length: 20 }, (_, i) => 10 + i);
    const down = [...up].reverse();
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(down, 14).at(-1)).toBe(0);
    expect(rsi(new Array(20).fill(7), 14).at(-1)).toBe(50);
    expect(rsi(up, 14).slice(0, 14).every((x) => x === null)).toBe(true);
  });

  it('coincide con el cálculo de Wilder en un caso a mano', () => {
    // n = 2. Variaciones: +2, −1 → promedio de subidas 1 y de bajadas 0,5 → RSI 66,67.
    // Siguiente +1: subidas (1·1 + 1)/2 = 1; bajadas (0,5·1 + 0)/2 = 0,25 → RSI 80.
    const r = rsi([10, 12, 11, 12], 2);
    expect(r[2]).toBeCloseTo(66.6667, 3);
    expect(r[3]).toBeCloseTo(80, 6);
  });
});

describe('indicadores recortados al rango', () => {
  it('se calculan con todo el historial y se recortan desde el inicio del rango', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i);
    const cut = sliceIndicators(indicators(closes), 230);
    expect(cut.sma200).toHaveLength(20);
    expect(cut.sma200[0]).toBeCloseTo(100 + (31 + 230) / 2, 6); // media de los cierres 31..230
    expect(cut.rsi14.every((x) => x === 100)).toBe(true);
  });
});

describe('comparación', () => {
  it('alinea por fecha y deja solo los días comunes', () => {
    const a: [string, number][] = [['2026-10-16', 1], ['2026-10-17', 2], ['2026-10-19', 3]];
    const b: [string, number][] = [['2026-10-16', 10], ['2026-10-19', 30]];
    expect(alignByDate([a, b])).toEqual({ dates: ['2026-10-16', '2026-10-19'], values: [[1, 3], [10, 30]] });
    expect(alignByDate([])).toEqual({ dates: [], values: [] });
  });

  it('pearson: +1, −1 y null si no hay variación', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it('rendimientos diarios y base 100', () => {
    const r = returnsOf([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(-0.1, 12);
    expect(rebase([50, 75, 100])).toEqual([100, 150, 200]);
  });
});
