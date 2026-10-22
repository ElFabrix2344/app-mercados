// Indicadores técnicos y comparación de series. Funciones puras sobre cierres diarios
// ordenados de antiguo a reciente. Los indicadores se calculan sobre todo el historial
// (5 años) y después se recortan al rango, para que la media de 200 días exista desde el
// primer día de un rango corto.

/** Media móvil simple de `n` días (null hasta tener `n` cierres). */
export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Bandas de Bollinger: media de `n` días ± `k` desviaciones estándar (poblacional, como es la convención). */
export function bollinger(values: number[], n = 20, k = 2): { upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(values, n);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    const m = mid[i]!;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (values[j]! - m) ** 2;
    const sd = Math.sqrt(sq / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { upper, lower };
}

const rsiFrom = (gain: number, loss: number) => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));

/** RSI de `n` días con el suavizado de Wilder (null hasta tener `n` variaciones). */
export function rsi(values: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = values[i]! - values[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = rsiFrom(avgGain, avgLoss);
  for (let i = n + 1; i < values.length; i++) {
    const ch = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (n - 1) + Math.max(ch, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-ch, 0)) / n;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/**
 * Media móvil exponencial de `n` días (factor 2 / (n + 1)). Arranca con la media simple de los primeros `n` valores
 * y salta los null del comienzo (la señal del MACD se calcula sobre una línea que empieza más tarde).
 */
export function ema(values: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const first = values.findIndex((v) => v !== null);
  if (first < 0 || values.length - first < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = first; i < first + n; i++) prev += values[i]! / n;
  out[first + n - 1] = prev;
  for (let i = first + n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** MACD: media exponencial de `fast` días menos la de `slow`, su señal (media exponencial de `signal`) y la diferencia (histograma). */
export function macd(values: number[], fast = 12, slow = 26, signal = 9): { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i]! : null));
  return { line, signal: sig, hist };
}

export interface Indicators {
  sma50: (number | null)[];
  sma200: (number | null)[];
  bbUpper: (number | null)[];
  bbLower: (number | null)[];
  rsi14: (number | null)[];
  /** MACD (12, 26, 9): línea, señal e histograma. */
  macd: (number | null)[];
  macdSignal: (number | null)[];
  macdHist: (number | null)[];
}

export function indicators(closes: number[]): Indicators {
  const bb = bollinger(closes, 20, 2);
  const m = macd(closes);
  return {
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    bbUpper: bb.upper,
    bbLower: bb.lower,
    rsi14: rsi(closes, 14),
    macd: m.line,
    macdSignal: m.signal,
    macdHist: m.hist,
  };
}

/** Recorta todos los indicadores desde `start` (el mismo índice donde empieza el rango). */
export function sliceIndicators(ind: Indicators, start: number): Indicators {
  const cut = (xs: (number | null)[]) => xs.slice(start).map((x) => (x === null ? null : round4(x)));
  return {
    sma50: cut(ind.sma50),
    sma200: cut(ind.sma200),
    bbUpper: cut(ind.bbUpper),
    bbLower: cut(ind.bbLower),
    rsi14: cut(ind.rsi14),
    macd: cut(ind.macd),
    macdSignal: cut(ind.macdSignal),
    macdHist: cut(ind.macdHist),
  };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ---------- comparación ----------

/**
 * Une varias series por fecha y deja solo los días en que TODAS tienen cierre (la cripto cotiza
 * también los fines de semana). `values[i]` va alineado con `dates` y corresponde a `series[i]`.
 */
export function alignByDate(series: [string, number][][]): { dates: string[]; values: number[][] } {
  const maps = series.map((s) => new Map(s));
  const dates = [...(maps[0]?.keys() ?? [])].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, values: maps.map((m) => dates.map((d) => m.get(d)!)) };
}

/** Rendimientos diarios simples (los precios son positivos; el resultado queda alineado entre series). */
export function returnsOf(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(values[i]! / values[i - 1]! - 1);
  return out;
}

/** Correlación de Pearson; null si hay menos de 3 datos o una serie no varía. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/** Base 100: cuánto valdrían 100 invertidos el primer día. */
export const rebase = (values: number[]): number[] => (values[0] ? values.map((v) => round4((100 * v) / values[0]!)) : values);
