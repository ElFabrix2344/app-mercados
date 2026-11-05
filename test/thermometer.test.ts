import { describe, expect, it } from 'vitest';
import { computeThermometer } from '../src/services/thermometer';

/** Cierres diarios a partir de rendimientos (días hábiles seguidos desde el 1 ene 2024, base 100). */
function closesFrom(rets: number[]): [string, number][] {
  let t = Date.UTC(2024, 0, 1);
  const iso = () => new Date(t).toISOString().slice(0, 10);
  const out: [string, number][] = [[iso(), 100]];
  let c = 100;
  for (const r of rets) {
    do t += 86_400_000;
    while ([0, 6].includes(new Date(t).getUTCDay()));
    c *= 1 + r;
    out.push([iso(), c]);
  }
  return out;
}

/** Ruido reproducible: uniforme con desvío `sd` (generador de Park y Miller). */
function noise(n: number, sd: number, seed = 1): number[] {
  let x = seed;
  return Array.from({ length: n }, () => {
    x = (x * 16807) % 2147483647;
    return (x / 2147483647 - 0.5) * 2 * sd * Math.sqrt(3);
  });
}

describe('termómetro del S&P 500', () => {
  it('después de un año tranquilo, 20 días movidos dan «agitado» y casi todo el historial por debajo', () => {
    const t = computeThermometer(closesFrom([...noise(540, 0.005), ...noise(20, 0.02, 7)]))!;
    expect(t.sessions).toBe(500);
    expect(t.series).toHaveLength(500);
    expect(t.series.at(-1)![0]).toBe(t.asOf);
    expect(t.regime).toBe('agitado');
    expect(t.percentile).toBeGreaterThan(0.95);
    // ≈ 2 % diario anualizado (con ruido uniforme, aproximado).
    expect(t.vol20).toBeGreaterThan(0.2);
    expect(t.vol20).toBeLessThan(0.45);
    expect(t.oneSd).toBeCloseTo(t.vol20 / Math.sqrt(252), 6);
    expect(t.typical.recent).toBeGreaterThan(2 * t.typical.sample);
    expect(t.bands.low).toBeLessThan(t.bands.high);
  });

  it('y al revés: si lo movido quedó atrás, hoy está «tranquilo»', () => {
    // Lo tranquilo tiene que ser menos de un tercio de la muestra para caer en el tercio de abajo.
    const t = computeThermometer(closesFrom([...noise(450, 0.01, 3), ...noise(100, 0.003, 5)]))!;
    expect(t.regime).toBe('tranquilo');
    expect(t.percentile).toBeLessThan(0.25);
  });

  it('racha, distancia al máximo y días extremos frente a una curva normal', () => {
    const rets = [...noise(100, 0.005, 11), 0.035, ...noise(20, 0.005, 13), -0.01, -0.012, 0.004, 0.006, 0.003];
    const closes = closesFrom(rets);
    const t = computeThermometer(closes)!;
    expect(t.sessions).toBe(rets.length - 19); // sin 500 sesiones, las que tengan volatilidad de 20 días
    expect(t.streak).toEqual({ dir: 'up', days: 3, ret: Math.round((1.004 * 1.006 * 1.003 - 1) * 1e6) / 1e6 });
    expect(t.last.ret).toBe(0.003);
    expect(t.extremes).toMatchObject({ over3: 1, over2: 1, recent2: 0 });
    expect(t.extremes.last3).toEqual({ date: closes[101]![0], ret: 0.035 });
    expect(t.extremes.expected3).toBeLessThan(0.5); // con este desvío, una normal casi nunca pasa ±3 %
    // El máximo de la muestra y cuánto falta para volver a él.
    const sample = closes.slice(-(t.sessions + 1));
    const top = sample.reduce((a, b) => (b[1] >= a[1] ? b : a));
    expect(t.fromHigh.date).toBe(top[0]);
    expect(t.fromHigh.pct).toBeCloseTo(closes.at(-1)![1] / top[1] - 1, 6);
  });

  it('sin 60 movimientos no hay termómetro', () => {
    expect(computeThermometer(closesFrom(noise(59, 0.01)))).toBeNull();
    expect(computeThermometer(closesFrom(noise(60, 0.01)))).not.toBeNull();
  });
});
