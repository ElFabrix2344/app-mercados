import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { JuegoDO } from '../src/game/juego-do';
import { Juego, MAX_PENDING, PAYOUT, START_CHIPS, WEEKLY_CHIPS, reply, weekOf, type Who } from '../src/game/juego';
import { questionsAt } from '../src/lib/forecasts';
import { ApiError } from '../src/lib/http';
import worker from '../src/index';
import { memoryKV, memoryStorage } from './helpers';

const now = new Date('2026-11-02T15:00:00Z'); // lunes
const dueño: Who = { pid: 'p-yo', alias: 'Fabri', owner: true };
const ana: Who = { pid: 'p-ana', alias: 'Ana', owner: false };
const beto: Who = { pid: 'p-beto', alias: 'Beto', owner: false };
const later = (days: number) => new Date(now.getTime() + days * 86_400_000);
const manual = (over: Record<string, unknown> = {}) => ({
  question: '¿Gana la lista A el centro de estudiantes?',
  category: 'universidad',
  closesOn: '2026-11-20',
  details: 'Sí si el comité electoral la proclama ganadora.',
  ...over,
});

/** Un mercado con una pregunta abierta (la propone el dueño) y el id de esa pregunta. */
async function withMarket() {
  const game = new Juego(memoryStorage());
  const v = await game.propose(dueño, manual(), now, {});
  return { game, id: v.markets[0]!.id };
}

describe('mercado de predicciones', () => {
  it('cada uno entra con sus fichas al tener nombre; sin nombre no se juega', async () => {
    const game = new Juego(memoryStorage());
    expect((await game.view({ pid: 'p-x', alias: null, owner: false }, now, {})).me).toEqual({ alias: null, chips: null, value: null });
    const v = await game.view(ana, now, {});
    expect(v.me).toEqual({ alias: 'Ana', chips: START_CHIPS, value: START_CHIPS });
    await expect(game.propose({ pid: 'p-x', alias: null, owner: false }, manual(), now, {})).rejects.toThrow(/elige tu nombre/);
  });

  it('una propuesta de un amigo espera al dueño; el dueño la aprueba y abre al 50 %', async () => {
    const game = new Juego(memoryStorage());
    const mine = await game.propose(ana, manual(), now, {});
    expect(mine.markets).toEqual([]);
    expect(mine.proposals).toMatchObject([{ state: 'propuesta', proposer: null }]);
    const id = mine.proposals[0]!.id;
    expect((await game.view(beto, now, {})).proposals).toEqual([]); // los demás no la ven
    expect((await game.view(dueño, now, {})).proposals).toMatchObject([{ id, proposer: 'Ana' }]);
    await expect(game.review(ana, { id, approve: true }, now, {})).rejects.toThrow(/Solo el dueño/);
    const open = await game.review(dueño, { id, approve: true }, now, {});
    expect(open.markets).toMatchObject([{ id, state: 'abierta', price: 0.5 }]);
    expect(open.proposals).toEqual([]);
  });

  it('valida las propuestas y limita las que esperan aprobación', async () => {
    const game = new Juego(memoryStorage());
    await expect(game.propose(ana, manual({ question: '¿Corto?' }), now, {})).rejects.toThrow(/La pregunta/);
    await expect(game.propose(ana, manual({ category: 'farándula' }), now, {})).rejects.toThrow(/categoría/);
    await expect(game.propose(ana, manual({ closesOn: '2026-11-02' }), now, {})).rejects.toThrow(/fecha de cierre/);
    await expect(game.propose(ana, manual({ closesOn: '2028-01-01' }), now, {})).rejects.toThrow(/fecha de cierre/);
    await expect(game.propose(ana, manual({ details: 'corto' }), now, {})).rejects.toThrow(/Cómo se resuelve/);
    for (let i = 0; i < MAX_PENDING; i++) await game.propose(ana, manual(), now, {});
    await expect(game.propose(ana, manual(), now, {})).rejects.toThrow(/esperando aprobación/);
    // Se puede comprar hasta las 23:59 de Lima del día de cierre.
    const v = await game.view(dueño, now, {});
    expect(v.proposals[0]!.closesAt).toBe('2026-11-21T04:59:00.000Z');
  });

  it('comprar sube el precio y cuesta fichas; vender devuelve lo que vale hoy', async () => {
    const { game, id } = await withMarket();
    const v = await game.trade(ana, { id, side: 'si', action: 'comprar', chips: 200 }, now, {});
    const m = v.markets[0]!;
    expect(v.me.chips).toBe(START_CHIPS - 200);
    expect(m.price).toBeGreaterThan(0.6);
    expect(m.mine).toMatchObject({ spent: 200 });
    expect(m.mine!.yes).toBeGreaterThan(2); // a menos de 100 cada una
    expect(m.traders).toBe(1);
    // Beto compra No: baja el precio de Sí, y lo de Ana vale menos que lo que pagó.
    await game.trade(beto, { id, side: 'no', action: 'comprar', chips: 300 }, now, {});
    const sold = await game.trade(ana, { id, side: 'si', action: 'vender' }, now, {});
    expect(sold.me.chips).toBeLessThan(START_CHIPS);
    expect(sold.markets[0]!.mine).toMatchObject({ yes: 0 });
    await expect(game.trade(ana, { id, side: 'si', action: 'vender' }, now, {})).rejects.toThrow(/No tienes/);
    await expect(game.trade(ana, { id, side: 'si', action: 'comprar', chips: 5000 }, now, {})).rejects.toThrow(/Te alcanzan/);
    await expect(game.trade(ana, { id, side: 'tal vez', action: 'comprar', chips: 5 }, now, {})).rejects.toThrow(/Sí o No/);
    await expect(game.trade(ana, { id, side: 'si', action: 'comprar', chips: 5 }, later(30), {})).rejects.toThrow(/ya cerró/);
  });

  it('al resolver, cada acción ganadora paga 100; al anular, se devuelve lo puesto', async () => {
    const { game, id } = await withMarket();
    const a = await game.trade(ana, { id, side: 'si', action: 'comprar', chips: 100 }, now, {});
    const shares = a.markets[0]!.mine!.yes;
    await game.trade(beto, { id, side: 'no', action: 'comprar', chips: 100 }, now, {});
    await expect(game.resolve(ana, { id, outcome: 'si' }, now, {})).rejects.toThrow(/Solo el dueño/);
    await expect(game.resolve(dueño, { id, outcome: 'si', source: 'javascript:alert(1)' }, now, {})).rejects.toThrow(/https/);
    const done = await game.resolve(dueño, { id, outcome: 'si', source: 'https://example.com/acta' }, later(20), {});
    expect(done.markets[0]).toMatchObject({ state: 'resuelta', outcome: 'si', source: 'https://example.com/acta' });
    expect((await game.view(ana, later(20), {})).me.chips).toBeCloseTo(START_CHIPS - 100 + shares * PAYOUT + 2 * WEEKLY_CHIPS, 1);
    expect((await game.view(beto, later(20), {})).me.chips).toBeCloseTo(START_CHIPS - 100 + 2 * WEEKLY_CHIPS, 1);

    const other = await withMarket();
    await other.game.trade(ana, { id: other.id, side: 'no', action: 'comprar', chips: 250 }, now, {});
    await other.game.resolve(dueño, { id: other.id, outcome: 'anular' }, now, {});
    expect((await other.game.view(ana, now, {})).me.chips).toBe(START_CHIPS);
  });

  it('cada lunes llegan 100 fichas, también a quien no entró esa semana', async () => {
    const game = new Juego(memoryStorage());
    await game.view(ana, now, {});
    expect(weekOf(later(6))).toBe(weekOf(now)); // domingo: la misma semana
    expect((await game.view(ana, later(6), {})).me.chips).toBe(START_CHIPS);
    expect((await game.view(beto, later(14), {})).me.chips).toBe(START_CHIPS); // Beto recién entra
    expect((await game.view(ana, later(14), {})).me.chips).toBe(START_CHIPS + 2 * WEEKLY_CHIPS);
  });

  it('una pregunta ligada a un dato del juego de pronósticos se resuelve sola cuando sale', async () => {
    const q = questionsAt(now).find((x) => x.kind === 'bcrp' && Date.parse(x.closesAt) > now.getTime())!;
    expect(q).toBeDefined();
    const game = new Juego(memoryStorage());
    await expect(game.propose(ana, { question: '¿El BCRP baja su tasa?', category: 'economia', auto: { qid: q.id, value: 'baja' } }, now, {})).rejects.toThrow(/Solo el dueño/);
    const v = await game.propose(dueño, { question: '¿El BCRP baja su tasa?', category: 'economia', auto: { qid: q.id, value: 'baja' } }, now, {});
    const m = v.markets[0]!;
    expect(m.closesAt).toBe(q.closesAt);
    expect(m.auto).toContain('Sí si');
    const a = await game.trade(ana, { id: m.id, side: 'si', action: 'comprar', chips: 100 }, now, {});
    const shares = a.markets[0]!.mine!.yes;
    const after = await game.view(ana, now, { [q.id]: { value: 'baja', at: now.toISOString() } });
    expect(after.markets[0]).toMatchObject({ state: 'resuelta', outcome: 'si' });
    expect(after.me.chips).toBeCloseTo(START_CHIPS - 100 + shares * PAYOUT, 1);
  });

  it('el ranking va por fichas totales, con las acciones a lo que se recibiría al venderlas hoy', async () => {
    const { game, id } = await withMarket();
    // Comprar mucho de un lado empuja el precio, pero no infla las fichas: venderlo todo devuelve lo pagado.
    const a = await game.trade(ana, { id, side: 'si', action: 'comprar', chips: 900 }, now, {});
    expect(a.markets[0]!.price).toBeGreaterThan(0.9);
    expect(a.me.value).toBeCloseTo(START_CHIPS, 6);
    // Beto compra No después: el Sí de Ana pierde valor.
    await game.trade(beto, { id, side: 'no', action: 'comprar', chips: 50 }, now, {});
    const v = await game.view(dueño, now, {});
    expect(v.ranking.map((r) => r.alias)).toEqual(['Beto', 'Fabri', 'Ana']);
    expect(v.ranking.find((r) => r.mine)?.alias).toBe('Fabri');
    expect(v.ranking[2]!.value).toBeLessThan(START_CHIPS);
  });

  it('los errores del juego viajan como datos al Worker', async () => {
    expect(await reply(async () => Promise.reject(new ApiError('bad_request', 400, 'mal')))).toEqual({ error: { status: 400, message: 'mal' } });
  });
});

describe('rutas del mercado (local, como el dueño y como amigo)', () => {
  const setup = (role?: string) => {
    const kv = memoryKV().kv;
    const env = {
      CACHE: kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      DEV_ROLE: role,
    } as unknown as Env;
    const instance = new JuegoDO({ storage: memoryStorage() } as unknown as DurableObjectState, env);
    (env as { JUEGO?: unknown }).JUEGO = { idFromName: () => 'grupo', get: () => instance };
    const call = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
        env,
        {} as ExecutionContext,
      );
    return { call };
  };

  it('con el nombre del juego de pronósticos se juega; un amigo propone y no puede aprobar ni resolver', async () => {
    const { call } = setup('friend');
    expect(((await (await call('GET', '/api/predictions')).json()) as any).me.chips).toBeNull();
    await call('PUT', '/api/forecasts/name', { alias: 'Caro' });
    const v = (await (await call('GET', '/api/predictions')).json()) as any;
    expect(v.me).toMatchObject({ alias: 'Caro', chips: START_CHIPS });
    const p = (await (await call('POST', '/api/predictions', manual())).json()) as any;
    expect(p.proposals[0].state).toBe('propuesta');
    const review = await call('POST', '/api/predictions/review', { id: p.proposals[0].id, approve: true });
    expect(review.status).toBe(403);
    expect(await review.text()).toContain('Solo el dueño');
    expect((await call('POST', '/api/predictions/resolve', { id: 1, outcome: 'si' })).status).toBe(403);
    expect((await call('GET', '/api/predictions/otra')).status).toBe(404);
  });

  it('el dueño abre una pregunta y compra', async () => {
    const { call } = setup();
    await call('PUT', '/api/forecasts/name', { alias: 'Fabri' });
    const open = (await (await call('POST', '/api/predictions', manual())).json()) as any;
    const id = open.markets[0].id;
    const t = await call('POST', '/api/predictions/trade', { id, side: 'no', action: 'comprar', chips: 120 });
    expect(t.status).toBe(200);
    expect(((await t.json()) as any).me.chips).toBe(START_CHIPS - 120);
    expect((await call('POST', '/api/predictions/trade', { id, side: 'no', action: 'comprar', chips: 0 })).status).toBe(400);
  });
});
