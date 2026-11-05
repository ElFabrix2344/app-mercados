import { describe, expect, it } from 'vitest';
import { Acciones } from '../src/game/acciones';
import { JuegoDO } from '../src/game/juego-do';
import { forgetPanel, PANEL, PanelAmigo, panelReply, panelStore } from '../src/game/panel';
import type { Env } from '../src/env';
import worker from '../src/index';
import { playerId } from '../src/services/forecasts';
import { memoryKV, memoryStorage } from './helpers';

const KEY_ANA = 'anakey0123456789anakey0123456789';
const KEY_BETO = 'betokey123456789betokey123456789';

/** Twelve Data de mentira que anota con qué clave se pidió cada cosa. */
function twelve() {
  const calls: { path: string; key: string; symbols: string[] }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('apikey ', '');
    const symbols = (url.searchParams.get('symbol') ?? '').split(',');
    calls.push({ path: url.pathname, key, symbols });
    const price = key === KEY_ANA ? 100 : 200; // así se nota de qué clave salió cada precio
    const one = (s: string) =>
      url.pathname === '/quote'
        ? { symbol: s, name: `${s} Inc.`, exchange: 'NASDAQ', currency: 'USD', close: String(price) }
        : { meta: { symbol: s }, status: 'ok', values: Array.from({ length: 300 }, (_, i) => ({ datetime: new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10), close: String(price + Math.sin(i)) })) };
    const body = symbols.length === 1 ? one(symbols[0]!) : Object.fromEntries(symbols.map((s) => [s, one(s)]));
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('panel de un amigo con su propia clave', () => {
  const now = new Date('2026-11-04T15:00:00Z'); // miércoles, con la bolsa abierta
  const keys: Record<string, string> = { 'p-ana': KEY_ANA, 'p-beto': KEY_BETO };

  it('cada uno ve lo que trae su clave, con su caché y sus créditos; nadie ve lo del otro', async () => {
    const store = memoryStorage();
    const tw = twelve();
    const panel = new PanelAmigo(store, async (pid) => keys[pid] ?? null, { fetch: tw.f });
    const ana = (await panel.handle('p-ana', now, { op: 'quotes', refresh: false })) as any;
    expect(ana.data.quotes.map((q: { price: number }) => q.price)).toEqual(new Array(6).fill(100));
    expect(ana.credits).toEqual({ used: 6, cap: 600 });
    // Beto no recibe lo que Ana ya tiene guardado: se pide de nuevo, con su clave.
    const beto = (await panel.handle('p-beto', now, { op: 'quotes', refresh: false })) as any;
    expect(beto.data.quotes.every((q: { price: number }) => q.price === 200)).toBe(true);
    expect(beto.credits.used).toBe(6);
    expect(tw.calls.map((c) => c.key)).toEqual([KEY_ANA, KEY_BETO]);
    // Todo lo de cada uno, con su prefijo.
    expect([...store.data.keys()].sort()).toEqual([`${PANEL}p-ana:budget`, `${PANEL}p-ana:quotes`, `${PANEL}p-beto:budget`, `${PANEL}p-beto:quotes`]);
  });

  it('su lista: la elige él y de ahí salen historiales, comparaciones, noticias y el termómetro', async () => {
    const store = memoryStorage();
    const tw = twelve();
    const panel = new PanelAmigo(store, async (pid) => keys[pid] ?? null, { fetch: tw.f, mock: true });
    expect(await panel.handle('p-ana', now, { op: 'watchlist' })).toEqual({ symbols: ['BAP', 'SCCO', 'BVN', 'SPY', 'USD/PEN', 'BTC/USD'], max: 8 });
    await expect(panel.handle('p-ana', now, { op: 'save-watchlist', body: { symbols: new Array(9).fill(0).map((_, i) => `S${i}`) } })).rejects.toThrow(/Máximo 8/);
    expect(await panel.handle('p-ana', now, { op: 'save-watchlist', body: { symbols: ['nvda', 'SPY'] } })).toEqual({ symbols: ['NVDA', 'SPY'], max: 8 });

    const h = (await panel.handle('p-ana', now, { op: 'history', symbol: 'nvda', range: '3M', ind: false })) as any;
    expect(h.data.symbol).toBe('NVDA');
    expect(h.indicators).toBeUndefined();
    expect(((await panel.handle('p-ana', now, { op: 'history', symbol: 'NVDA', range: '1A', ind: true })) as any).indicators.sma50).toHaveLength(
      ((await panel.handle('p-ana', now, { op: 'history', symbol: 'NVDA', range: '1A', ind: false })) as any).data.points.length,
    );
    await expect(panel.handle('p-ana', now, { op: 'history', symbol: 'BAP', range: '1A', ind: false })).rejects.toThrow(/tu lista/);
    await expect(panel.handle('p-ana', now, { op: 'history', symbol: 'NVDA', range: '2A', ind: false })).rejects.toThrow(/Rango no válido/);

    const c = (await panel.handle('p-ana', now, { op: 'compare', symbols: ['NVDA', 'SPY'], range: '6M' })) as any;
    expect(c.series.map((s: { symbol: string }) => s.symbol)).toEqual(['NVDA', 'SPY']);
    await expect(panel.handle('p-ana', now, { op: 'compare', symbols: ['NVDA', 'BAP'], range: '6M' })).rejects.toThrow(/BAP no está en tu lista/);

    const t = (await panel.handle('p-ana', now, { op: 'thermometer' })) as any;
    expect(t.data.symbol).toBe('SPY');
    expect(['tranquilo', 'normal', 'agitado']).toContain(t.data.regime);

    expect(((await panel.handle('p-ana', now, { op: 'news', symbol: 'nvda' })) as any).symbol).toBe('NVDA');
    await expect(panel.handle('p-ana', now, { op: 'news', symbol: 'BAP' })).rejects.toThrow(/tu lista/);
    // Los 5 años se guardan una vez por símbolo (1 crédito cada uno) y se reusan.
    expect(tw.calls.filter((x) => x.path === '/time_series').map((x) => x.symbols.join())).toEqual(['NVDA', 'SPY']);
  });

  it('sin clave propia no hay nada, y al quitarla se borra lo que trajo (su lista queda)', async () => {
    const store = memoryStorage();
    const tw = twelve();
    const owned: Record<string, string | null> = { 'p-ana': KEY_ANA };
    const panel = new PanelAmigo(store, async (pid) => owned[pid] ?? null, { fetch: tw.f });
    await expect(panel.handle('p-caro', now, { op: 'watchlist' })).rejects.toThrow(/conecta tu clave/);
    await panel.handle('p-ana', now, { op: 'save-watchlist', body: { symbols: ['NVDA'] } });
    await panel.handle('p-ana', now, { op: 'quotes', refresh: false });
    await forgetPanel(store, 'p-ana');
    expect([...store.data.keys()]).toEqual([`${PANEL}p-ana:watchlist`]);
    expect(await panelStore(store, 'p-ana').get('watchlist', 'json')).toEqual(['NVDA']);
  });

  it('los errores vuelven con su código y su mensaje, listos para el Worker', async () => {
    const r = await panelReply(async () => {
      throw new (await import('../src/lib/http')).ApiError('bad_request', 400, 'Algo falló.');
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'bad_request', message: 'Algo falló.', provider: null } });
    expect(await panelReply(async () => ({ ok: 1 }))).toEqual({ status: 200, body: '{"ok":1}' });
  });

  it('la clave del panel es la propia de la liga; nunca la de Rueda', async () => {
    const store = memoryStorage();
    const tw = twelve();
    const liga = new Acciones(store, { secret: 's'.repeat(40), appKey: 'clave-de-rueda-0123', fetch: tw.f });
    await liga.joinWithAppKey('p-yo', now);
    expect(await liga.ownKey('p-yo')).toBeNull();
    await liga.connect('p-ana', { key: KEY_ANA }, now);
    expect(await liga.ownKey('p-ana')).toBe(KEY_ANA);
    expect(await liga.ownKey('p-nadie')).toBeNull();
    // Al quitar la clave en la liga se borra su caché del panel.
    await store.put(`${PANEL}p-ana:quotes`, '{}');
    await liga.disconnect('p-ana');
    expect(await liga.ownKey('p-ana')).toBeNull();
    expect(await store.get(`${PANEL}p-ana:quotes`)).toBeUndefined();
  });
});

describe('rutas del panel para un amigo (local, con el Twelve Data de mentira)', () => {
  function setup() {
    const cache = memoryKV();
    const env = {
      CACHE: cache.kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      MOCK_DATA: 'true',
      DEV_ROLE: 'friend',
    } as unknown as Env;
    const storage = memoryStorage();
    const instance = new JuegoDO({ storage } as unknown as DurableObjectState, env);
    (env as { JUEGO?: unknown }).JUEGO = { idFromName: () => 'grupo', get: () => instance };
    const call = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
        env,
        {} as ExecutionContext,
      );
    return { call, cache, storage };
  }

  it('sin clave, 403; con la clave de la liga, su lista, sus precios, sus gráficos y el termómetro', async () => {
    const { call, cache, storage } = setup();
    for (const path of ['/api/watchlist', '/api/quotes', '/api/history?symbol=SPY', '/api/compare?symbols=SPY,BAP', '/api/thermometer', '/api/news/symbol?symbol=SPY']) {
      const res = await call('GET', path);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Twelve Data');
    }
    await call('PUT', '/api/forecasts/name', { alias: 'Dani' });
    expect((await call('POST', '/api/games/liga', { action: 'conectar', key: 'abcdef0123456789abcdef0123456789' })).status).toBe(200);

    expect(((await (await call('GET', '/api/watchlist')).json()) as any).symbols).toContain('SPY');
    const saved = (await (await call('PUT', '/api/watchlist', { symbols: ['nvda', 'SPY', 'BTC/USD'] })).json()) as any;
    expect(saved).toEqual({ symbols: ['NVDA', 'SPY', 'BTC/USD'], max: 8 });
    const q = (await (await call('GET', '/api/quotes')).json()) as any;
    expect(q.data.quotes.map((x: { symbol: string }) => x.symbol)).toEqual(['NVDA', 'SPY', 'BTC/USD']);
    expect(q.credits.used).toBe(3);
    expect((await call('GET', '/api/history?symbol=NVDA&range=3M&ind=1')).status).toBe(200);
    expect((await call('GET', '/api/history?symbol=BAP')).status).toBe(400);
    expect((await call('GET', '/api/compare?symbols=NVDA,SPY&range=6M')).status).toBe(200);
    expect(((await (await call('GET', '/api/thermometer')).json()) as any).data.symbol).toBe('SPY');
    expect(((await (await call('GET', '/api/news/symbol?symbol=NVDA')).json()) as any).items.length).toBeGreaterThan(0);
    // Lo que no es para los amigos sigue cerrado, aunque tengan clave.
    for (const path of ['/api/eod', '/api/portfolio', '/api/company?symbol=NVDA', '/api/company/factors?symbol=NVDA']) expect((await call('GET', path)).status).toBe(403);

    // Nada de esto pasó por la KV de la app (la del dueño): todo quedó en su parte del Durable Object.
    expect([...cache.store.keys()].filter((k) => /^(quotes|budget|watchlist|hist5:)/.test(k))).toEqual([]);
    const pid = await playerId('dev@localhost');
    expect([...storage.data.keys()].filter((k) => k.startsWith(`${PANEL}${pid}:`)).sort()).toEqual(
      ['budget', 'hist5:NVDA', 'hist5:SPY', 'quotes', 'watchlist'].map((k) => `${PANEL}${pid}:${k}`),
    );

    // Al quitar la clave se cierra otra vez y se borra lo que trajo.
    await call('POST', '/api/games/liga', { action: 'desconectar' });
    expect((await call('GET', '/api/quotes')).status).toBe(403);
    expect([...storage.data.keys()].filter((k) => k.startsWith(PANEL))).toEqual([`${PANEL}${pid}:watchlist`]);
  });
});
