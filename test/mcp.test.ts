import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { handleMcp, localTime, monthEnds, type McpContext } from '../src/mcp';
import { EVENTS } from '../src/lib/calendar';
import { DAILY_CREDIT_CAP, DEFAULT_WATCHLIST, summarize } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

/** La herramienta de calendario solo aparece cuando hay fechas cargadas. */
const CALENDAR_TOOL = EVENTS.length ? ['calendario'] : [];

// Jueves 15 oct 2026, 11:00 en Nueva York (bolsa abierta) = 10:00 en Lima.
const NOW = new Date('2026-10-15T15:00:00Z');
const LONG_AGO = '2026-10-15T14:00:00.000Z';

const quoteBody = (symbol: string) => ({ symbol, name: symbol, exchange: 'NYSE', currency: 'USD', close: '10', percent_change: '1.2345', last_quote_at: 1792162380 });
const quotesFetch = () =>
  fakeFetch((url) => {
    const syms = url.searchParams.get('symbol')!.split(',');
    return { body: syms.length === 1 ? quoteBody(syms[0]!) : Object.fromEntries(syms.map((s) => [s, quoteBody(s)])) };
  });

/** Registro de precios guardado para toda la lista, pedido a la hora `at`. */
const storedQuotes = (at: string, symbols = DEFAULT_WATCHLIST) => ({
  fetchedAt: at,
  data: {
    quotes: symbols.map((s) => ({ symbol: s, name: s, exchange: 'NYSE', currency: 'USD', price: 1, changePct: 0.5, asOf: at })),
    errors: {},
    symbols,
    fetched: Object.fromEntries(symbols.map((s) => [s, at])),
  },
});

function ctx(kvInit: Record<string, unknown> = {}, f?: typeof fetch, keys = { twelveKey: 'k', fredKey: 'f' }, role: McpContext['role'] = 'owner') {
  const mem = memoryKV(kvInit);
  const c: McpContext = { deps: { kv: mem.kv, now: NOW, fetch: f, ...keys }, mock: false, timeZone: 'America/Lima', role };
  return { c, mem };
}

/** Llama al servidor MCP como lo hace Claude (JSON-RPC sobre Streamable HTTP, protocolo 2025-06-18). */
async function rpc(c: McpContext, method: string, params?: unknown) {
  const res = await handleMcp(
    new Request('https://mercados.example/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    c,
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = (res.headers.get('Content-Type') ?? '').includes('text/event-stream')
    ? text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)
    : text;
  return JSON.parse(data) as { result?: any; error?: any };
}

async function callTool(c: McpContext, name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc(c, 'tools/call', { name, arguments: args });
  const text: string = result.content[0].text;
  return { isError: !!result.isError, text, data: result.isError ? null : JSON.parse(text) };
}

describe('servidor MCP', () => {
  it('responde a initialize y lista sus herramientas de solo lectura', async () => {
    const { c } = ctx();
    const init = await rpc(c, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.serverInfo.name).toBe('rueda');
    const { result } = await rpc(c, 'tools/list');
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['precios', 'historial', 'comparar', 'cartera', 'peru_bcrp', 'eeuu_fred', 'noticias', ...CALENDAR_TOOL]);
    for (const t of result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it('a un amigo solo le ofrece las herramientas de datos públicos', async () => {
    const { f, calls } = quotesFetch();
    const { c } = ctx({ quotes: storedQuotes(LONG_AGO) }, f, undefined, 'friend');
    const { result } = await rpc(c, 'tools/list');
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['peru_bcrp', 'eeuu_fred', 'noticias', ...CALENDAR_TOOL]);
    const intento = await rpc(c, 'tools/call', { name: 'precios', arguments: {} });
    expect(JSON.stringify(intento)).not.toContain('"precio"');
    expect(calls).toHaveLength(0);
  });
});

describe('herramienta precios', () => {
  it('con la caché vigente no llama a Twelve Data y devuelve solo lo pedido, en ese orden', async () => {
    const { f, calls } = quotesFetch();
    const { c } = ctx({ quotes: storedQuotes('2026-10-15T14:58:00.000Z') }, f);
    const r = await callTool(c, 'precios', { simbolos: ['usd/pen', 'BAP'] });
    expect(calls).toHaveLength(0);
    expect(r.data.precios.map((p: { simbolo: string }) => p.simbolo)).toEqual(['USD/PEN', 'BAP']);
    expect(r.data.actualizado).toBe('2026-10-15 09:58');
    expect(r.data.creditos_hoy).toEqual({ usados: 0, freno: DAILY_CREDIT_CAP });
  });

  it('renueva solo los símbolos pedidos y conserva el resto de la lista en la caché', async () => {
    const { f, calls } = quotesFetch();
    const { c, mem } = ctx({ quotes: storedQuotes(LONG_AGO) }, f);
    const r = await callTool(c, 'precios', { simbolos: ['BAP'] });
    expect(calls.map((u) => u.searchParams.get('symbol'))).toEqual(['BAP']);
    expect(r.data.precios[0]).toMatchObject({ simbolo: 'BAP', precio: 10, variacion_pct: 1.23 });
    const saved = JSON.parse(mem.store.get('quotes')!);
    expect(saved.data.quotes.map((q: { symbol: string }) => q.symbol).sort()).toEqual([...DEFAULT_WATCHLIST].sort());
    expect(saved.data.fetched.SPY).toBe(LONG_AGO);
    expect(JSON.parse(mem.store.get('budget')!)).toEqual({ day: '2026-10-15', used: 1 });
  });

  it('sin argumentos devuelve toda la lista', async () => {
    const { c } = ctx({ quotes: storedQuotes('2026-10-15T14:58:00.000Z') });
    const r = await callTool(c, 'precios');
    expect(r.data.precios).toHaveLength(DEFAULT_WATCHLIST.length);
  });

  it('rechaza símbolos fuera de la lista sin gastar créditos y avisa cuáles quedaron fuera', async () => {
    const { f, calls } = quotesFetch();
    const { c } = ctx({ quotes: storedQuotes('2026-10-15T14:58:00.000Z') }, f);
    const solo = await callTool(c, 'precios', { simbolos: ['AAPL'] });
    expect(solo.isError).toBe(true);
    expect(solo.text).toContain('AAPL no está en la lista');
    const mixto = await callTool(c, 'precios', { simbolos: ['AAPL', 'BAP'] });
    expect(mixto.data.fuera_de_lista.simbolos).toEqual(['AAPL']);
    expect(mixto.data.precios.map((p: { simbolo: string }) => p.simbolo)).toEqual(['BAP']);
    expect(calls).toHaveLength(0);
  });

  it('con el freno de créditos alcanzado muestra lo guardado sin llamar a la API', async () => {
    const { f, calls } = quotesFetch();
    const { c } = ctx({ quotes: storedQuotes(LONG_AGO), budget: { day: '2026-10-15', used: DAILY_CREDIT_CAP } }, f);
    const r = await callTool(c, 'precios', { simbolos: ['BAP'] });
    expect(calls).toHaveLength(0);
    expect(r.data.dato_guardado).toBe(true);
    expect(r.data.nota).toContain('Freno');
  });
});

describe('herramienta historial', () => {
  const seriesFetch = () =>
    fakeFetch(() => ({
      body: {
        values: [
          { datetime: '2026-10-14', close: '110' },
          { datetime: '2026-09-30', close: '90' },
          { datetime: '2026-09-15', close: '120' },
          { datetime: '2025-10-15', close: '100' },
        ],
        status: 'ok',
      },
    }));

  it('da estadísticas en puntos porcentuales, cierres mensuales y cobra 1 crédito', async () => {
    const { f, calls } = seriesFetch();
    const { c, mem } = ctx({}, f);
    const r = await callTool(c, 'historial', { simbolo: 'bap' });
    expect(calls).toHaveLength(1);
    expect(r.data.simbolo).toBe('BAP');
    expect(r.data.estadisticas.rendimiento_total_pct).toBe(10);
    expect(r.data.estadisticas.maxima_caida).toEqual({ pct: -25, desde_el_pico_del: '2026-09-15', hasta_el: '2026-09-30' });
    expect(r.data.cierres).toEqual([['2025-10-15', 100], ['2026-09-30', 90], ['2026-10-14', 110]]);
    expect(JSON.parse(mem.store.get('budget')!)).toEqual({ day: '2026-10-15', used: 1 });
    // Con 4 cierres no alcanza para ningún indicador: van en null, no inventados.
    expect(r.data.indicadores_ultimo_cierre).toEqual({
      fecha: '2026-10-14',
      cierre: 110,
      mm50: null,
      mm200: null,
      cierre_vs_mm50_pct: null,
      cierre_vs_mm200_pct: null,
      rsi14: null,
      bollinger: null,
    });
  });

  it('da los indicadores del último cierre cuando hay historia suficiente', async () => {
    // 260 cierres subiendo 1 por día hasta el 14 oct 2026.
    const values = Array.from({ length: 260 }, (_, i) => ({
      datetime: new Date(Date.UTC(2026, 9, 14) - i * 86_400_000).toISOString().slice(0, 10),
      close: String(359 - i),
    }));
    const { f } = fakeFetch(() => ({ body: { values, status: 'ok' } }));
    const { c } = ctx({}, f);
    const r = await callTool(c, 'historial', { simbolo: 'BAP', rango: '1M', cierres: 'ninguno' });
    const ind = r.data.indicadores_ultimo_cierre;
    expect(ind).toMatchObject({ fecha: '2026-10-14', cierre: 359, mm50: 334.5, mm200: 259.5, rsi14: 100 });
    expect(ind.cierre_vs_mm200_pct).toBe(38.34); // 359 / 259,5 − 1
    expect(ind.bollinger.posicion_pct).toBeGreaterThan(50);
  });

  it('puede omitir los cierres', async () => {
    const { f } = seriesFetch();
    const { c } = ctx({}, f);
    const r = await callTool(c, 'historial', { simbolo: 'BAP', cierres: 'ninguno' });
    expect(r.data.cierres).toBeUndefined();
  });

  it('no pide historiales fuera de la lista', async () => {
    const { f, calls } = seriesFetch();
    const { c } = ctx({}, f);
    const r = await callTool(c, 'historial', { simbolo: 'NVDA' });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('herramienta comparar', () => {
  const days = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
  const seriesFor = (sym: string) =>
    days.map((datetime, i) => ({ datetime, close: String(sym === 'SPY' ? 500 + i * 5 : 100 + (i % 2) * 3) })).reverse();
  const fetchSeries = () => fakeFetch((url) => ({ body: { status: 'ok', values: seriesFor(url.searchParams.get('symbol')!) } }));

  it('da rendimiento, volatilidad, correlación y base 100 al cierre de cada mes', async () => {
    const { f, calls } = fetchSeries();
    const { c } = ctx({}, f);
    const r = await callTool(c, 'comparar', { simbolos: ['bap', 'SPY'], rango: '1M' });
    expect(calls).toHaveLength(2);
    expect(r.data.dias_en_comun).toBe(5);
    expect(r.data.simbolos.map((s: { simbolo: string }) => s.simbolo)).toEqual(['BAP', 'SPY']);
    expect(r.data.simbolos[1].rendimiento_total_pct).toBe(4);
    expect(r.data.correlacion_rendimientos_diarios.simbolos).toEqual(['BAP', 'SPY']);
    expect(r.data.correlacion_rendimientos_diarios.matriz[0][0]).toBe(1);
    expect(r.data.base_100_cierre_de_mes).toEqual({
      columnas: ['fecha', 'BAP', 'SPY'],
      filas: [
        ['2026-10-08', 100, 100],
        ['2026-10-14', 100, 104],
      ],
    });
  });

  it('no compara símbolos fuera de la lista ni gasta créditos', async () => {
    const { f, calls } = fetchSeries();
    const { c } = ctx({}, f);
    const r = await callTool(c, 'comparar', { simbolos: ['BAP', 'NVDA'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('NVDA no está en la lista');
    expect(calls).toHaveLength(0);
  });
});

describe('herramienta calendario', () => {
  it('da los próximos eventos con la hora de Lima y no llama a ninguna API', async () => {
    const { f, calls } = quotesFetch();
    const { c } = ctx({}, f, undefined, 'friend');
    const r = await callTool(c, 'calendario', { dias: 30 });
    expect(calls).toHaveLength(0);
    expect(r.data.zona_horaria).toBe('America/Lima');
    expect(r.data.eventos[0]).toMatchObject({ fecha: '2026-10-28', hora: '13:00', fuente: 'Reserva Federal (FOMC)' });
    expect(r.data.eventos.map((e: { fecha: string }) => e.fecha)).toEqual(['2026-10-28', '2026-11-01', '2026-11-10', '2026-11-12']);
    expect(r.data.eventos.find((e: { fecha: string }) => e.fecha === '2026-11-10').hora).toBe('08:30');
    expect(r.data.eventos.find((e: { fecha: string }) => e.fecha === '2026-11-12').hora).toBeNull();
    expect(r.data.cobertura.bcrp).toBe('2026-12-31');
  });
});

describe('herramientas de Perú y EE. UU.', () => {
  it('peru_bcrp usa la caché y da el último dólar interbancario', async () => {
    const { f, calls } = quotesFetch();
    const peru = {
      fetchedAt: '2026-10-15T12:00:00.000Z',
      data: {
        fx: [{ date: '2026-10-13', buy: 3.43, sell: 3.432 }, { date: '2026-10-14', buy: 3.4372, sell: 3.4391 }],
        policyRate: { date: '2026-10-14', value: 4.25 },
        inflation: [{ date: '2026-09-01', value: 1.54865469481509 }],
      },
    };
    const serie = (pts: [string, number][]) => ({ points: pts, summary: summarize(pts) });
    const copper: [string, number][] = [['2025-10-10', 4.5], ['2026-09-11', 6.3], ['2026-09-14', 6.4], ['2026-10-14', 6.62]];
    const markets = {
      fetchedAt: '2026-10-15T12:00:00.000Z',
      data: {
        copper: serie(copper),
        gold: serie([['2026-10-14', 4165.58]]),
        reserves: serie([['2026-10-14', 96654.6]]),
        bvl: serie([['2026-10-14', 59870.67]]),
        bond10pen: serie([['2025-10-10', 6.5], ['2026-10-14', 6.72]]),
        bond10usd: serie([['2026-10-14', 6.106]]),
        spread10: serie([['2025-10-10', 120], ['2026-10-14', 101.3]]),
      },
    };
    const { c } = ctx({ peru, 'peru-markets2': markets }, f);
    const r = await callTool(c, 'peru_bcrp');
    expect(calls).toHaveLength(0);
    expect(r.data.dolar_interbancario).toEqual({ fecha: '2026-10-14', compra: 3.4372, venta: 3.4391 });
    expect(r.data.tasa_de_referencia_pct).toEqual({ fecha: '2026-10-14', valor: 4.25 });
    expect(r.data.inflacion_lima_12_meses_pct).toEqual([['2026-09', 1.55]]);
    expect(r.data.actualizado).toBe('2026-10-15 07:00');
    expect(r.data.mercados.cobre_usd_por_libra).toEqual({
      fecha: '2026-10-14',
      valor: 6.62,
      variacion_1_mes_pct: 5.08, // frente al 11 set (el cierre anterior al 14 set)
      variacion_12_meses_pct: 47.11,
      cierres_mensuales: [['2025-10-10', 4.5], ['2026-09-14', 6.4], ['2026-10-14', 6.62]],
    });
    expect(r.data.mercados.indice_general_bvl.variacion_12_meses_pct).toBeNull();
    // Tasas en puntos porcentuales y riesgo país en puntos básicos.
    expect(r.data.mercados.bono_peru_10_anios_soles_pct).toMatchObject({ valor: 6.72, variacion_12_meses_pp: 0.22 });
    expect(r.data.mercados.riesgo_pais_aproximado_pb).toMatchObject({ valor: 101.3, variacion_12_meses_pb: -19 });
  });

  it('peru_bcrp entrega lo demás aunque fallen los mercados del BCRP', async () => {
    const f = (async () => new Response('caído', { status: 503 })) as typeof fetch;
    const peru = { fetchedAt: '2026-10-15T12:00:00.000Z', data: { fx: [], policyRate: { date: '2026-10-14', value: 4.25 }, inflation: [] } };
    const { c } = ctx({ peru }, f);
    const r = await callTool(c, 'peru_bcrp');
    expect(r.isError).toBe(false);
    expect(r.data.tasa_de_referencia_pct.valor).toBe(4.25);
    expect(r.data.mercados).toBeNull();
    expect(r.data.mercados_error).toContain('BCRP');
  });

  it('eeuu_fred avisa qué falta si no hay clave ni caché', async () => {
    const { c } = ctx({}, undefined, { twelveKey: 'k', fredKey: '' });
    const r = await callTool(c, 'eeuu_fred');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('FRED_API_KEY');
  });
});

describe('/mcp en el Worker', () => {
  const env = (extra: Partial<Env> = {}) =>
    ({ CACHE: memoryKV({ quotes: storedQuotes(LONG_AGO) }).kv, ASSETS: { fetch: async () => new Response('asset') }, TIMEZONE: 'America/Lima', ...extra }) as unknown as Env;
  const post = () =>
    new Request('https://mercados.example/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'precios', arguments: {} } }),
    });
  const ctxStub = {} as ExecutionContext;

  it('falla cerrado sin la configuración de Access', async () => {
    const res = await worker.fetch(post(), env(), ctxStub);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('precios');
  });

  it('sin token de Access no entrega datos', async () => {
    const res = await worker.fetch(
      post(),
      env({ ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64), ALLOWED_EMAILS: 'yo@example.com' }),
      ctxStub,
    );
    expect(res.status).toBe(401);
  });

  it('DEV_MODE no salta Access fuera de localhost', async () => {
    const res = await worker.fetch(post(), env({ DEV_MODE: 'true', MOCK_DATA: 'true' }), ctxStub);
    expect(res.status).toBe(503);
  });
});

describe('utilidades del conector', () => {
  it('monthEnds deja el último cierre de cada mes', () => {
    expect(monthEnds([['2026-09-29', 1], ['2026-09-30', 2], ['2026-10-01', 3]])).toEqual([['2026-09-30', 2], ['2026-10-01', 3]]);
  });

  it('localTime muestra la hora de Lima', () => {
    expect(localTime('2026-10-16T19:34:00Z', 'America/Lima')).toBe('2026-10-16 14:34');
    expect(localTime(null, 'America/Lima')).toBeNull();
  });
});
