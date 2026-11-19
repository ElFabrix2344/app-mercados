import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { PanelAmigo } from '../src/game/panel';
import worker from '../src/index';
import { parseIntraday, type IntradayBar } from '../src/lib/twelvedata';
import { fakeTwelve } from '../src/mock';
import { creditsUsed, intraday, shapeIntraday, type IntradayData } from '../src/services/market';
import { memoryKV, memoryStorage } from './helpers';

// Los rangos «1D» y «5D» de la ficha: velas dentro del día, pedidas aparte de los cierres diarios.

const row = (datetime: string, close: number, extra: Partial<Record<'open' | 'high' | 'low' | 'volume', string>> = {}) => ({ datetime, close: String(close), ...extra });

describe('las velas que manda Twelve Data', () => {
  it('llegan con la hora de la bolsa y de la más nueva a la más vieja: pasan a UTC y en orden', () => {
    const bars = parseIntraday({
      meta: { exchange_timezone: 'America/New_York' },
      values: [
        row('2026-11-19 15:55:00', 141.49, { open: '141.87', high: '141.96', low: '141.285', volume: '162235' }),
        row('2026-11-19 09:30:00', 140.1),
        row('2026-07-15 15:55:00', 120), // en verano Nueva York va 4 horas detrás de UTC
        { datetime: 'sin fecha', close: '1' },
        { datetime: '2026-11-19 10:00:00', close: 'x' },
      ],
    });
    expect(bars.map((b) => [b.t, b.day, b.close])).toEqual([
      ['2026-07-15T19:55:00.000Z', '2026-07-15', 120],
      ['2026-11-19T14:30:00.000Z', '2026-11-19', 140.1],
      ['2026-11-19T20:55:00.000Z', '2026-11-19', 141.49],
    ]);
    expect(bars[2]).toMatchObject({ open: 141.87, high: 141.96, low: 141.285, volume: 162235 });
    expect(bars[1]).toMatchObject({ open: null, volume: null });
    // Divisas y cripto: sin bolsa, ya vienen en UTC.
    expect(parseIntraday({ values: [row('2026-11-19 23:45:00', 91000)] })[0]!.t).toBe('2026-11-19T23:45:00.000Z');
    expect(() => parseIntraday({ status: 'error' })).toThrow('serie sin valores');
  });
});

/** Tres velas por rueda, a las 9:30, 12:00 y 15:55 de Nueva York (invierno). */
function sessions(days: string[]): IntradayBar[] {
  return days.flatMap((day, d) =>
    ['14:30', '17:00', '20:55'].map((hhmm, i) => ({ t: `${day}T${hhmm}:00.000Z`, day, open: 100 + d, high: 101 + d, low: 99 + d, close: 100 + d + i / 10, volume: 1000 })),
  );
}

describe('qué se muestra en cada rango', () => {
  const week = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];

  it('1D: la última rueda, con el cierre de la anterior; 5D: las últimas cinco', () => {
    const one = shapeIntraday('SCCO', '1D', '5min', sessions(week), '2026-11-19T21:10:00.000Z');
    expect(one.points.map(([t]) => t)).toEqual(['2026-11-19T14:30:00.000Z', '2026-11-19T17:00:00.000Z', '2026-11-19T20:55:00.000Z']);
    expect(one.prevClose).toBeCloseTo(105.2, 9); // la última vela del 18
    expect(one.bars.open).toHaveLength(3);
    expect(one).toMatchObject({ symbol: 'SCCO', range: '1D', interval: '5min' });
    const five = shapeIntraday('SCCO', '5D', '30min', sessions(week), '2026-11-19T21:10:00.000Z');
    expect(five.points).toHaveLength(15);
    expect(five.points[0]![0]).toBe('2026-11-13T14:30:00.000Z');
    expect(five.prevClose).toBeCloseTo(101.2, 9); // la última vela del 12
    // Si solo llegó una rueda, no hay cierre anterior.
    expect(shapeIntraday('SCCO', '1D', '5min', sessions(['2026-11-19']), 'x').prevClose).toBeNull();
  });

  it('divisas y cripto no tienen rueda: van todas las velas pedidas', () => {
    const r = shapeIntraday('BTC/USD', '1D', '15min', sessions(week), 'x');
    expect(r.points).toHaveLength(21);
    expect(r.prevClose).toBeNull();
  });
});

describe('pedirlas y guardarlas', () => {
  const body = { meta: { exchange_timezone: 'America/New_York' }, values: [row('2026-11-19 10:05:00', 142), row('2026-11-19 10:00:00', 141.5), row('2026-11-18 15:55:00', 140)] };
  const api = () => {
    const calls: URL[] = [];
    const f = (async (input: RequestInfo | URL) => {
      calls.push(new URL(String(input)));
      return Response.json(body);
    }) as typeof fetch;
    return { f, calls };
  };
  const at = (iso: string) => new Date(iso);

  it('cuesta 1 crédito y vence como un precio: a los 9 minutos con la bolsa abierta; cerrada, recién con otra rueda', async () => {
    const { f, calls } = api();
    const kv = memoryKV().kv;
    const d = (now: string) => ({ kv, now: at(now), twelveKey: 'clave', fetch: f });
    // Jueves 19 nov, 10:06 de Nueva York: bolsa abierta.
    const first = await intraday(d('2026-11-19T15:06:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ symbol: 'SCCO', interval: '5min', outputsize: '100' });
    expect(first.data).toMatchObject({ prevClose: 140, points: [['2026-11-19T15:00:00.000Z', 141.5], ['2026-11-19T15:05:00.000Z', 142]] });
    expect(await creditsUsed(kv, at('2026-11-19T15:06:00Z'))).toBe(1);
    await intraday(d('2026-11-19T15:12:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(1);
    await intraday(d('2026-11-19T15:16:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(2);
    // El otro rango se guarda aparte y pide velas más grandes.
    await intraday(d('2026-11-19T15:16:00Z'), 'SCCO', '5D');
    expect(Object.fromEntries(calls[2]!.searchParams)).toMatchObject({ interval: '30min', outputsize: '80' });
    // Después del cierre se pide una vez más (para la rueda completa) y ya no hasta el lunes.
    await intraday(d('2026-11-19T22:00:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(4);
    await intraday(d('2026-11-20T03:00:00Z'), 'SCCO', '1D');
    await intraday(d('2026-11-20T13:00:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(4);
    await intraday(d('2026-11-20T15:00:00Z'), 'SCCO', '1D');
    expect(calls).toHaveLength(5);
  });

  it('la cripto pide 24 horas en velas de 15 minutos; sin clave, error claro', async () => {
    const { f, calls } = api();
    await intraday({ kv: memoryKV().kv, now: at('2026-11-21T15:00:00Z'), twelveKey: 'clave', fetch: f }, 'BTC/USD', '1D');
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ symbol: 'BTC/USD', interval: '15min', outputsize: '96' });
    await expect(intraday({ kv: memoryKV().kv, now: at('2026-11-21T15:00:00Z'), fetch: f }, 'SCCO', '1D')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('un amigo las ve con su propia clave y de los símbolos de su lista', async () => {
    const panel = new PanelAmigo(memoryStorage(), async () => 'clave-del-amigo', { fetch: fakeTwelve, mock: true });
    const now = new Date();
    await panel.handle('ana', now, { op: 'save-watchlist', body: { symbols: ['NVDA'] } });
    const r = (await panel.handle('ana', now, { op: 'intraday', symbol: 'nvda', range: '5D' })) as { data: IntradayData };
    expect(r.data).toMatchObject({ symbol: 'NVDA', range: '5D', interval: '30min' });
    expect(r.data.points.length).toBeGreaterThan(40);
    expect(r.data.bars.volume).toHaveLength(r.data.points.length);
    await expect(panel.handle('ana', now, { op: 'intraday', symbol: 'AAPL', range: '1D' })).rejects.toMatchObject({ status: 400 });
    await expect(panel.handle('ana', now, { op: 'intraday', symbol: 'NVDA', range: '1M' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('la ruta', () => {
  it('en local responde velas de prueba de un símbolo de la lista; otro rango u otro símbolo, no', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true' } as unknown as Env;
    const get = (path: string) => worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext);
    const one = (await (await get('/api/intraday?symbol=SCCO&range=1D')).json()) as { data: IntradayData };
    expect(one.data).toMatchObject({ symbol: 'SCCO', range: '1D', interval: '5min', prevClose: expect.any(Number) });
    expect(one.data.points).toHaveLength(78);
    expect(one.data.bars.high).toHaveLength(78);
    const five = (await (await get('/api/intraday?symbol=SCCO&range=5D')).json()) as { data: IntradayData };
    expect(new Set(five.data.points.map(([t]) => t.slice(0, 10))).size).toBe(5);
    const btc = (await (await get('/api/intraday?symbol=BTC/USD&range=1D')).json()) as { data: IntradayData };
    expect(btc.data).toMatchObject({ interval: '15min', prevClose: null });
    expect(btc.data.points).toHaveLength(96);
    expect((await get('/api/intraday?symbol=SCCO&range=1M')).status).toBe(400);
    expect((await get('/api/intraday?symbol=TSLA&range=1D')).status).toBe(400);
  });
});
