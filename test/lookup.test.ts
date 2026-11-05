import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { JuegoDO } from '../src/game/juego-do';
import { PANEL } from '../src/game/panel';
import worker from '../src/index';
import { parseSearch, searchCompanies } from '../src/lib/sec';
import type { QuoteBatch } from '../src/lib/twelvedata';
import { playerId } from '../src/services/forecasts';
import { parseFinnhubQuote, shortExchange } from '../src/lib/finnhub';
import { finnhubFirst, LOOKUP_DAILY_MAX, LOOKUP_KEY, lookedUp, lookup, lookupStatus, noPrice, resetSearchCache, suggest, twelveSource } from '../src/services/lookup';
import { DAILY_CREDIT_CAP } from '../src/services/market';
import { fakeFetch, memoryKV, memoryStorage } from './helpers';

/** Respuesta del buscador de EDGAR con estas entidades ([CIK, tickers, nombre]). */
const edgar = (rows: [number, string | null, string][]) => ({
  hits: { hits: rows.map(([id, tickers, entity]) => ({ _id: String(id), _source: { tickers, entity } })) },
});

describe('buscador de la SEC', () => {
  it('solo empresas que cotizan, con su ticker principal y sus otras clases, sin preferentes ni warrants', () => {
    const body = edgar([
      [1067983, 'BRK-B, BRK-A', 'BERKSHIRE HATHAWAY INC (BRK-B, BRK-A)'],
      [1215379, null, 'APPLE JIM B'],
      [70858, 'BAC, BML-PL, BAC-PS, BAC-PB', 'BANK OF AMERICA CORP /DE/ (BAC, BML-PL, BAC-PS, BAC-PB)'],
      [92103, 'SCE-PN, SCE-PM', 'SOUTHERN CALIFORNIA EDISON Co (SCE-PN, SCE-PM)'],
      [314808, 'VAL, VAL-WT', 'Valaris Ltd (VAL, VAL-WT)'],
      [102752, 'VSEC, VSECU', 'VSE CORP (VSEC, VSECU)'],
      [63754, 'MKC, MKC-V', 'MCCORMICK & CO INC (MKC, MKC-V)'],
      [1001838, 'SCCO', 'SOUTHERN COPPER CORP/ (SCCO)'],
    ]);
    expect(parseSearch(body, 'b')).toEqual([
      { symbol: 'BRK.B', name: 'BERKSHIRE HATHAWAY INC', cik: 1067983 },
      { symbol: 'BRK.A', name: 'BERKSHIRE HATHAWAY INC', cik: 1067983 },
      { symbol: 'BAC', name: 'BANK OF AMERICA CORP', cik: 70858 },
      { symbol: 'VAL', name: 'Valaris Ltd', cik: 314808 },
      { symbol: 'VSEC', name: 'VSE CORP', cik: 102752 },
      { symbol: 'MKC', name: 'MCCORMICK & CO INC', cik: 63754 },
      { symbol: 'MKC.V', name: 'MCCORMICK & CO INC', cik: 63754 },
      { symbol: 'SCCO', name: 'SOUTHERN COPPER CORP', cik: 1001838 },
    ]);
    // Hasta `max`, y si se escribe otro de sus tickers, ese (GOOGL) o hasta una preferente escrita tal cual.
    expect(parseSearch(body, 'b', 3)).toHaveLength(3);
    expect(parseSearch(edgar([[1652044, 'GOOG, GOOGN, GOOGL', 'Alphabet Inc. (GOOG, GOOGN, GOOGL)']]), 'googl')).toEqual([{ symbol: 'GOOGL', name: 'Alphabet Inc.', cik: 1652044 }]);
    expect(parseSearch(body, 'SCE-PN').map((m) => m.symbol)).toContain('SCE.PN');
    expect(parseSearch(null, 'x')).toEqual([]);
  });

  it('BRK.B se busca como BRK-B, un nombre con espacios se prueba junto y la SEC no recibe ningún correo', async () => {
    const { f, calls } = fakeFetch((url) => {
      const q = url.searchParams.get('keysTyped');
      if (q === 'BRK-B') return { body: edgar([[1067983, 'BRK-B, BRK-A', 'BERKSHIRE HATHAWAY INC (BRK-B, BRK-A)']]) };
      if (q === 'mercadolibre') return { body: edgar([[1099590, 'MELI', 'MERCADOLIBRE INC (MELI)']]) };
      return { body: edgar([[1, null, 'Alguien sin ticker']]) };
    });
    expect((await searchCompanies('brk.b', f)).map((m) => m.symbol)).toEqual(['BRK.B', 'BRK.A']);
    expect((await searchCompanies('  mercado   libre ', f)).map((m) => m.symbol)).toEqual(['MELI']);
    expect(calls.map((u) => u.searchParams.get('keysTyped'))).toEqual(['BRK-B', 'mercado libre', 'mercadolibre']);
    expect(calls.every((u) => u.origin === 'https://efts.sec.gov')).toBe(true);
  });

  it('sugerencias: valida lo escrito, no consulta la SEC por divisas ni repite búsquedas recientes', async () => {
    resetSearchCache();
    const { f, calls } = fakeFetch(() => ({ body: edgar([[1045810, 'NVDA', 'NVIDIA CORP (NVDA)']]) }));
    await expect(suggest('', f)).rejects.toThrow(/nombre o el símbolo/);
    await expect(suggest('<script>', f)).rejects.toThrow(/nombre o el símbolo/);
    await expect(suggest('x'.repeat(41), f)).rejects.toThrow(/hasta 40/);
    expect(await suggest('BTC/USD', f)).toEqual([]);
    expect(await suggest('Nvidia', f, 1_000)).toEqual([{ symbol: 'NVDA', name: 'NVIDIA CORP', cik: 1045810 }]);
    await suggest('nvidia ', f, 2_000);
    expect(calls).toHaveLength(1);
    // Pasados 10 minutos, se pregunta de nuevo.
    await suggest('nvidia', f, 1_000 + 10 * 60_000);
    expect(calls).toHaveLength(2);
  });
});

describe('fichas de acciones buscadas', () => {
  const open = new Date('2026-11-04T15:00:00Z'); // miércoles, con la bolsa abierta
  let fetched: string[];
  const getQuote = async (s: string): Promise<QuoteBatch> => {
    fetched.push(s);
    if (s === 'NOPE') return { quotes: [], errors: { NOPE: '**symbol** not found: NOPE' } };
    return {
      quotes: [{ symbol: s, name: `${s} Inc.`, exchange: 'NASDAQ', currency: 'USD', price: 100, prevClose: 99, change: 1, changePct: 1.01, asOf: open.toISOString(), isMarketOpen: true, low52: 80, high52: 120 }],
      errors: {},
    };
  };
  beforeEach(() => {
    fetched = [];
  });

  it('anota la acción con su precio (1 crédito) y no vuelve a pedirlo ni a escribir hasta que vence', async () => {
    const m = memoryKV();
    const d = { kv: m.kv, now: open };
    const r = await lookup(d, ' nvda ', { getQuote });
    expect(r.symbol).toBe('NVDA');
    expect(r.quote?.price).toBe(100);
    expect(r.error).toBeNull();
    expect(r.lookups).toEqual({ used: 1, max: LOOKUP_DAILY_MAX, today: ['NVDA'] });
    expect(r.credits).toEqual({ used: 1, cap: DAILY_CREDIT_CAP });
    expect(m.writes()).toBe(2); // el registro y el contador de créditos
    expect(((await m.kv.get('budget', 'json')) as { used: number }).used).toBe(1);

    await lookup({ kv: m.kv, now: new Date(open.getTime() + 5 * 60_000) }, 'NVDA', { getQuote });
    expect(fetched).toEqual(['NVDA']);
    expect(m.writes()).toBe(2);
    // Con la bolsa abierta, el precio se renueva pasados 9 minutos.
    await lookup({ kv: m.kv, now: new Date(open.getTime() + 10 * 60_000) }, 'NVDA', { getQuote });
    expect(fetched).toEqual(['NVDA', 'NVDA']);

    expect(await lookedUp(m.kv, 'NVDA', open)).not.toBeNull();
    expect(await lookedUp(m.kv, 'AAPL', open)).toBeNull();
    await expect(lookup(d, 'no válido', { getQuote })).rejects.toThrow(/Escribe un símbolo/);
  });

  it(`tope de ${LOOKUP_DAILY_MAX} acciones nuevas al día: las de hoy se siguen abriendo y al otro día se libera`, async () => {
    const m = memoryKV();
    for (let i = 0; i < LOOKUP_DAILY_MAX; i++) await lookup({ kv: m.kv, now: open }, `S${i}`, { getQuote });
    await expect(lookup({ kv: m.kv, now: open }, 'OTRA', { getQuote })).rejects.toMatchObject({ code: 'daily_limit', status: 429, message: expect.stringMatching(/tope del día/) });
    expect((await lookup({ kv: m.kv, now: open }, 'S3', { getQuote })).quote).not.toBeNull();
    expect((await lookupStatus(m.kv, open)).used).toBe(LOOKUP_DAILY_MAX);

    const tomorrow = new Date('2026-11-05T15:00:00Z');
    expect((await lookupStatus(m.kv, tomorrow)).used).toBe(0);
    // Las de ayer siguen abiertas (36 h) y, si se vuelven a abrir, cuentan para hoy.
    expect(await lookedUp(m.kv, 'S0', tomorrow)).not.toBeNull();
    expect((await lookup({ kv: m.kv, now: tomorrow }, 'OTRA', { getQuote })).lookups.used).toBe(1);
    expect((await lookup({ kv: m.kv, now: tomorrow }, 'S0', { getQuote })).lookups.used).toBe(2);
    // Pasadas 36 horas sin abrirla, se olvida.
    expect(await lookedUp(m.kv, 'S5', new Date(open.getTime() + 37 * 3_600_000))).toBeNull();
  });

  it('si Twelve Data no la tiene, se anota sin precio (no abre historial); si falla el pedido, no se anota', async () => {
    const m = memoryKV();
    const r = await lookup({ kv: m.kv, now: open }, 'NOPE', { getQuote });
    expect(r.quote).toBeNull();
    expect(r.error).toBe('Twelve Data no encuentra NOPE: revisa el símbolo (las clases van con punto, como BRK.B).');
    expect(r.lookups.used).toBe(1);
    expect(await lookedUp(m.kv, 'NOPE', open)).toBeNull();

    const limit = async (): Promise<QuoteBatch> => {
      throw new (await import('../src/lib/http')).ApiError('rate_limited', 429, 'Twelve Data: se alcanzó el límite de créditos por minuto.', 'twelvedata');
    };
    await expect(lookup({ kv: m.kv, now: open }, 'AAPL', { getQuote: limit })).rejects.toThrow(/por minuto/);
    expect(Object.keys((await m.kv.get(LOOKUP_KEY, 'json')) as object)).toEqual(['NOPE']);

    // Con el freno del día, tampoco: y no se gasta nada.
    await m.kv.put('budget', JSON.stringify({ day: '2026-11-04', used: DAILY_CREDIT_CAP }));
    await expect(lookup({ kv: m.kv, now: open }, 'AAPL', { getQuote })).rejects.toThrow(/Freno de créditos/);
    expect(fetched).toEqual(['NOPE']);
  });

  it('los errores de Twelve Data, en palabras del panel', () => {
    expect(noPrice('XYZ', 'This symbol is available starting with Grow plan.')).toBe('Twelve Data no tiene XYZ en el plan gratis.');
    expect(noPrice('XYZ', '**algo** raro')).toBe('Twelve Data no tiene precios de XYZ: algo raro');
  });

  it('con un precio guardado, si no se puede renovar se muestra el guardado', async () => {
    const m = memoryKV();
    await lookup({ kv: m.kv, now: open }, 'NVDA', { getQuote });
    await m.kv.put('budget', JSON.stringify({ day: '2026-11-04', used: DAILY_CREDIT_CAP }));
    const r = await lookup({ kv: m.kv, now: new Date(open.getTime() + 15 * 60_000) }, 'NVDA', { getQuote, force: true });
    expect(r.stale).toBe(true);
    expect(r.note).toMatch(/Freno de créditos/);
    expect(r.quote?.price).toBe(100);
  });
});

describe('precio de las buscadas desde Finnhub (solo el dueño)', () => {
  const now = new Date('2026-11-05T16:00:00Z'); // jueves, con la bolsa abierta
  /** Finnhub de mentira: AAPL con precio y perfil; SPY con precio y sin perfil (ETF); el resto, ceros. */
  const finnhub = (status = 200) =>
    fakeFetch((url) => {
      const sym = url.searchParams.get('symbol');
      if (status !== 200) return { status, body: { error: 'You don\'t have access to this resource.' } };
      if (url.pathname.endsWith('/quote')) {
        if (sym === 'AAPL') return { body: { c: 270.5, d: 2.5, dp: 0.9328, h: 271, l: 266, o: 267, pc: 268, t: 1793912400 } };
        if (sym === 'SPY') return { body: { c: 690.1, d: -1.2, dp: -0.17, h: 692, l: 688, o: 691, pc: 691.3, t: 1793912400 } };
        return { body: { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 } };
      }
      return { body: sym === 'AAPL' ? { name: 'Apple Inc', exchange: 'NASDAQ NMS - GLOBAL MARKET', currency: 'USD' } : {} };
    });
  const twelve = () => {
    const asked: string[] = [];
    const get = async (s: string): Promise<QuoteBatch> => {
      asked.push(s);
      return { quotes: [{ symbol: s, name: `${s} (Twelve Data)`, exchange: 'NYSE', currency: 'USD', price: 10, prevClose: 9, change: 1, changePct: 11.1, asOf: null, isMarketOpen: true, low52: null, high52: null }], errors: {} };
    };
    return { asked, get };
  };

  it('lee el precio de Finnhub y su bolsa como la escribe Twelve Data; sin símbolo responde ceros', () => {
    expect(parseFinnhubQuote({ c: 270.5, d: 2.5, dp: 0.93, pc: 268, t: 1793912400 })).toEqual({ price: 270.5, change: 2.5, changePct: 0.93, prevClose: 268, asOf: '2026-11-05T21:00:00.000Z' });
    expect(parseFinnhubQuote({ c: 0, d: null, dp: null, pc: 0, t: 0 })).toBeNull();
    expect(parseFinnhubQuote(null)).toBeNull();
    expect(shortExchange('NASDAQ NMS - GLOBAL MARKET')).toBe('NASDAQ');
    expect(shortExchange('NEW YORK STOCK EXCHANGE, INC.')).toBe('NYSE');
    expect(shortExchange(null)).toBe('');
  });

  it('con Finnhub no gasta créditos de Twelve Data; sin perfil (ETF), el nombre queda en el símbolo', async () => {
    const m = memoryKV();
    const fh = finnhub();
    const tw = twelve();
    const d = { kv: m.kv, now, finnhubKey: 'fh-key', fetch: fh.f };
    const r = await lookup(d, 'AAPL', { source: finnhubFirst(d, twelveSource(d, tw.get)) });
    expect(r.source).toBe('finnhub');
    expect(r.quote).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ', currency: 'USD', price: 270.5, changePct: 0.9328 });
    expect(r.credits.used).toBe(0);
    expect(await m.kv.get('budget', 'json')).toBeNull();
    expect(tw.asked).toEqual([]);
    // La clave de Finnhub va como `token`, como pide su API; a Twelve Data no se le pidió nada.
    expect(fh.calls.map((u) => u.pathname).sort()).toEqual(['/api/v1/quote', '/api/v1/stock/profile2']);
    expect(fh.calls.every((u) => u.searchParams.get('token') === 'fh-key')).toBe(true);
    const spy = await lookup(d, 'SPY', { source: finnhubFirst(d, twelveSource(d, tw.get)) });
    expect(spy.quote).toMatchObject({ name: 'SPY', price: 690.1 });
  });

  it('si Finnhub no lo tiene, falla o es una divisa, el precio sale de Twelve Data (1 crédito)', async () => {
    for (const [sym, status] of [['NOPE', 200], ['AAPL', 403], ['BTC/USD', 200]] as const) {
      const m = memoryKV();
      const tw = twelve();
      const fh = finnhub(status);
      const d = { kv: m.kv, now, finnhubKey: 'fh-key', fetch: fh.f };
      const r = await lookup(d, sym, { source: finnhubFirst(d, twelveSource(d, tw.get)) });
      expect(r.source, sym).toBe('twelvedata');
      expect(tw.asked, sym).toEqual([sym]);
      expect(r.credits.used, sym).toBe(1);
      if (sym === 'BTC/USD') expect(fh.calls).toEqual([]);
    }
    // Sin clave de Finnhub, directo a Twelve Data.
    const m = memoryKV();
    const tw = twelve();
    const d = { kv: m.kv, now };
    expect((await lookup(d, 'AAPL', { source: finnhubFirst(d, twelveSource(d, tw.get)) })).source).toBe('twelvedata');
  });
});

describe('rutas del buscador (local, con datos de prueba)', () => {
  function setup(role: 'owner' | 'friend') {
    const cache = memoryKV();
    const env = {
      CACHE: cache.kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      MOCK_DATA: 'true',
      ...(role === 'friend' ? { DEV_ROLE: 'friend' } : {}),
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
    const get = async (path: string) => {
      const res = await call('GET', path);
      return { status: res.status, body: (await res.json()) as any };
    };
    return { call, get, cache, storage };
  }

  it('dueño: busca por nombre, abre la ficha de una acción fuera de sus listas y recién ahí pide su historial', async () => {
    const { get, cache } = setup('owner');
    expect((await get('/api/search?q=apple')).body.results.map((m: { symbol: string }) => m.symbol)).toEqual(['AAPL', 'APLE']);
    expect((await get('/api/search?q=%3Cscript%3E')).status).toBe(400);

    expect((await get('/api/history?symbol=NVDA')).status).toBe(400);
    const r = await get('/api/lookup?symbol=nvda');
    expect(r.status).toBe(200);
    expect(r.body.quote.name).toBe('NVIDIA Corporation');
    // El precio del dueño sale de Finnhub (de prueba): no se gastó ningún crédito de Twelve Data.
    expect(r.body.source).toBe('finnhub');
    expect(r.body.credits.used).toBe(0);
    expect(r.body.lookups).toEqual({ used: 1, max: LOOKUP_DAILY_MAX, today: ['NVDA'] });
    for (const path of ['/api/history?symbol=NVDA&range=1A&ind=1', '/api/news/symbol?symbol=NVDA', '/api/company?symbol=NVDA', '/api/company/factors?symbol=NVDA']) {
      expect((await get(path)).status).toBe(200);
    }
    // Comparar sigue siendo con las listas.
    expect((await get('/api/compare?symbols=NVDA,SPY')).status).toBe(400);
    expect((await get('/api/lookup')).body).toEqual({ used: 1, max: LOOKUP_DAILY_MAX, today: ['NVDA'] });

    const none = await get('/api/lookup?symbol=ZZZZ');
    expect(none.status).toBe(200);
    expect(none.body.quote).toBeNull();
    expect(none.body.error).toMatch(/no encuentra ZZZZ/);
    expect((await get('/api/history?symbol=ZZZZ')).status).toBe(400);
    expect(Object.keys(JSON.parse(cache.store.get(LOOKUP_KEY)!))).toEqual(['NVDA', 'ZZZZ']);
  });

  it('amigo: busca igual (es de la SEC); abrir una ficha necesita su clave y queda en su parte del Durable Object', async () => {
    const { call, get, cache, storage } = setup('friend');
    expect((await get('/api/search?q=credicorp')).body.results).toEqual([{ symbol: 'BAP', name: 'CREDICORP LTD', cik: 1001290 }]);
    expect((await get('/api/lookup?symbol=NVDA')).status).toBe(403);

    await call('PUT', '/api/forecasts/name', { alias: 'Dani' });
    expect((await call('POST', '/api/games/liga', { action: 'conectar', key: 'abcdef0123456789abcdef0123456789' })).status).toBe(200);
    expect((await get('/api/history?symbol=NVDA')).status).toBe(400);
    expect((await get('/api/lookup?symbol=NVDA')).body.quote.symbol).toBe('NVDA');
    expect((await get('/api/history?symbol=NVDA&range=3M')).status).toBe(200);
    expect((await get('/api/news/symbol?symbol=NVDA')).status).toBe(200);
    // Finnhub sigue siendo solo del dueño.
    expect((await get('/api/company?symbol=NVDA')).status).toBe(403);
    expect((await get('/api/lookup')).body.today).toEqual(['NVDA']);

    expect(cache.store.has(LOOKUP_KEY)).toBe(false);
    const pid = await playerId('dev@localhost');
    expect(storage.data.has(`${PANEL}${pid}:${LOOKUP_KEY}`)).toBe(true);
  });
});
