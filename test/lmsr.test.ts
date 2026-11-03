import { describe, expect, it } from 'vitest';
import { cost, priceYes, saleValue, sharesFor } from '../src/lib/lmsr';

describe('creador de mercado (LMSR)', () => {
  const b = 4;

  it('empieza en 50 % y el precio sube con las compras de Sí y baja con las de No', () => {
    expect(priceYes(0, 0, b)).toBe(0.5);
    const yes = sharesFor(0, 0, b, 'si', 2);
    expect(priceYes(yes, 0, b)).toBeGreaterThan(0.5);
    expect(priceYes(0, yes, b)).toBeCloseTo(1 - priceYes(yes, 0, b), 12);
  });

  it('lo que se paga es lo que sube la función de costo, y 2,77 (277 fichas) llevan el precio de 50 a 75 %', () => {
    const spend = 2.77;
    const d = sharesFor(0, 0, b, 'si', spend);
    expect(cost(d, 0, b) - cost(0, 0, b)).toBeCloseTo(spend, 9);
    expect(priceYes(d, 0, b)).toBeCloseTo(0.75, 2);
    // A 50 %, una acción cuesta algo más de 0,5: con 1 se compran menos de 2.
    const one = sharesFor(0, 0, b, 'si', 1);
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThan(2);
  });

  it('comprar y vender lo mismo devuelve lo pagado (no depende del camino)', () => {
    const d = sharesFor(1.5, 0.3, b, 'no', 3);
    expect(saleValue(1.5, 0.3 + d, b, 'no', d)).toBeCloseTo(3, 9);
  });

  it('no se desborda con cantidades grandes', () => {
    expect(priceYes(400, 0, b)).toBeCloseTo(1, 9);
    expect(Number.isFinite(cost(400, 0, b))).toBe(true);
    expect(Number.isFinite(sharesFor(400, 0, b, 'no', 5))).toBe(true);
  });
});
