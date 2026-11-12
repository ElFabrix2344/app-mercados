// Banco de pruebas para operar en días (11 nov 2026; el usuario: «yo tradearía en días, no en minutos»). Funciones
// puras, sin DOM, con pruebas (test/bench-core.test.ts), como hapi-core.js y valuation-core.js.
//
// Prueban una regla de entrada y salida sobre las velas diarias que Rueda ya guarda (5 años), con un monto fijo por
// operación y las comisiones de Hapi, y la comparan con solo mantener y con entrar al azar. También miden cómo se
// movió el precio después de cada reporte de resultados.
//
// La convención, para quien revisa una vez al día y no mira el futuro: todo se decide con el CIERRE de un día y se
// ejecuta en la APERTURA del día siguiente. Una posición a la vez. Nada de esto recomienda comprar o vender: dice
// qué habría pasado con una regla, no qué va a pasar.

import { orderFee } from './hapi-core.js';

/** Media móvil simple de `n` días (null hasta tener `n` valores). */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** RSI de `n` días con el suavizado de Wilder (null hasta tener `n` variaciones). */
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = values[i] - values[i - 1];
    gain += Math.max(ch, 0);
    loss += Math.max(-ch, 0);
  }
  let g = gain / n;
  let l = loss / n;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = val();
  for (let i = n + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    g = (g * (n - 1) + Math.max(ch, 0)) / n;
    l = (l * (n - 1) + Math.max(-ch, 0)) / n;
    out[i] = val();
  }
  return out;
}

/** El mayor (o el menor) de los `n` cierres ANTERIORES a cada día, sin contar el de ese día. */
function rolling(values, n, pick) {
  const out = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i++) {
    let v = values[i - 1];
    for (let j = i - n; j < i - 1; j++) v = pick(v, values[j]);
    out[i] = v;
  }
  return out;
}

/** Días hábiles que se mantiene una compra hecha por «después de resultados». */
export const EARNINGS_HOLD = 20;
/** Reacción mínima (2 días) para que «después de resultados» compre. */
export const EARNINGS_MIN = 0.03;

/**
 * Una señal de compra es un hecho de un día, no un estado: la condición se cumple hoy y ayer no. Así, después de un
 * stop o de cumplir el máximo de días, la regla no vuelve a comprar a la mañana siguiente solo porque la condición
 * sigue ahí: espera a que se dé de nuevo.
 */
const fresh = (cond) => (i) => cond(i) && !cond(i - 1);

/**
 * Las reglas que se pueden probar. Cada una recibe los días y devuelve `warmup` (desde qué día puede decidir: ese día
 * y el anterior ya tienen sus indicadores), `enter(i)` (¿comprar mañana, con el cierre de hoy?) y `exit(i, held)`
 * (¿vender mañana?; `held`: cierres que lleva dentro, contando el de la compra).
 */
export const RULES = {
  // Ruptura de máximos: lo que sube y marca un máximo nuevo, a veces sigue.
  ruptura: (days) => {
    const c = days.map((d) => d.close);
    const hi = rolling(c, 20, Math.max);
    const lo = rolling(c, 10, Math.min);
    return { warmup: 20, enter: (i) => c[i] > hi[i], exit: (i) => c[i] < lo[i] };
  },
  // Retroceso dentro de una tendencia alcista: se compra la caída corta y se vende el rebote.
  retroceso: (days) => {
    const c = days.map((d) => d.close);
    const long = sma(c, 200);
    const short = sma(c, 5);
    const r = rsi(c, 2);
    return { warmup: 200, enter: fresh((i) => c[i] > long[i] && r[i] < 10), exit: (i) => c[i] > short[i] };
  },
  'ma20-50': (days) => crossRule(days, 20, 50),
  'ma50-200': (days) => crossRule(days, 50, 200),
  // RSI de 14 días: compra la sobreventa (el día en que baja de 30) y vende la sobrecompra (sobre 70).
  rsi: (days) => {
    const r = rsi(days.map((d) => d.close), 14);
    return { warmup: 15, enter: fresh((i) => r[i] < 30), exit: (i) => r[i] > 70 };
  },
  // Después de resultados: si la reacción a un reporte fue buena, compra y mantiene 20 días.
  resultados: (days, ctx) => {
    const good = new Set(reactions(days.map((d) => [d.date, d.close]), ctx?.events ?? []).filter((e) => e.reaction >= EARNINGS_MIN).map((e) => e.at));
    return { warmup: 1, enter: (i) => good.has(i), exit: (i, held) => held >= EARNINGS_HOLD };
  },
};

/** Cruce de medias: compra el día en que la rápida pasa sobre la lenta y vende cuando vuelve a quedar debajo. */
function crossRule(days, fast, slow) {
  const c = days.map((d) => d.close);
  const f = sma(c, fast);
  const s = sma(c, slow);
  return { warmup: slow, enter: fresh((i) => f[i] > s[i]), exit: (i) => f[i] <= s[i] };
}

/** Lo que cobra Hapi por una orden, en US$ (cero si la prueba va sin comisiones). */
const feeFn = (plan, fees) => (fees ? (side, qty, price, date) => orderFee(side, qty, price, date, plan).total : () => 0);

const drawdown = (xs) => {
  let peak = xs[0] ?? 0;
  let worst = 0;
  for (const x of xs) {
    if (x > peak) peak = x;
    if (peak > 0) worst = Math.min(worst, x / peak - 1);
  }
  return worst;
};

/**
 * Corre una regla sobre los días (`{ date, open, high, low, close }`, del más viejo al más nuevo; sin apertura se usa
 * el cierre). `amount`: dólares por operación. `stopPct`: vende si un cierre queda ese % bajo el precio de compra
 * (0 = sin stop). `maxDays`: vende al cumplir tantos días (0 = sin límite). `plan`: el de Hapi, para las comisiones;
 * `fees: false` las deja en cero (las de Hapi que se conocen son las de acciones y ETF: no sirven para cripto ni divisas).
 * Devuelve las operaciones, el valor de la prueba al cierre de cada día y sus números; null si no hay historia.
 * `ruleKey` es el nombre de una de RULES (o, en las pruebas, una función con la misma forma).
 * @param {{ date: string, open?: number | null, high?: number | null, low?: number | null, close: number }[]} days
 * @param {string | Function} ruleKey
 * @param {{ amount?: number, stopPct?: number, maxDays?: number, plan?: string, fees?: boolean, events?: string[] }} [opts]
 */
export function runRule(days, ruleKey, { amount = 200, stopPct = 0, maxDays = 0, plan = 'standard', fees = true, events = [] } = {}) {
  const make = typeof ruleKey === 'function' ? ruleKey : Object.hasOwn(RULES, ruleKey) ? RULES[ruleKey] : null;
  if (!make || !(amount > 0)) return null;
  const rule = make(days, { events });
  const n = days.length;
  if (n < rule.warmup + 3) return null;
  const openOf = (i) => days[i].open ?? days[i].close;
  const feeOf = feeFn(plan, fees);
  const trades = [];
  const value = new Array(n);
  let closedPnl = 0;
  let pos = null;
  let buy = false;
  let sell = null;
  let inDays = 0;
  for (let i = 0; i < n; i++) {
    const d = days[i];
    // 1) En la apertura se ejecuta lo que se decidió ayer.
    if (sell && pos) {
      const price = openOf(i);
      const feeOut = feeOf('sell', pos.qty, price, d.date);
      const gross = pos.qty * (price - pos.price);
      const pnl = gross - pos.feeIn - feeOut;
      trades.push({ entry: pos.date, entryPrice: pos.price, exit: d.date, exitPrice: price, days: i - pos.i, gross, fees: pos.feeIn + feeOut, pnl, ret: pnl / amount, why: sell, at: pos.i, until: i });
      closedPnl += pnl;
      pos = null;
    }
    sell = null;
    if (buy && !pos) {
      const price = openOf(i);
      const qty = amount / price;
      pos = { i, date: d.date, price, qty, feeIn: feeOf('buy', qty, price, d.date), stop: stopPct > 0 ? price * (1 - stopPct / 100) : null };
    }
    buy = false;
    // 2) El valor de la prueba al cierre.
    value[i] = amount + closedPnl + (pos ? pos.qty * (d.close - pos.price) - pos.feeIn : 0);
    if (pos) inDays++;
    // 3) Con el cierre de hoy se decide lo de mañana.
    if (i < rule.warmup) continue;
    if (pos) {
      const held = i - pos.i + 1;
      sell = pos.stop !== null && d.close <= pos.stop ? 'stop' : maxDays > 0 && held >= maxDays ? 'tiempo' : rule.exit(i, held) ? 'regla' : null;
    } else if (rule.enter(i)) buy = true;
  }
  if (pos) {
    const last = days[n - 1];
    const gross = pos.qty * (last.close - pos.price);
    const pnl = gross - pos.feeIn;
    trades.push({ entry: pos.date, entryPrice: pos.price, exit: null, exitPrice: last.close, days: n - 1 - pos.i, gross, fees: pos.feeIn, pnl, ret: pnl / amount, why: null, at: pos.i, until: n - 1 });
  }

  // Solo mantener: la misma plata, comprada la primera mañana en que la regla ya podía decidir, y sin vender.
  const start = Math.min(n - 1, rule.warmup + 1);
  const holdPrice = openOf(start);
  const holdQty = amount / holdPrice;
  const holdFee = feeOf('buy', holdQty, holdPrice, days[start].date);
  const hold = days.map((d, i) => (i < start ? amount : amount + holdQty * (d.close - holdPrice) - holdFee));

  const total = value[n - 1] - amount;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  let streak = 0;
  let worstStreak = 0;
  for (const t of trades) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  const byYear = new Map();
  for (const t of trades) {
    const y = (t.exit ?? days[n - 1].date).slice(0, 4);
    const row = byYear.get(y) ?? { year: y, trades: 0, pnl: 0 };
    row.trades++;
    row.pnl += t.pnl;
    byYear.set(y, row);
  }
  const years = (Date.parse(days[n - 1].date) - Date.parse(days[start].date)) / (365.25 * 86_400_000);
  return {
    rule: ruleKey,
    amount,
    from: days[start].date,
    to: days[n - 1].date,
    years,
    dates: days.map((d) => d.date),
    value,
    hold,
    trades,
    start,
    stats: {
      total,
      ret: total / amount,
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : null,
      avgWin: mean(wins.map((t) => t.pnl)),
      avgLoss: mean(losses.map((t) => t.pnl)),
      perTrade: trades.length ? total / trades.length : null,
      fees: trades.reduce((s, t) => s + t.fees, 0),
      gross: trades.reduce((s, t) => s + t.gross, 0),
      drawdown: drawdown(value.slice(start)),
      exposure: n - start > 0 ? inDays / (n - start) : 0,
      worstStreak,
      byYear: [...byYear.values()].sort((a, b) => (a.year < b.year ? -1 : 1)),
    },
    holdStats: { total: hold[n - 1] - amount, ret: (hold[n - 1] - amount) / amount, drawdown: drawdown(hold.slice(start)) },
  };
}

/** Números al azar repetibles (mulberry32): la misma semilla da siempre la misma prueba. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semilla a partir de un texto (el símbolo y la regla), para que la prueba no cambie al volver a abrirla. */
export function seedOf(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * ¿La regla le gana a entrar al azar? Repite `runs` veces la misma cantidad de operaciones, con las mismas duraciones
 * y las mismas comisiones, pero entrando en días elegidos al azar (sin encimarse, en el mismo tramo de la historia).
 * `beats`: en qué parte de esas pruebas el azar ganó MENOS que la regla (0,5 es lo que se espera de la suerte).
 * null si la regla hizo menos de 5 operaciones (con tan pocas, la comparación no dice nada) o no entran en el tramo.
 */
export function randomBaseline(days, result, { plan = 'standard', fees = true, runs = 1000, seed = 1 } = {}) {
  const lengths = result.trades.map((t) => Math.max(1, t.until - t.at));
  if (lengths.length < 5) return null;
  const feeOf = feeFn(plan, fees);
  const n = days.length;
  const lo = result.start;
  const span = n - 1 - lo;
  const used = lengths.reduce((s, x) => s + x, 0);
  const free = span - used;
  if (free < 0) return null;
  const rand = seeded(seed);
  const openOf = (i) => days[i].open ?? days[i].close;
  const totals = new Array(runs);
  for (let r = 0; r < runs; r++) {
    // Las duraciones, en otro orden; los huecos entre operaciones, al azar.
    const ls = [...lengths];
    for (let i = ls.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ls[i], ls[j]] = [ls[j], ls[i]];
    }
    const gaps = ls.map(() => Math.floor(rand() * (free + 1))).sort((a, b) => a - b);
    let offset = 0;
    let total = 0;
    for (let k = 0; k < ls.length; k++) {
      const at = lo + gaps[k] + offset;
      const until = at + ls[k];
      offset += ls[k];
      const price = openOf(at);
      const qty = result.amount / price;
      const out = openOf(until);
      total += qty * (out - price) - feeOf('buy', qty, price, days[at].date) - feeOf('sell', qty, out, days[until].date);
    }
    totals[r] = total;
  }
  const sorted = [...totals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(runs - 1, Math.floor(p * runs))];
  return { runs, beats: totals.filter((t) => t < result.stats.total).length / runs, median: q(0.5), low: q(0.05), high: q(0.95) };
}

/**
 * La reacción del precio a cada fecha de `events` (AAAA-MM-DD, las de los reportes de resultados): del último cierre
 * ANTES de la fecha al primer cierre DESPUÉS de ella. Son dos días porque no se sabe si el reporte salió antes de la
 * apertura o después del cierre: así entra en los dos casos. `at` es el índice del día en que ya se conoce la reacción.
 * Dos fechas a menos de 10 días (una corrección del mismo reporte) cuentan una vez. `points`: [fecha, cierre].
 */
export function reactions(points, events) {
  const out = [];
  let lastEvent = null;
  for (const date of [...new Set(events)].sort()) {
    if (lastEvent && (Date.parse(date) - Date.parse(lastEvent)) / 86_400_000 < 10) continue;
    let before = -1;
    for (let i = 0; i < points.length; i++) {
      if (points[i][0] >= date) break;
      before = i;
    }
    const at = points.findIndex(([d]) => d > date);
    if (before < 0 || at < 0) continue;
    lastEvent = date;
    out.push({ date, before, at, reaction: points[at][1] / points[before][1] - 1 });
  }
  return out;
}

/**
 * Qué pasó después de cada reporte de resultados: la reacción (2 días) y cuánto más se movió en los `horizons` días
 * hábiles siguientes (5 y 20), contando desde el cierre en que ya se conocía la reacción. Con `bench` (los cierres
 * del SPY), también lo mismo restándole el mercado (`reactionX`, `afterX` y `summaryX`). El resumen separa las
 * reacciones buenas de las malas, que es la pregunta útil: después de un buen reporte, ¿siguió subiendo?
 * @param {[string, number][]} points
 * @param {string[]} events
 * @param {{ horizons?: number[], bench?: [string, number][] | null }} [opts]
 */
export function eventStudy(points, events, { horizons = [5, 20], bench = null } = {}) {
  const benchAt = bench ? new Map(bench.map(([d, c]) => [d, c])) : null;
  const rel = (a, b) => (benchAt && benchAt.has(points[a][0]) && benchAt.has(points[b][0]) ? benchAt.get(points[b][0]) / benchAt.get(points[a][0]) - 1 : null);
  const rows = reactions(points, events).map((e) => {
    /** @type {Record<number, number | null>} */
    const after = {};
    /** @type {Record<number, number | null>} */
    const afterX = {};
    for (const h of horizons) {
      const j = e.at + h;
      after[h] = j < points.length ? points[j][1] / points[e.at][1] - 1 : null;
      const m = j < points.length ? rel(e.at, j) : null;
      afterX[h] = after[h] !== null && m !== null ? after[h] - m : null;
    }
    const m = rel(e.before, e.at);
    return { date: e.date, day: points[e.at][0], reaction: e.reaction, reactionX: m === null ? null : e.reaction - m, after, afterX };
  });
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  /** El resumen con la reacción y lo que siguió tal cual, o con las dos restándoles el mercado (los reportes sin ese dato no entran). */
  const summarize = (reactionOf, afterOf) => {
    const kept = rows.filter((r) => reactionOf(r) !== null);
    if (!kept.length) return null;
    const side = (pick) => {
      const g = kept.filter((r) => pick(reactionOf(r)));
      /** @type {Record<string, any>} */
      const out = { n: g.length };
      for (const h of horizons) {
        const xs = g.map((r) => afterOf(r)[h]).filter((v) => v !== null);
        out[h] = { n: xs.length, up: xs.filter((v) => v > 0).length, mean: mean(xs) };
      }
      return out;
    };
    const re = kept.map(reactionOf);
    return { n: kept.length, up: re.filter((v) => v > 0).length, meanAbs: mean(re.map(Math.abs)), best: Math.max(...re), worst: Math.min(...re), good: side((v) => v > 0), bad: side((v) => v <= 0) };
  };
  return {
    horizons,
    rows,
    summary: summarize((r) => r.reaction, (r) => r.after),
    /** Lo mismo, descontando el mercado: null sin `bench`. */
    summaryX: bench ? summarize((r) => r.reactionX, (r) => r.afterX) : null,
  };
}
