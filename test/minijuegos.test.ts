import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { DosTercios, scoreWeek, weekClose } from '../src/game/dos-tercios';
import { Grafico, pickPuzzle, shape } from '../src/game/grafico';
import { weekOf } from '../src/game/juego';
import { JuegoDO } from '../src/game/juego-do';
import type { ChartSeries, SeriesPoint } from '../src/game/series';
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
    // Liga de acciones: sin clave no se compra; con la clave (de prueba, en local) sí. Un amigo no entra sin clave.
    expect((await call('POST', '/api/games/liga', { action: 'comprar', symbol: 'NVDA', usd: 2500 })).status).toBe(400);
    expect((await call('POST', '/api/games/liga', { action: 'entrar' })).status).toBe(403);
    expect((await call('POST', '/api/games/liga', { action: 'conectar', key: 'corta' })).status).toBe(400);
    const joined = (await (await call('POST', '/api/games/liga', { action: 'conectar', key: 'abcdef0123456789abcdef0123456789' })).json()) as any;
    expect(joined.liga.me).toMatchObject({ connected: true, cash: 10000 });
    const l = (await (await call('POST', '/api/games/liga', { action: 'comprar', symbol: 'nvda', usd: 2500 })).json()) as any;
    expect(l.liga.me.orders).toMatchObject([{ symbol: 'NVDA', usd: 2500 }]);
    expect((await call('POST', '/api/games/liga', { action: 'vender', symbol: 'AAPL' })).status).toBe(400);
    expect((await call('GET', '/api/games/otra')).status).toBe(404);
  });
});
