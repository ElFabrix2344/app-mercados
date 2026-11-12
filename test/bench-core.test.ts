import { describe, expect, it } from 'vitest';
import { EARNINGS_HOLD, eventStudy, randomBaseline, reactions, rsi, RULES, runRule, seeded, seedOf, sma } from '../public/bench-core.js';
import { orderFee } from '../public/hapi-core.js';

type Day = { date: string; open: number; high: number; low: number; close: number };

/** Días hábiles seguidos desde una fecha (sin fines de semana), con apertura y cierre dados. */
function days(start: string, bars: [open: number, close: number][]): Day[] {
  const out: Day[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  for (const [open, close] of bars) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push({ date: d.toISOString().slice(0, 10), open, high: Math.max(open, close), low: Math.min(open, close), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Una regla de prueba: dentro mientras el cierre esté sobre 100. */
const above100 = (ds: Day[]) => ({ warmup: 0, enter: (i: number) => ds[i]!.close > 100, exit: (i: number) => ds[i]!.close < 100 });

describe('indicadores', () => {
  it('media móvil y RSI de Wilder', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    // Solo subidas: RSI 100. Solo bajadas: 0. Sin cambios: 50.
    expect(rsi([1, 2, 3, 4], 2).at(-1)).toBe(100);
    expect(rsi([4, 3, 2, 1], 2).at(-1)).toBe(0);
    expect(rsi([5, 5, 5, 5], 2).at(-1)).toBe(50);
    expect(rsi([1, 2], 14)).toEqual([null, null]);
  });
});

describe('correr una regla', () => {
  it('se decide con el cierre y se ejecuta en la apertura siguiente, con las comisiones de Hapi', () => {
    // Cierra sobre 100 el día 2 → compra en la apertura del día 3 (102). Cierra bajo 100 el día 5 → vende en la apertura del 6 (97).
    const ds = days('2025-03-03', [
      [99, 99],
      [99, 101],
      [102, 104],
      [104, 106],
      [105, 98],
      [97, 96],
      [96, 95],
    ]);
    const r = runRule(ds, above100, { amount: 204 })!;
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t).toMatchObject({ entry: ds[2]!.date, entryPrice: 102, exit: ds[5]!.date, exitPrice: 97, days: 3, why: 'regla' });
    // 204 / 102 = 2 acciones enteras: US$ 0,10 al comprar; al vender, 0,10 más los cargos de la SEC y de FINRA.
    const fees = orderFee('buy', 2, 102, ds[2]!.date, 'standard').total + orderFee('sell', 2, 97, ds[5]!.date, 'standard').total;
    expect(t.fees).toBeCloseTo(fees, 6);
    expect(t.gross).toBeCloseTo(2 * (97 - 102), 6);
    expect(t.pnl).toBeCloseTo(-10 - fees, 6);
    expect(r.stats.total).toBeCloseTo(-10 - fees, 6);
    // El valor de la prueba, al cierre de cada día: antes de comprar, el monto; dentro, con el cierre de ese día.
    expect(r.value[1]).toBe(204);
    expect(r.value[2]).toBeCloseTo(204 + 2 * (104 - 102) - 0.1, 6);
    expect(r.value.at(-1)).toBeCloseTo(204 - 10 - fees, 6);
    expect(r.stats).toMatchObject({ trades: 1, winRate: 0, worstStreak: 1 });
    // Dentro 3 cierres de los 6 días desde que pudo decidir.
    expect(r.stats.exposure).toBeCloseTo(3 / 6, 6);
  });

  it('con fracciones cobra la comisión de fracciones; con Prime, la de Prime', () => {
    const ds = days('2025-03-03', [
      [99, 101],
      [102, 104],
      [104, 99],
      [98, 97],
    ]);
    const std = runRule(ds, above100, { amount: 100 })!.trades[0]!;
    const prime = runRule(ds, above100, { amount: 100, plan: 'prime' })!.trades[0]!;
    const qty = 100 / 102;
    expect(std.fees).toBeCloseTo(orderFee('buy', qty, 102, ds[1]!.date, 'standard').total + orderFee('sell', qty, 98, ds[3]!.date, 'standard').total, 6);
    expect(std.fees).toBeGreaterThan(prime.fees);
  });

  it('el stop y el máximo de días salen antes que la regla; lo que sigue abierto se valoriza al último cierre', () => {
    const ds = days('2025-03-03', [
      [99, 101],
      [102, 103],
      [103, 96], // −5,9 % bajo la compra: con stop de 5 %, vende mañana
      [95, 104],
      [104, 105],
      [106, 107],
      [107, 108],
    ]);
    const stop = runRule(ds, above100, { amount: 204, stopPct: 5 })!;
    expect(stop.trades[0]).toMatchObject({ why: 'stop', exit: ds[3]!.date, exitPrice: 95 });
    // Después del stop vuelve a entrar (cierre sobre 100) y sigue dentro al final.
    expect(stop.trades[1]).toMatchObject({ entry: ds[4]!.date, exit: null, why: null, exitPrice: 108 });
    const time = runRule(
      days('2025-03-03', [
        [99, 101],
        [102, 103],
        [103, 104],
        [104, 105],
        [105, 106],
        [106, 107],
      ]),
      above100,
      { amount: 204, maxDays: 2 },
    )!;
    // Dos cierres dentro y vende en la apertura siguiente.
    expect(time.trades[0]).toMatchObject({ why: 'tiempo', days: 2, exitPrice: 104 });
    expect(runRule(ds, 'no-existe')).toBeNull();
    expect(runRule(ds.slice(0, 2), above100)).toBeNull();
  });

  it('solo mantener: la misma plata desde la primera mañana en que la regla pudo decidir, sin vender', () => {
    const ds = days('2025-03-03', [
      [100, 101],
      [102, 103],
      [103, 110],
    ]);
    const r = runRule(ds, above100, { amount: 204 })!;
    expect(r.start).toBe(1);
    expect(r.hold[0]).toBe(204);
    expect(r.hold.at(-1)).toBeCloseTo(204 + 2 * (110 - 102) - 0.1, 6);
    expect(r.holdStats.total).toBeCloseTo(16 - 0.1, 6);
  });

  it('las reglas de siempre: la ruptura compra tras un máximo de 20 días y sale bajo el mínimo de 10', () => {
    // 25 días planos en 100, sube a 110 (ruptura), sigue subiendo y después cae bajo el mínimo de 10 días.
    const closes = [...new Array(25).fill(100), 110, 112, 114, 116, 118, 120, 121, 122, 123, 124, 125, 90, 88];
    const ds = days('2025-01-06', closes.map((c, i) => [i ? closes[i - 1]! : c, c]));
    const r = runRule(ds, 'ruptura', { amount: 200 })!;
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entry: ds[26]!.date, why: 'regla', exit: ds[37]!.date });
    // Todas las reglas publicadas corren sobre la misma serie sin romperse.
    for (const key of Object.keys(RULES)) expect(runRule(ds, key, { events: [ds[20]!.date] }), key).not.toBeUndefined();
  });

  it('una señal es un hecho de un día: tras un stop, el cruce de medias no vuelve a comprar hasta que se dé otro cruce', () => {
    // 60 días planos, 11 de subida (la media de 20 pasa sobre la de 50 el primero), una caída fuerte y días planos abajo.
    const closes = [...new Array(60).fill(100), 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 90, 91, ...new Array(8).fill(92)];
    const ds = days('2025-01-06', closes.map((c, i) => [i ? closes[i - 1]! : c, c]));
    const r = runRule(ds, 'ma20-50', { amount: 200, stopPct: 5 })!;
    // Cruza con el cierre del día 60: compra en la apertura del 61. El cierre del 71 (90) queda más de 5 % abajo: stop.
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entry: ds[61]!.date, entryPrice: 101, why: 'stop', exit: ds[72]!.date, exitPrice: 90 });
    // El día de la venta la media rápida seguía sobre la lenta: una regla «de estado» habría vuelto a comprar.
    expect(sma(closes, 20)[72]!).toBeGreaterThan(sma(closes, 50)[72]!);
    // Sin stop, sale cuando la rápida vuelve a quedar debajo de la lenta.
    const plain = runRule(ds, 'ma20-50', { amount: 200 })!;
    expect(plain.trades).toHaveLength(1);
    expect(plain.trades[0]).toMatchObject({ entry: ds[61]!.date, why: 'regla' });
    // El RSI compra el día en que baja de 30, no todos los días que sigue abajo.
    const fall = [...new Array(20).fill(100), 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88];
    const rs = runRule(days('2025-01-06', fall.map((c, i) => [i ? fall[i - 1]! : c, c])), 'rsi', { amount: 200, maxDays: 2 })!;
    expect(rs.trades).toHaveLength(1);
    expect(rs.trades[0]).toMatchObject({ why: 'tiempo' });
  });

  it('sin comisiones (cripto y divisas): ni al comprar, ni al vender, ni en «solo mantener»', () => {
    const ds = days('2025-03-03', [
      [99, 101],
      [102, 104],
      [104, 99],
      [98, 97],
    ]);
    const r = runRule(ds, above100, { amount: 204, fees: false })!;
    expect(r.trades[0]).toMatchObject({ fees: 0, gross: -8, pnl: -8 });
    expect(r.stats.fees).toBe(0);
    expect(r.hold.at(-1)).toBeCloseTo(204 + 2 * (97 - 102), 6);
  });

  it('por año y rachas: cada operación cuenta en el año en que salió', () => {
    const bars: [number, number][] = [];
    for (let k = 0; k < 6; k++) bars.push([99, 101], [102, 105], [105, 99], [98, 98]);
    const r = runRule(days('2025-12-01', bars), above100, { amount: 204 })!;
    expect(r.stats.trades).toBe(6);
    expect(r.stats.byYear.map((y) => y.year)).toEqual(['2025', '2026']);
    expect(r.stats.byYear.reduce((s, y) => s + y.trades, 0)).toBe(6);
    expect(r.stats.byYear.reduce((s, y) => s + y.pnl, 0)).toBeCloseTo(r.stats.total, 6);
    // Compra a 102 y vende a 98: todas pierden.
    expect(r.stats).toMatchObject({ winRate: 0, worstStreak: 6, avgWin: null });
    expect(r.stats.avgLoss).toBeLessThan(0);
  });
});

describe('frente al azar', () => {
  /** Un diente de sierra: sube tres días y cae uno. Comprar justo antes de cada subida es lo mejor posible. */
  const saw = () => {
    const bars: [number, number][] = [];
    for (let k = 0; k < 40; k++) bars.push([100, 100], [100, 104], [104, 108], [108, 100]);
    return days('2024-01-02', bars);
  };
  /** Compra al cierre plano (día 0 de cada ciclo) y vende tras el segundo cierre alto: se queda con toda la subida. */
  const perfect = (ds: Day[]) => ({ warmup: 0, enter: (i: number) => i % 4 === 0, exit: (i: number) => i % 4 === 2 });

  it('una regla que siempre acierta le gana a casi todas las entradas al azar; la misma semilla da lo mismo', () => {
    const ds = saw();
    const r = runRule(ds, perfect, { amount: 200 })!;
    expect(r.stats.trades).toBeGreaterThan(30);
    expect(r.stats.winRate).toBe(1);
    const a = randomBaseline(ds, r, { runs: 300, seed: 7 })!;
    expect(a.beats).toBeGreaterThan(0.99);
    expect(a.low).toBeLessThanOrEqual(a.median);
    expect(a.median).toBeLessThanOrEqual(a.high);
    expect(randomBaseline(ds, r, { runs: 300, seed: 7 })).toEqual(a);
    expect(seedOf('SCCO|ruptura')).toBe(seedOf('SCCO|ruptura'));
    expect(seedOf('SCCO|ruptura')).not.toBe(seedOf('SCCO|rsi'));
    const rand = seeded(1);
    expect(rand()).not.toBe(rand());
  });

  it('con menos de 5 operaciones no se compara: no diría nada', () => {
    const ds = saw().slice(0, 12);
    const r = runRule(ds, perfect, { amount: 200 })!;
    expect(r.stats.trades).toBeLessThan(5);
    expect(randomBaseline(ds, r)).toBeNull();
  });
});

describe('después de resultados', () => {
  const points: [string, number][] = [
    ['2026-01-26', 100],
    ['2026-01-27', 100], // reporte después del cierre de este día
    ['2026-01-28', 110],
    ['2026-01-29', 111],
    ['2026-01-30', 112],
    ['2026-02-02', 113],
    ['2026-02-03', 120],
    ['2026-02-04', 121],
  ];

  it('la reacción va del último cierre antes de la fecha al primero después de ella', () => {
    // Fecha en día hábil (27 ene): del 26 al 28. Así entra tanto si salió antes de la apertura como después del cierre.
    expect(reactions(points, ['2026-01-27'])).toEqual([{ date: '2026-01-27', before: 0, at: 2, reaction: 0.1 }].map((e) => ({ ...e, reaction: expect.closeTo(e.reaction, 6) })));
    // Fecha en fin de semana (31 ene): del viernes 30 al lunes 2.
    expect(reactions(points, ['2026-01-31'])[0]).toMatchObject({ before: 4, at: 5 });
    // Una corrección del mismo reporte a los pocos días cuenta una sola vez; sin días antes o después, no se cuenta.
    expect(reactions(points, ['2026-01-27', '2026-01-29'])).toHaveLength(1);
    expect(reactions(points, ['2026-01-26', '2026-02-04'])).toEqual([]);
  });

  it('el estudio: reacción, lo que siguió después y el resumen separando las buenas de las malas', () => {
    const bench: [string, number][] = points.map(([d], i) => [d, 100 + i]);
    const s = eventStudy(points, ['2026-01-27'], { horizons: [2, 5, 20], bench });
    expect(s.rows).toHaveLength(1);
    const row = s.rows[0]!;
    expect(row).toMatchObject({ date: '2026-01-27', day: '2026-01-28' });
    expect(row.reaction).toBeCloseTo(0.1, 6);
    expect(row.after[2]).toBeCloseTo(112 / 110 - 1, 6);
    expect(row.after[5]).toBeCloseTo(121 / 110 - 1, 6);
    expect(row.after[20]).toBeNull(); // todavía no pasaron 20 días
    // Frente al mercado: se le resta lo que hizo el SPY en los mismos días.
    expect(row.reactionX).toBeCloseTo(0.1 - (102 / 100 - 1), 6);
    expect(row.afterX[2]).toBeCloseTo(112 / 110 - 1 - (104 / 102 - 1), 6);
    expect(s.summary).toMatchObject({ n: 1, up: 1, good: { n: 1, 2: { n: 1, up: 1 }, 20: { n: 0, up: 0, mean: null } }, bad: { n: 0 } });
    expect(s.summary!.meanAbs).toBeCloseTo(0.1, 6);
    // El mismo resumen descontando el mercado: la reacción sigue siendo buena, pero lo que siguió (+1,8 % en 2 días)
    // fue menos que el SPY (+2,0 %): ya no cuenta como subida.
    expect(s.summaryX).toMatchObject({ n: 1, up: 1, good: { n: 1, 2: { n: 1, up: 0 } }, bad: { n: 0 } });
    expect(s.summaryX!.meanAbs).toBeCloseTo(0.1 - 0.02, 6);
    expect(s.summaryX!.good[2].mean).toBeCloseTo(112 / 110 - 1 - (104 / 102 - 1), 6);
    // Sin el SPY no hay resumen descontado; si al SPY le faltan esos días, el reporte no entra en él.
    expect(eventStudy(points, ['2026-01-27']).summaryX).toBeNull();
    expect(eventStudy(points, ['2026-01-27'], { bench: bench.slice(3) }).summaryX).toBeNull();
    expect(eventStudy(points, []).summary).toBeNull();
  });

  it('la regla «después de resultados» compra tras una buena reacción y mantiene 20 días', () => {
    const closes = [100, 100, 110, ...new Array(30).fill(111)];
    const ds = days('2026-01-26', closes.map((c, i) => [i ? closes[i - 1]! : c, c]));
    const r = runRule(ds, 'resultados', { amount: 200, events: [ds[1]!.date] })!;
    expect(r.trades).toHaveLength(1);
    // La reacción se conoce al cierre del día 2: compra en la apertura del 3 y vende tras 20 cierres.
    expect(r.trades[0]).toMatchObject({ entry: ds[3]!.date, why: 'regla', days: EARNINGS_HOLD });
    // Una reacción mala (o chica) no compra.
    expect(runRule(ds, 'resultados', { amount: 200, events: [ds[10]!.date] })!.trades).toHaveLength(0);
  });
});
