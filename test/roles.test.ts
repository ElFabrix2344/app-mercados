import { describe, expect, it } from 'vitest';
import { roleFor } from '../src/auth/access';
import type { Env } from '../src/env';
import worker from '../src/index';
import { memoryKV } from './helpers';

describe('roleFor', () => {
  const env = (OWNER_EMAILS?: string) => ({ OWNER_EMAILS }) as Env;

  it('solo los correos de OWNER_EMAILS son dueños (sin importar mayúsculas)', () => {
    expect(roleFor('Yo@Example.com', env('yo@example.com, otro@example.com'))).toBe('owner');
    expect(roleFor('amigo@example.com', env('yo@example.com'))).toBe('friend');
  });

  it('falla cerrado: sin OWNER_EMAILS nadie es dueño', () => {
    expect(roleFor('yo@example.com', env(''))).toBe('friend');
    expect(roleFor('yo@example.com', env())).toBe('friend');
    expect(roleFor(null, env('yo@example.com'))).toBe('friend');
  });
});

describe('rutas según el rol (local, con datos de prueba)', () => {
  const env = (role?: string) =>
    ({
      CACHE: memoryKV().kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      MOCK_DATA: 'true',
      DEV_ROLE: role,
    }) as unknown as Env;
  const get = (path: string, role?: string) => worker.fetch(new Request(`http://localhost${path}`), env(role), {} as ExecutionContext);

  it('la cartera simulada: agrega una compra, la valoriza y la borra', async () => {
    const e = env();
    const call = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
        e,
        {} as ExecutionContext,
      );
    const date = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const add = await call('POST', '/api/portfolio', { date, symbol: 'BAP', side: 'buy', qty: 2 });
    expect(add.status).toBe(200);
    const p = (await add.json()) as Record<string, any>;
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].price).toBeGreaterThan(0); // sin precio: el cierre de ese día (datos de prueba)
    expect(p.totals.invested).toBeCloseTo(2 * p.trades[0].price, 2);
    expect(p.benchmark.symbol).toBe('SPY');
    expect(p.fx.rate).toBeGreaterThan(0);
    const del = await call('DELETE', `/api/portfolio?id=${p.trades[0].id}`);
    expect(((await del.json()) as Record<string, any>).trades).toEqual([]);
    expect((await call('POST', '/api/portfolio', { date, symbol: 'USD/PEN', side: 'buy', qty: 1 })).status).toBe(400);
  });

  it('un amigo no puede ver precios, historial, comparaciones, la cartera ni la lista', async () => {
    for (const path of ['/api/quotes', '/api/history?symbol=BAP', '/api/compare?symbols=BAP,SPY', '/api/portfolio', '/api/watchlist', '/api/company?symbol=BAP']) {
      const res = await get(path, 'friend');
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Twelve Data');
    }
  });

  it('un amigo tampoco puede cambiar la lista', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: ['BAP'] }),
      }),
      env('friend'),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('un amigo sí ve Perú y EE. UU., y su estado no muestra configuración ni créditos', async () => {
    expect((await get('/api/peru', 'friend')).status).toBe(200);
    expect((await get('/api/peru-markets', 'friend')).status).toBe(200);
    expect((await get('/api/usa', 'friend')).status).toBe(200);
    const status = (await (await get('/api/status', 'friend')).json()) as Record<string, unknown>;
    expect(status.role).toBe('friend');
    expect(status.config).toBeUndefined();
    expect(status.credits).toBeUndefined();
  });

  it('el calendario trae los resultados de la lista solo para el dueño', async () => {
    const friend = (await (await get('/api/calendar', 'friend')).json()) as Record<string, any>;
    expect(friend.companies).toBeUndefined();
    expect(friend.sources.empresa).toBeUndefined();
    expect(friend.events.some((e: { kind: string }) => e.kind === 'empresa')).toBe(false);

    const owner = (await (await get('/api/calendar')).json()) as Record<string, any>;
    expect(owner.companies).toMatchObject({ enabled: true });
    expect(owner.sources.empresa.name).toContain('Finnhub');
    const co = owner.events.filter((e: { kind: string }) => e.kind === 'empresa');
    // Datos de prueba: BAP ya presentó; SCCO presenta en 2 días y BVN después; SPY es un ETF.
    expect(co.map((e: { company: { symbol: string } }) => e.company.symbol)).toEqual(['SCCO', 'BVN']);
    expect(owner.companies.recent.map((r: { symbol: string }) => r.symbol)).toEqual(['BAP']);
  });

  it('sin la clave de Finnhub el dueño ve el calendario igual, con los resultados apagados', async () => {
    const e = { ...env(), MOCK_DATA: undefined } as Env;
    const r = (await (await worker.fetch(new Request('http://localhost/api/calendar'), e, {} as ExecutionContext)).json()) as Record<string, any>;
    expect(r.companies).toMatchObject({ enabled: false });
    expect(r.events.length).toBeGreaterThan(0);
  });

  it('los datos de la empresa: de prueba para el dueño, nada para divisas ni ETF, y solo símbolos de la lista', async () => {
    const bap = (await (await get('/api/company?symbol=BAP')).json()) as Record<string, any>;
    expect(bap).toMatchObject({ enabled: true, applicable: true });
    expect(bap.data.metrics.pe).toEqual(expect.any(Number));
    expect(bap.data.surprises).toHaveLength(4);
    expect(((await (await get('/api/company?symbol=USD/PEN')).json()) as Record<string, any>).applicable).toBe(false);
    expect(((await (await get('/api/company?symbol=SPY')).json()) as Record<string, any>).data.profile).toBeNull();
    expect((await get('/api/company?symbol=NVDA')).status).toBe(400);
  });

  it('el dueño ve todo', async () => {
    expect((await get('/api/quotes')).status).toBe(200);
    const status = (await (await get('/api/status')).json()) as Record<string, unknown>;
    expect(status.role).toBe('owner');
    expect(status.config).toBeDefined();
  });

  it('el historial trae indicadores solo si se piden, alineados con los cierres', async () => {
    const plain = (await (await get('/api/history?symbol=BAP&range=3M')).json()) as Record<string, any>;
    expect(plain.indicators).toBeUndefined();
    const withInd = (await (await get('/api/history?symbol=BAP&range=3M&ind=1')).json()) as Record<string, any>;
    const n = withInd.data.points.length;
    for (const k of ['sma50', 'sma200', 'bbUpper', 'bbLower', 'rsi14']) expect(withInd.indicators[k]).toHaveLength(n);
    // Con 5 años guardados, la media de 200 días ya existe el primer día del rango.
    expect(withInd.indicators.sma200[0]).toEqual(expect.any(Number));
  });

  it('compara de 2 a 4 símbolos de la lista', async () => {
    const res = await get('/api/compare?symbols=bap,SPY,BTC/USD&range=6M');
    expect(res.status).toBe(200);
    const r = (await res.json()) as Record<string, any>;
    expect(r.series.map((s: { symbol: string }) => s.symbol)).toEqual(['BAP', 'SPY', 'BTC/USD']);
    expect(r.series[0].rebased[0]).toBe(100);
    expect(r.series[2].closes).toHaveLength(r.dates.length);
    expect(r.correlation).toHaveLength(3);
    expect(r.correlation[1][1]).toBe(1);
    expect(r.correlation[0][1]).toBe(r.correlation[1][0]);
    // Los fines de semana de la cripto quedan fuera: solo días comunes.
    expect(r.dates.every((d: string) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))).toBe(true);

    expect((await get('/api/compare?symbols=BAP')).status).toBe(400);
    expect((await get('/api/compare?symbols=BAP,SPY,BVN,SCCO,USD/PEN')).status).toBe(400);
    const outside = await get('/api/compare?symbols=BAP,NVDA');
    expect(outside.status).toBe(400);
    expect(await outside.text()).toContain('NVDA');
    expect((await get('/api/compare?symbols=BAP,SPY&range=2A')).status).toBe(400);
  });
});
