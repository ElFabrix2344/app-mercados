import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { DosTercios, scoreWeek, weekClose } from '../src/game/dos-tercios';
import { Grafico, pickPuzzle, shape } from '../src/game/grafico';
import { weekOf } from '../src/game/juego';
import { JuegoDO } from '../src/game/juego-do';
import { Liga, START_SOLES, latestCommon } from '../src/game/liga';
import type { ChartSeries, LeaguePrices, SeriesPoint } from '../src/game/series';
import { addDays } from '../src/lib/num';
import worker from '../src/index';
import { memoryKV, memoryStorage } from './helpers';

const aliases = new Map([
  ['p-ana', 'Ana'],
  ['p-beto', 'Beto'],
  ['p-caro', 'Caro'],
]);
const at = (iso: string) => new Date(iso);

describe('2/3 del promedio', () => {
  it('gana quien queda más cerca de 2/3 del promedio; puede haber empate', () => {
    const r = scoreWeek(1, [
      { pid: 'a', value: 30 },
      { pid: 'b', value: 60 },
      { pid: 'c', value: 20 },
    ]);
    expect(r).toMatchObject({ avg: 36.67, target: 24.44, winners: ['c'] });
    expect(scoreWeek(1, [{ pid: 'a', value: 0 }, { pid: 'b', value: 0 }]).winners).toEqual(['a', 'b']);
    expect(scoreWeek(1, [{ pid: 'a', value: 50 }])).toMatchObject({ avg: null, winners: [] }); // solo no se juega
  });

  it('cierra el lunes a la medianoche de Lima', () => {
    const now = at('2026-11-04T15:00:00Z'); // miércoles
    expect(weekClose(weekOf(now))).toBe('2026-11-09T05:00:00.000Z');
  });

  it('cada uno elige (y puede cambiar) en la semana; al cerrar se ve todo y se cuentan las victorias', async () => {
    const store = memoryStorage();
    const game = new DosTercios(store);
    const mon = at('2026-11-02T15:00:00Z');
    await game.pick('p-ana', { value: 40 }, mon);
    await game.pick('p-ana', { value: 30 }, mon);
    await game.pick('p-beto', { value: '60' }, mon);
    await game.pick('p-caro', { value: 20 }, mon);
    for (const bad of [101, -1, 2.5, 'x', null]) await expect(game.pick('p-ana', { value: bad }, mon)).rejects.toThrow(/entero del 0 al 100/);
    const open = await game.view('p-ana', mon, aliases);
    expect(open).toMatchObject({ count: 3, mine: 30, last: null });

    const next = at('2026-11-09T15:00:00Z');
    await game.settle(next);
    const v = await game.view('p-ana', next, aliases);
    expect(v).toMatchObject({ count: 0, mine: null });
    expect(v.last).toMatchObject({ avg: 36.67, target: 24.44, winners: ['Caro'] });
    expect(v.last!.picks.map((p) => `${p.alias} ${p.value}`)).toEqual(['Caro 20', 'Ana 30', 'Beto 60']);
    expect(v.wins).toEqual([{ alias: 'Caro', wins: 1, mine: false }]);
    expect([...store.data.keys()].filter((k) => k.startsWith('k23:'))).toEqual([]); // los números sueltos se borran
  });
});

/** Una serie diaria (lunes a viernes) de `from` a `to`, con el valor que da `f` para cada día. */
function daily(from: string, to: string, f: (i: number, d: string) => number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let d = from, i = 0; d <= to; d = addDays(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push({ d, v: f(i++, d) });
  }
  return out;
}

const catalog: ChartSeries[] = [
  { id: 'cobre', name: 'Cobre', points: daily('2026-01-01', '2026-03-31', (i) => 4 + Math.sin(i / 5)) },
  { id: 'oro', name: 'Oro', points: daily('2026-01-01', '2026-03-31', (i) => 2000 + i * 3) },
  { id: 'bvl', name: 'Bolsa de Lima', points: daily('2026-01-01', '2026-03-31', (i) => 1000 - i) },
  { id: 'dolar', name: 'Dólar', points: daily('2026-01-01', '2026-03-31', (i) => 3.7 + (i % 7) / 100) },
  { id: 'tasa', name: 'Tasa del BCRP', points: daily('2026-01-01', '2026-03-31', () => 4.25) }, // quieta: no entra
];

describe('gráfico del día', () => {
  it('elige la serie con la fecha: siempre la misma ese día, sin repetir la de ayer y sin series quietas', () => {
    const a = pickPuzzle('2026-11-02', catalog, null)!;
    expect(pickPuzzle('2026-11-02', catalog, null)).toEqual(a);
    expect(a.options).toHaveLength(4);
    expect(a.options).toContain(a.answer);
    expect(a.options).not.toContain('tasa');
    expect(pickPuzzle('2026-11-02', catalog, a.answer)!.answer).not.toBe(a.answer);
    expect(pickPuzzle('2026-11-02', catalog.slice(0, 3), null)).toBeNull();
    expect(shape([5, 10, 7.5])).toEqual([0, 100, 50]);
  });

  it('una respuesta por día; la racha sigue si aciertas días seguidos y se corta si fallas o faltas', async () => {
    const store = memoryStorage();
    const game = new Grafico(store);
    const play = async (date: string, right: boolean) => {
      const v = await game.view('p-ana', date, catalog, aliases);
      const p = (await store.get<{ answer: string; options: string[] }>(`gd:${date}`))!;
      await game.answer('p-ana', { option: right ? p.answer : p.options.find((o) => o !== p.answer) }, date, at(`${date}T15:00:00Z`), catalog);
      return v;
    };
    const before = await play('2026-11-02', true);
    expect(before.answer).toBeNull(); // antes de responder no se sabe cuál es
    expect(before.points.length).toBeGreaterThan(10);
    expect(Math.max(...before.points)).toBe(100);
    await expect(game.answer('p-ana', { option: 'oro' }, '2026-11-02', at('2026-11-02T16:00:00Z'), catalog)).rejects.toThrow(/Ya respondiste/);
    await play('2026-11-03', true);
    let v = await game.view('p-ana', '2026-11-03', catalog, aliases);
    expect(v.me).toMatchObject({ played: 2, correct: 2, streak: 2, best: 2 });
    expect(v.mine?.correct).toBe(true);
    expect(v.answer?.name).toEqual(expect.any(String));
    expect(v.top).toEqual([{ alias: 'Ana', streak: 2, best: 2, mine: true }]);
    // Faltar un día corta la racha (aunque la mejor se guarda).
    v = await game.view('p-ana', '2026-11-05', catalog, aliases);
    expect(v.me).toMatchObject({ streak: 0, best: 2 });
    await play('2026-11-05', false);
    v = await game.view('p-ana', '2026-11-06', catalog, aliases);
    expect(v.me).toMatchObject({ played: 3, correct: 2, streak: 0, best: 2 });
    expect(v.yesterday).toMatchObject({ played: 1, correct: 0 });
    await expect(game.answer('p-ana', { option: 'nada' }, '2026-11-06', at('2026-11-06T15:00:00Z'), catalog)).rejects.toThrow(/cuatro opciones/);
  });
});

// Precios de prueba: el dólar quieto en 3,50; el oro sube 1 por día hábil; el cobre quieto; la bolsa baja 1 por día.
const prices: LeaguePrices = {
  dolar: daily('2026-09-01', '2026-11-05', () => 3.5),
  oro: daily('2026-09-01', '2026-11-05', (i) => 2000 + i),
  cobre: daily('2026-09-01', '2026-11-05', () => 4),
  bvl: daily('2026-09-01', '2026-11-05', (i) => 1000 - i),
  tasa: 3.65,
};
const priceOf = (s: SeriesPoint[], d: string) => s.find((p) => p.d === d)!.v;

describe('liga de carteras', () => {
  it('una compra se cumple con el cierre del día hábil siguiente, no con el último precio publicado', async () => {
    const store = memoryStorage();
    const liga = new Liga(store);
    // El martes 13 de octubre ya está el precio de ese día, pero la compra se hace con el del miércoles 14.
    await liga.order('p-ana', { action: 'comprar', asset: 'oro', soles: 3500 }, at('2026-10-13T20:00:00Z'));
    const m = { ...prices, oro: prices.oro.filter((p) => p.d <= '2026-10-13'), dolar: prices.dolar.filter((p) => p.d <= '2026-10-13') };
    await liga.settle(at('2026-10-13T21:00:00Z'), m);
    let v = await liga.view('p-ana', at('2026-10-13T21:00:00Z'), m, aliases);
    expect(v.me?.orders).toHaveLength(1); // todavía esperando
    expect(v.me?.positions).toEqual([]);
    await liga.settle(at('2026-10-15T15:00:00Z'), prices);
    v = await liga.view('p-ana', at('2026-10-15T15:00:00Z'), prices, aliases);
    const units = 3500 / (priceOf(prices.oro, '2026-10-14') * 3.5);
    expect(v.me?.orders).toEqual([]);
    expect(v.me?.positions[0]).toMatchObject({ asset: 'oro' });
    expect(v.me!.positions[0]!.value).toBeCloseTo(units * priceOf(prices.oro, '2026-11-05') * 3.5, 1);
    expect(v.me!.positions[0]!.ret).toBeGreaterThan(0); // el oro subió
  });

  it('valida las órdenes: no más de lo que tienes, nada que vender, y se pueden cancelar', async () => {
    const liga = new Liga(memoryStorage());
    const now = at('2026-11-02T15:00:00Z');
    await expect(liga.order('p-ana', { action: 'comprar', asset: 'oro', soles: START_SOLES + 1 }, now)).rejects.toThrow(/Te quedan/);
    await liga.order('p-ana', { action: 'comprar', asset: 'oro', soles: 6000 }, now);
    await expect(liga.order('p-ana', { action: 'comprar', asset: 'cobre', soles: 4500 }, now)).rejects.toThrow(/Te quedan S\/ 4000/);
    await expect(liga.order('p-ana', { action: 'vender', asset: 'bvl' }, now)).rejects.toThrow(/No tienes bolsa de lima/);
    await expect(liga.order('p-ana', { action: 'comprar', asset: 'bitcoin', soles: 5 }, now)).rejects.toThrow(/Elige qué/);
    await liga.order('p-ana', { action: 'cancelar', cancel: 1 }, now);
    const v = await liga.view('p-ana', now, prices, aliases);
    expect(v.me?.orders).toEqual([]);
    // Sin invertir, los soles rinden la tasa del BCRP: 3 días al 3,65 % anual.
    expect(v.me?.cash).toBeCloseTo(START_SOLES * (1 + 0.0365 * (3 / 365)), 2);
  });

  it('el mes lo gana quien más rindió; el arranque de cada mes es el valor al último día del anterior', async () => {
    const store = memoryStorage();
    const liga = new Liga(store);
    const oct = at('2026-10-05T15:00:00Z');
    await liga.order('p-ana', { action: 'comprar', asset: 'oro', soles: 10000 }, oct); // el oro sube
    await liga.order('p-beto', { action: 'comprar', asset: 'bvl', soles: 10000 }, oct); // la bolsa baja
    await liga.order('p-caro', { action: 'comprar', asset: 'cobre', soles: 1 }, oct); // casi todo en soles
    await liga.settle(at('2026-10-20T15:00:00Z'), prices);
    const nov = at('2026-11-04T15:00:00Z');
    await liga.settle(nov, prices);
    const v = await liga.view('p-beto', nov, prices, aliases);
    expect(v.last).toMatchObject({ month: '2026-10', champion: 'Ana' });
    expect(v.titles).toEqual([{ alias: 'Ana', titles: 1, mine: false }]);
    expect(v.standings.map((s) => s.alias)).toEqual(['Ana', 'Caro', 'Beto']);
    expect(v.assets.find((a) => a.id === 'bvl')!.ret).toBeLessThan(0);
    expect(v.assets.find((a) => a.id === 'soles')!.ret).toBeGreaterThan(0);
    // Vender todo devuelve los soles al cierre siguiente.
    await liga.order('p-beto', { action: 'vender', asset: 'bvl' }, at('2026-11-03T15:00:00Z'));
    await liga.settle(nov, prices);
    const after = await liga.view('p-beto', nov, prices, aliases);
    expect(after.me?.positions).toEqual([]);
    expect(after.me!.cash).toBeLessThan(START_SOLES);
    expect(latestCommon(prices)).toBe('2026-11-05');
  });
});

describe('rutas de los otros juegos (local, con datos de prueba)', () => {
  it('se ven los tres juegos; sin nombre no se juega; con nombre se elige, se responde y se compra', async () => {
    const env = {
      CACHE: memoryKV().kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      MOCK_DATA: 'true',
      DEV_ROLE: 'friend',
    } as unknown as Env;
    const instance = new JuegoDO({ storage: memoryStorage() } as unknown as DurableObjectState, env);
    (env as { JUEGO?: unknown }).JUEGO = { idFromName: () => 'grupo', get: () => instance };
    const call = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
        env,
        {} as ExecutionContext,
      );
    const first = (await (await call('GET', '/api/games')).json()) as any;
    expect(first.alias).toBeNull();
    expect(first.dosTercios.last.winners).toEqual(['Caro']); // ejemplo: semana pasada
    expect(first.grafico.available).toBe(true);
    expect(first.liga.standings.length).toBeGreaterThan(0);
    expect((await call('POST', '/api/games/dos-tercios', { value: 10 })).status).toBe(400);

    await call('PUT', '/api/forecasts/name', { alias: 'Dani' });
    const k = (await (await call('POST', '/api/games/dos-tercios', { value: 17 })).json()) as any;
    expect(k.dosTercios.mine).toBe(17);
    const g = (await (await call('POST', '/api/games/grafico', { option: first.grafico.options[0].id })).json()) as any;
    expect(g.grafico.answer).not.toBeNull();
    const l = (await (await call('POST', '/api/games/liga', { action: 'comprar', asset: 'oro', soles: 2500 })).json()) as any;
    expect(l.liga.me.orders).toHaveLength(1);
    expect((await call('POST', '/api/games/liga', { action: 'vender', asset: 'cobre' })).status).toBe(400);
    expect((await call('GET', '/api/games/otra')).status).toBe(404);
  });
});
