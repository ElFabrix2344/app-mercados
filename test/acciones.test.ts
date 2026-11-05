import { describe, expect, it } from 'vitest';
import { Acciones, BENCHMARK, seasonOf, seasonSessions, START_USD } from '../src/game/acciones';
import { nextCloseSession } from '../src/lib/market-hours';
import { seal, unseal } from '../src/lib/secretbox';
import { memoryStorage } from './helpers';

const SECRET = 's'.repeat(40);
const KEY_ANA = 'anakey0123456789anakey0123456789';
const KEY_BETO = 'betokey123456789betokey123456789';
const aliases = new Map([
  ['p-ana', 'Ana'],
  ['p-beto', 'Beto'],
]);

/**
 * Twelve Data de mentira: cierres fijos por símbolo y fecha (`book`), claves válidas (`keys`) y registro de pedidos.
 * Un símbolo que no está en el libro responde como Twelve Data a un símbolo que no existe.
 */
function twelve(book: Record<string, Record<string, number>>, keys = [KEY_ANA, KEY_BETO]) {
  const calls: { path: string; symbols: string[]; key: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('apikey ', '');
    const symbols = (url.searchParams.get('symbol') ?? '').split(',');
    calls.push({ path: url.pathname, symbols, key });
    if (!keys.includes(key)) return new Response(JSON.stringify({ status: 'error', code: 401, message: 'invalid key' }), { status: 401 });
    const one = (s: string) => {
      const days = book[s];
      if (!days) return { status: 'error', code: 404, message: 'symbol not found' };
      const dates = Object.keys(days).sort().reverse();
      return url.pathname === '/quote'
        ? { symbol: s, name: `${s} Inc.`, exchange: 'NASDAQ', currency: s === 'SHOP.TO' ? 'CAD' : 'USD', close: String(days[dates[0]!]) }
        : { meta: { symbol: s }, status: 'ok', values: dates.map((d) => ({ datetime: d, close: String(days[d]) })) };
    };
    const body = symbols.length === 1 ? one(symbols[0]!) : Object.fromEntries(symbols.map((s) => [s, one(s)]));
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

// Martes 3 y miércoles 4 de noviembre de 2026. El cierre de NY (16:00) es a las 21:00 UTC desde el 1 de noviembre.
const book = {
  SPY: { '2026-11-02': 600, '2026-11-03': 606, '2026-11-04': 612 },
  NVDA: { '2026-11-02': 200, '2026-11-03': 210, '2026-11-04': 220 },
  BAP: { '2026-11-02': 250, '2026-11-03': 245, '2026-11-04': 240 },
  'SHOP.TO': { '2026-11-03': 150 },
};

describe('claves de Twelve Data cifradas', () => {
  it('se guardan cifradas y solo se abren con el mismo secreto', async () => {
    const box = await seal(SECRET, KEY_ANA);
    expect(box.ct).not.toContain(KEY_ANA);
    expect(await unseal(SECRET, box)).toBe(KEY_ANA);
    await expect(unseal('x'.repeat(40), box)).rejects.toThrow();
    await expect(seal('corto', KEY_ANA)).rejects.toThrow(/LOGIN_LINK_SECRET/);
  });
});

describe('liga de acciones', () => {
  it('se entra conectando la clave propia (se prueba con el SPY); una clave mala no entra', async () => {
    const store = memoryStorage();
    const tw = twelve(book);
    const liga = new Acciones(store, { secret: SECRET, appKey: undefined, fetch: tw.f });
    await expect(liga.connect('p-ana', { key: 'no' }, new Date())).rejects.toThrow(/no parece una clave/);
    await expect(liga.connect('p-ana', { key: 'x'.repeat(32) }, new Date())).rejects.toThrow(/no aceptó esa clave/);
    await liga.connect('p-ana', { key: KEY_ANA }, new Date());
    expect(tw.calls.at(-1)).toMatchObject({ path: '/quote', symbols: [BENCHMARK], key: KEY_ANA });
    expect(JSON.stringify([...store.data.values()])).not.toContain(KEY_ANA); // la clave no queda a la vista
    const v = await liga.view('p-ana', new Date(), aliases);
    expect(v.me).toMatchObject({ connected: true, cash: START_USD, value: START_USD, holdings: [] });
    // El dueño entra con la clave de Rueda, sin pegar nada.
    const owner = new Acciones(store, { secret: SECRET, appKey: 'clave-de-rueda', fetch: tw.f });
    await owner.joinWithAppKey('p-yo', new Date());
    await expect(new Acciones(store, { secret: SECRET, appKey: undefined, fetch: tw.f }).joinWithAppKey('p-yo', new Date())).rejects.toThrow(/no tiene clave/);
  });

  it('las órdenes se cumplen al cierre de NY (antes del cierre, el de hoy; después, el del día siguiente)', () => {
    expect(nextCloseSession(new Date('2026-11-03T18:00:00Z'))).toBe('2026-11-03'); // 13:00 en NY
    expect(nextCloseSession(new Date('2026-11-03T21:30:00Z'))).toBe('2026-11-04'); // ya cerró
    expect(nextCloseSession(new Date('2026-11-07T15:00:00Z'))).toBe('2026-11-09'); // sábado → lunes
  });

  it('compra con su propia clave, valoriza al cierre y compite solo con porcentajes y símbolos', async () => {
    const store = memoryStorage();
    const tw = twelve(book);
    const liga = new Acciones(store, { secret: SECRET, appKey: undefined, fetch: tw.f });
    const morning = new Date('2026-11-03T15:00:00Z'); // 10:00 en NY
    await liga.connect('p-ana', { key: KEY_ANA }, morning);
    await liga.connect('p-beto', { key: KEY_BETO }, morning);
    await liga.order('p-ana', { action: 'comprar', symbol: 'nvda', usd: 4200 }, morning);
    await liga.order('p-beto', { action: 'comprar', symbol: 'BAP', usd: 4900 }, morning);
    await expect(liga.order('p-ana', { action: 'comprar', symbol: 'SHOP.TO', usd: 10 }, morning)).rejects.toThrow(/no cotiza en dólares/);
    await expect(liga.order('p-ana', { action: 'comprar', symbol: 'ZZZZ', usd: 10 }, morning)).rejects.toThrow(/No encontré ZZZZ/);
    await expect(liga.order('p-ana', { action: 'comprar', symbol: 'SPY', usd: 6000 }, morning)).rejects.toThrow(/Te quedan US\$ 5800/);
    await expect(liga.order('p-ana', { action: 'vender', symbol: 'BAP' }, morning)).rejects.toThrow(/No tienes BAP/);

    // Antes del cierre no pasa nada; después, cada uno trae sus cierres con su clave y se cumplen las órdenes.
    await liga.tick(new Date('2026-11-03T20:00:00Z'));
    expect((await liga.view('p-ana', morning, aliases)).me!.orders).toHaveLength(1);
    await liga.tick(new Date('2026-11-03T21:30:00Z'));
    const ticks = tw.calls.filter((c) => c.path === '/time_series');
    expect(ticks.find((c) => c.symbols.includes('NVDA'))!.key).toBe(KEY_ANA);
    expect(ticks.find((c) => c.symbols.includes('BAP'))!.key).toBe(KEY_BETO);
    const day1 = await liga.view('p-ana', new Date('2026-11-03T22:00:00Z'), aliases);
    expect(day1.me!.orders).toEqual([]);
    expect(day1.me!.holdings[0]).toMatchObject({ symbol: 'NVDA', shares: 20, value: 4200, ret: 0 }); // 4200 / 210
    expect(day1.me!.cash).toBe(5800);

    // Al día siguiente NVDA sube y BAP baja.
    await liga.tick(new Date('2026-11-04T21:30:00Z'));
    const v = await liga.view('p-beto', new Date('2026-11-04T22:00:00Z'), aliases);
    expect(v.standings.map((s) => s.alias)).toEqual(['Ana', 'Beto']);
    expect(v.standings[0]).toMatchObject({ symbols: ['NVDA'], mine: false });
    expect(v.standings[0]!.retTotal).toBeCloseTo((5800 + 20 * 220) / START_USD - 1, 6);
    expect(v.standings[1]!.retTotal).toBeLessThan(0);
    // Lo que ven los demás no trae precios ni montos.
    expect(JSON.stringify(v.standings)).not.toMatch(/220|4400|5800/);
    expect(v.me!.spySeason).toBeNull(); // sin cierre antes de la temporada no hay con qué comparar

    // Vender todo: con el cierre del día en que se pide (si es antes del cierre).
    await liga.order('p-ana', { action: 'vender', symbol: 'NVDA' }, new Date('2026-11-04T15:00:00Z'));
    await liga.tick(new Date('2026-11-04T23:00:00Z')); // ya valorizado ese día: no cambia
    expect((await liga.view('p-ana', new Date('2026-11-04T23:00:00Z'), aliases)).me!.orders).toHaveLength(1);
  });

  it('si Twelve Data rechaza la clave, se le avisa solo a esa persona y su cartera queda como estaba', async () => {
    const store = memoryStorage();
    const ok = twelve(book);
    await new Acciones(store, { secret: SECRET, appKey: undefined, fetch: ok.f }).connect('p-ana', { key: KEY_ANA }, new Date('2026-11-03T15:00:00Z'));
    const revoked = new Acciones(store, { secret: SECRET, appKey: undefined, fetch: twelve(book, []).f });
    await revoked.tick(new Date('2026-11-03T21:30:00Z'));
    const v = await revoked.view('p-ana', new Date('2026-11-03T22:00:00Z'), aliases);
    expect(v.me!.error).toMatch(/rechazó tu clave/);
    expect(v.me!.value).toBe(START_USD);
    await revoked.disconnect('p-ana');
    expect((await revoked.view('p-ana', new Date(), aliases)).me!.connected).toBe(false);
  });
});

describe('temporadas de quincena', () => {
  it('van del 1 al 15 y del 16 a fin de mes, con las sesiones de la NYSE', () => {
    expect(seasonOf('2026-11-04')).toEqual({ id: '2026-11-1', from: '2026-11-01', to: '2026-11-15' });
    expect(seasonOf('2026-11-16')).toEqual({ id: '2026-11-2', from: '2026-11-16', to: '2026-11-30' });
    expect(seasonOf('2027-02-20').to).toBe('2027-02-28');
    expect(seasonSessions(seasonOf('2026-11-04'))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    expect(seasonSessions(seasonOf('2026-11-20'))).not.toContain('2026-11-26'); // Acción de Gracias
  });

  it('al terminar la quincena guarda el resultado, suma el trofeo y la siguiente sale de 0', async () => {
    const book2 = {
      SPY: { '2026-11-12': 600, '2026-11-13': 603, '2026-11-16': 606 },
      NVDA: { '2026-11-12': 200, '2026-11-13': 210, '2026-11-16': 205 },
      BAP: { '2026-11-12': 250, '2026-11-13': 240, '2026-11-16': 255 },
    };
    const store = memoryStorage();
    const liga = new Acciones(store, { secret: SECRET, appKey: undefined, fetch: twelve(book2).f });
    const thu = new Date('2026-11-12T15:00:00Z'); // jueves 12, 10:00 en NY
    await liga.connect('p-ana', { key: KEY_ANA }, thu);
    await liga.connect('p-beto', { key: KEY_BETO }, thu);
    await liga.order('p-ana', { action: 'comprar', symbol: 'NVDA', usd: 5000 }, thu);
    await liga.order('p-beto', { action: 'comprar', symbol: 'BAP', usd: 5000 }, thu);
    await liga.tick(new Date('2026-11-12T21:30:00Z')); // se cumplen las compras
    await liga.tick(new Date('2026-11-13T21:30:00Z')); // viernes 13: la última sesión de la quincena

    const fri = await liga.view('p-ana', new Date('2026-11-13T22:00:00Z'), aliases);
    expect(fri.season).toMatchObject({ id: '2026-11-1', last: '2026-11-13', total: 10, left: 0 });
    expect(fri.standings.map((s) => s.alias)).toEqual(['Ana', 'Beto']);
    // Entraron en la temporada: su carrera empieza en su primer cierre, sin salida en 0.
    expect(fri.race.find((r) => r.mine)!.points.map((p) => p.d)).toEqual(['2026-11-12', '2026-11-13']);
    expect(fri.race.find((r) => r.mine)!.points[1]!.r).toBeCloseTo(0.025, 6); // 25 NVDA de 200 a 210
    expect(fri.seasons).toEqual([]); // todavía no termina
    expect(JSON.stringify(fri.race)).not.toMatch(/10250|9800/); // la carrera son porcentajes, nunca montos

    // El lunes queda guardada: gana Ana (+2.5 %) y Beto queda segundo (−2 %).
    await liga.tick(new Date('2026-11-16T15:00:00Z'));
    const mon = await liga.view('p-beto', new Date('2026-11-16T15:05:00Z'), aliases);
    expect(mon.seasons).toHaveLength(1);
    expect(mon.seasons[0]).toMatchObject({ id: '2026-11-1', from: '2026-11-01', to: '2026-11-15', players: 2 });
    expect(mon.seasons[0]!.podium.map((p) => [p.alias, p.mine])).toEqual([['Ana', false], ['Beto', true]]);
    expect(mon.seasons[0]!.podium[0]!.ret).toBeCloseTo(0.025, 6);
    expect(mon.seasons[0]!.podium[1]!.ret).toBeCloseTo(-0.02, 6);
    expect(mon.titles).toEqual([{ alias: 'Ana', titles: 1, mine: false }]);
    // La nueva temporada: 10 sesiones (sin Acción de Gracias) y todos en 0 hasta el primer cierre.
    expect(mon.season).toMatchObject({ id: '2026-11-2', from: '2026-11-16', to: '2026-11-30', total: 10, left: 10 });
    expect(mon.standings.map((s) => s.retSeason)).toEqual([0, 0]);

    // Lo guardado no se duplica, y la carrera nueva sale de 0 el día antes y suma el lunes.
    await liga.tick(new Date('2026-11-16T21:30:00Z'));
    const v = await liga.view('p-ana', new Date('2026-11-16T22:00:00Z'), aliases);
    expect(v.seasons).toHaveLength(1);
    expect(v.season.left).toBe(9);
    expect(v.race.find((r) => r.mine)!.points.map((p) => p.d)).toEqual(['2026-11-15', '2026-11-16']);
    expect(v.standings[0]!.alias).toBe('Beto'); // BAP sube el lunes
    expect([...store.data.keys()].filter((k) => k.startsWith('ls:'))).toEqual(['ls:2026-11-1']);
  });
});
