import { describe, expect, it } from 'vitest';
import { alignByDate, bollinger, ema, indicators, macd, pearson, rebase, returnsOf, rsi, sliceIndicators, sma } from '../src/lib/indicators';

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

describe('ema y macd', () => {
  it('la media exponencial arranca con la simple y salta los null del comienzo', () => {
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
    expect(ema([null, null, 1, 2, 3, 4], 3)).toEqual([null, null, null, null, 2, 3]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('con una subida constante el MACD es 7 veces el paso y el histograma 0', () => {
    const m = macd(Array.from({ length: 60 }, (_, i) => 100 + 2 * i));
    expect(m.line[24]).toBeNull();
    expect(m.line[25]).toBeCloseTo(14, 9);
    expect(m.signal[32]).toBeNull();
    expect(m.signal[33]).toBeCloseTo(14, 9);
    expect(m.hist.at(-1)).toBeCloseTo(0, 9);
  });

  it('coincide con el MACD de Twelve Data para BAP (20 y 21 oct 2026, 150 cierres reales)', () => {
    // Cierres del 18 mar al 21 oct 2026, del más nuevo al más viejo, como los da Twelve Data.
    const desc = [388.38, 390.54999, 383.95001, 390.26001, 388.42001, 383.94, 380.69, 381.87, 381.20999, 380.38, 376.10999, 385.14001, 378.070007, 373.31, 378.35001, 379.87, 384.029999, 385.95001, 386.16, 383.01001, 385.38, 393.22, 389.97, 381.82999, 383.95999, 381.14001, 372.89999, 376.040009, 377.89999, 379.44, 375.51001, 377.23999, 382.53, 384.19, 379.56, 372.51999, 366.38, 368.39999, 373.20001, 382.54999, 383.29999, 379.73999, 378.97, 370.20999, 368.98001, 368.44, 378.28, 386.35999, 375.14001, 372.22, 377, 382.20999, 386.92999, 392.57001, 394.88, 392.12, 395.79001, 400.57999, 402.26999, 383.92999, 388.95001, 390.98999, 388.42001, 387.63, 393.67001, 391.10001, 386.85001, 390.57999, 387.44, 398.20001, 392.23999, 389.22, 400.81, 391.92001, 381.47, 386.47, 392.32001, 391.20999, 387, 389.57999, 384.73999, 384.10001, 380.41, 376.48999, 368.76999, 380.57001, 382.76001, 386.94, 364.28, 362.32001, 369.54999, 368.38, 351.66, 349.60999, 319.89001, 322.5, 326.53, 327.42001, 343.92999, 340.56, 342.63, 341.5, 348.23999, 351.75, 334.29999, 344, 333.26999, 315.79001, 303.85999, 316.31, 327.69, 317.67999, 323.82001, 322.42001, 330.5, 321.76999, 326.54999, 318.39999, 319.98001, 321.97, 324.17001, 318.059998, 320.72, 319.94, 323.64999, 323.48999, 334.47, 333.22, 335.85001, 331.94, 340.22, 316.48999, 357.59, 361.34, 349.42001, 352.37, 352.25, 337.44, 338.82999, 339.98001, 341.26001, 339.17999, 319.42999, 322.42999, 328.54001, 338.89999, 330.23999, 329.82999, 321.64001, 328.32001, 324.040009];
    const m = macd([...desc].reverse());
    const at = (k: number) => desc.length - 1 - k;
    // Twelve Data: 21 oct → 1.87486 / 1.043322 / 0.83153706; 20 oct → 1.70826 / 0.83543767 / 0.87281895.
    expect(m.line[at(0)]).toBeCloseTo(1.87486, 2);
    expect(m.signal[at(0)]).toBeCloseTo(1.043322, 2);
    expect(m.hist[at(0)]).toBeCloseTo(0.83153706, 3);
    expect(m.line[at(1)]).toBeCloseTo(1.70826, 2);
    expect(m.signal[at(1)]).toBeCloseTo(0.83543767, 2);
  });
});