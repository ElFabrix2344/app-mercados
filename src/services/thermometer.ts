// «Termómetro del S&P 500» (4 nov, opción A de la evaluación de los últimos 500 movimientos): cuánto se mueve el
// mercado, no hacia dónde. En esas 500 sesiones la dirección no tuvo un patrón aprovechable (un modelo que aprendía de
// cómo cerró el día anterior acertaba lo mismo que decir siempre «sube»), así que aquí solo se describe lo que sí se
// puede medir: la volatilidad frente a su propia historia, el tamaño de un día normal, los días extremos, la distancia
// al máximo y la racha.
// Usa los 5 años guardados del SPY (`hist5:SPY`, 1 crédito cada 12 h): son precios de Twelve Data, solo para el dueño.

import { storedHistory, type CacheDeps, type Fresh } from './market';

export const THERMO_SYMBOL = 'SPY';
/** Sesiones con que se compara (la muestra que eligió el usuario). */
export const THERMO_SESSIONS = 500;
const VOL_DAYS = 20;
const YEAR = 252;

export type Regime = 'tranquilo' | 'normal' | 'agitado';

export interface Thermometer {
  symbol: string;
  /** Fecha del último cierre. */
  asOf: string;
  /** Sesiones de la muestra (500, o menos si no hay tanta historia). */
  sessions: number;
  /** Volatilidad de los últimos 20 días, anualizada (fracción). */
  vol20: number;
  /** Qué parte de las sesiones de la muestra tuvo una volatilidad de 20 días menor que la de hoy (0 a 1). */
  percentile: number;
  /** Tercio de la volatilidad de hoy dentro de la muestra. */
  regime: Regime;
  /** Límites de los tercios (volatilidad de 20 días anualizada). */
  bands: { low: number; high: number };
  /** Mediana del tamaño del movimiento diario: los últimos 20 días y toda la muestra. */
  typical: { recent: number; sample: number };
  /** Un desvío estándar diario con la volatilidad de hoy: si los movimientos fueran normales, 2 de cada 3 días quedan dentro. */
  oneSd: number;
  last: { date: string; ret: number };
  /** Distancia al cierre más alto de la muestra (0 = en el máximo). */
  fromHigh: { pct: number; date: string };
  /** Días seguidos al alza o a la baja hasta el último cierre, y cuánto suman. */
  streak: { dir: 'up' | 'down'; days: number; ret: number } | null;
  /**
   * Días de más de ±2 % y ±3 % en la muestra, lo que esperaría una curva normal con el mismo desvío, los de más de ±2 %
   * en los últimos 20 días y el último de más de ±3 %.
   */
  extremes: { over2: number; over3: number; expected2: number; expected3: number; recent2: number; last3: { date: string; ret: number } | null };
  /** Volatilidad de 20 días al cierre de cada sesión de la muestra (anualizada), para el gráfico. */
  series: [string, number][];
}

const round = (v: number, dec = 6) => Math.round(v * 10 ** dec) / 10 ** dec;

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Complemento de la función de error (aproximación de Numerical Recipes, error < 1,2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const y =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? y : 2 - y;
}

/**
 * El termómetro con los cierres diarios (del más viejo al más nuevo). Hacen falta al menos 61 cierres (60 movimientos);
 * la volatilidad de cada día se mide con los 20 movimientos hasta ese día inclusive.
 */
export function computeThermometer(points: [string, number][], symbol = THERMO_SYMBOL, sessions = THERMO_SESSIONS): Thermometer | null {
  const rets = points.slice(1).map(([d, c], i) => ({ d, r: c / points[i]![1] - 1 }));
  if (rets.length < 60) return null;
  const n = Math.min(sessions, rets.length - VOL_DAYS + 1);
  const start = rets.length - n;
  const win = rets.slice(start);
  const volAt = (end: number) => stdev(rets.slice(end - VOL_DAYS + 1, end + 1).map((x) => x.r)) * Math.sqrt(YEAR);
  const series = win.map((x, j): [string, number] => [x.d, round(volAt(start + j))]);

  const vols = series.map(([, v]) => v).sort((a, b) => a - b);
  const at = (q: number) => vols[Math.min(vols.length - 1, Math.floor(q * vols.length))]!;
  const bands = { low: at(1 / 3), high: at(2 / 3) };
  const vol20 = series.at(-1)![1];
  const regime: Regime = vol20 < bands.low ? 'tranquilo' : vol20 < bands.high ? 'normal' : 'agitado';

  const abs = win.map((x) => Math.abs(x.r));
  const sd = stdev(win.map((x) => x.r));
  const expected = (k: number) => round(n * erfc(k / (sd * Math.SQRT2)), 2);
  const last3 = [...win].reverse().find((x) => Math.abs(x.r) > 0.03) ?? null;

  // El máximo entre los cierres de la muestra (incluye el cierre anterior al primer movimiento).
  const closes = points.slice(-(n + 1));
  let top = closes[0]!;
  for (const p of closes) if (p[1] >= top[1]) top = p;
  const lastClose = points.at(-1)!;

  let streak: Thermometer['streak'] = null;
  const lastRet = win.at(-1)!.r;
  if (lastRet !== 0) {
    const dir = lastRet > 0 ? 'up' : 'down';
    let days = 0;
    let growth = 1;
    for (let i = win.length - 1; i >= 0 && (dir === 'up' ? win[i]!.r > 0 : win[i]!.r < 0); i--) {
      days++;
      growth *= 1 + win[i]!.r;
    }
    streak = { dir, days, ret: round(growth - 1) };
  }

  return {
    symbol,
    asOf: lastClose[0],
    sessions: n,
    vol20,
    percentile: round(vols.filter((v) => v < vol20).length / vols.length, 4),
    regime,
    bands,
    typical: { recent: round(median(abs.slice(-VOL_DAYS))), sample: round(median(abs)) },
    oneSd: round(vol20 / Math.sqrt(YEAR)),
    last: { date: win.at(-1)!.d, ret: round(lastRet) },
    fromHigh: { pct: round(lastClose[1] / top[1] - 1), date: top[0] },
    streak,
    extremes: {
      over2: abs.filter((x) => x > 0.02).length,
      over3: abs.filter((x) => x > 0.03).length,
      expected2: expected(0.02),
      expected3: expected(0.03),
      recent2: abs.slice(-VOL_DAYS).filter((x) => x > 0.02).length,
      last3: last3 ? { date: last3.d, ret: round(last3.r) } : null,
    },
    series,
  };
}

/** Con los 5 años guardados del SPY (1 crédito si hay que renovarlos). Con la clave de Rueda o la de un amigo. */
export async function thermometer(d: CacheDeps): Promise<Fresh<Thermometer | null>> {
  const h = await storedHistory(d, THERMO_SYMBOL);
  return { ...h, data: computeThermometer(h.data.points) };
}
