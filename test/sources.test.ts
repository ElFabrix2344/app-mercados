import { describe, expect, it } from 'vitest';
import { getBcrp, lastWithValue, parseBcrpDate } from '../src/lib/bcrp';
import { getFred } from '../src/lib/fred';
import { ApiError } from '../src/lib/http';
import { getDailySeries, getQuotes } from '../src/lib/twelvedata';
import { fakeFetch } from './helpers';

const quoteBody = (symbol: string, close: string) => ({
  symbol,
  name: `${symbol} Inc`,
  exchange: 'NYSE',
  currency: 'USD',
  close,
  previous_close: '100',
  change: '1',
  percent_change: '1',
  last_quote_at: 1792162380,
  is_market_open: true,
  fifty_two_week: { low: '80', high: '120' },
});

describe('Twelve Data', () => {
  it('lee un lote de cotizaciones y separa los símbolos con error', async () => {
    const { f, calls } = fakeFetch(() => ({
      body: { BAP: quoteBody('BAP', '393.52'), XXX: { code: 400, message: 'symbol not found', status: 'error' } },
    }));
    const r = await getQuotes(['BAP', 'XXX'], 'k', f);
    expect(calls[0]!.searchParams.get('symbol')).toBe('BAP,XXX');
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]).toMatchObject({ symbol: 'BAP', price: 393.52, high52: 120, asOf: '2026-10-16T14:53:00.000Z' });
    expect(r.errors).toEqual({ XXX: 'symbol not found' });
  });

  it('con un solo símbolo la respuesta viene sin envolver', async () => {
    const { f } = fakeFetch(() => ({ body: quoteBody('BTC/USD', '82022.57') }));
    const r = await getQuotes(['BTC/USD'], 'k', f);
    expect(r.quotes[0]!.price).toBe(82022.57);
  });

  it('distingue límite por minuto y clave rechazada', async () => {
    const limited = fakeFetch(() => ({ status: 429, body: { code: 429, message: 'limit', status: 'error' } }));
    await expect(getQuotes(['BAP'], 'k', limited.f)).rejects.toMatchObject({ code: 'rate_limited' });
    const badKey = fakeFetch(() => ({ body: { code: 401, message: 'invalid key', status: 'error' } }));
    await expect(getQuotes(['BAP'], 'k', badKey.f)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('ordena la serie diaria de antigua a reciente, con apertura, máximo, mínimo y volumen', async () => {
    const { f } = fakeFetch(() => ({
      body: {
        meta: { symbol: 'BAP' },
        values: [
          { datetime: '2026-10-15', open: '384.17001', high: '392.95999', low: '380', close: '388.42', volume: '360200' },
          { datetime: '2026-10-14', close: '383.94' },
        ],
        status: 'ok',
      },
    }));
    expect(await getDailySeries('BAP', '2025-10-16', '2026-10-16', 'k', f)).toEqual([
      // Las divisas (y algunos días) no traen todo: lo que falta queda en null.
      { date: '2026-10-14', close: 383.94, open: null, high: null, low: null, volume: null },
      { date: '2026-10-15', close: 388.42, open: 384.17001, high: 392.95999, low: 380, volume: 360200 },
    ]);
  });
});

describe('BCRP', () => {
  it('entiende las fechas diarias y mensuales (incluido «Set»)', () => {
    expect(parseBcrpDate('14.Oct.26')).toBe('2026-10-14');
    expect(parseBcrpDate('30.Set.26')).toBe('2026-09-30');
    expect(parseBcrpDate('Sep.2026')).toBe('2026-09-01');
    expect(parseBcrpDate('Ago.2026')).toBe('2026-08-01');
    expect(parseBcrpDate('basura')).toBeNull();
  });

  it('convierte "n.d." en null y encuentra el último dato', async () => {
    const { f, calls } = fakeFetch(() => ({
      body: {
        config: { series: [{ name: 'compra' }, { name: 'venta' }] },
        periods: [
          { name: '14.Oct.26', values: ['3.4372', '3.4391'] },
          { name: '15.Oct.26', values: ['n.d.', 'n.d.'] },
        ],
      },
    }));
    const pts = await getBcrp(['PD04637PD', 'PD04638PD'], '2026-10-01', '2026-10-16', f);
    expect(calls[0]!.pathname).toBe('/estadisticas/series/api/PD04637PD-PD04638PD/json/2026-10-01/2026-10-16/esp');
    expect(pts[1]!.values).toEqual([null, null]);
    expect(lastWithValue(pts, 1)).toEqual({ date: '2026-10-14', value: 3.4391 });
  });

  it('pide las series ordenadas por código y devuelve los valores en el orden pedido', async () => {
    // Como BCRPData: responde ordenado por código (reservas PD04650MD, cobre PD04701XD, oro PD04704XD).
    const { f, calls } = fakeFetch(() => ({
      body: { periods: [{ name: '16.Oct.26', values: ['96654.6', '662.0', '4165.58'] }] },
    }));
    const pts = await getBcrp(['PD04701XD', 'PD04704XD', 'PD04650MD'], '2026-10-01', '2026-10-16', f);
    expect(calls[0]!.pathname).toBe('/estadisticas/series/api/PD04650MD-PD04701XD-PD04704XD/json/2026-10-01/2026-10-16/esp');
    expect(pts).toEqual([{ date: '2026-10-16', values: [662, 4165.58, 96654.6] }]);
  });

  it('ignora el aviso HTML de PHP que el BCRP pega después del JSON', async () => {
    const json = '{\n"config":{"series":[{"name":"IPC {var%}"}]},\n"periods":[{"name":"Sep.2026","values":["4.54865469481509"]}]\n}';
    const f = (async () =>
      new Response(`${json}<br />\n<font size='1'><table class='xdebug-error xe-notice'><tr><th>Notice: Undefined offset</th></tr></table></font>`, {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      })) as typeof fetch;
    expect(await getBcrp(['PN01273PM'], '2025-08', '2026-10', f)).toEqual([{ date: '2026-09-01', values: [4.54865469481509] }]);
  });
});

describe('FRED', () => {
  it('omite los días sin dato (".")', async () => {
    const { f, calls } = fakeFetch(() => ({
      body: { observations: [{ date: '2026-10-14', value: '4.05' }, { date: '2026-10-15', value: '.' }] },
    }));
    expect(await getFred('DGS10', { start: '2026-10-01' }, 'key', f)).toEqual([{ date: '2026-10-14', value: 4.05 }]);
    expect(calls[0]!.searchParams.get('file_type')).toBe('json');
  });

  it('muestra el mensaje de error de FRED', async () => {
    const { f } = fakeFetch(() => ({ status: 400, body: { error_message: 'Bad Request. The value for variable api_key is not registered.' } }));
    const err = await getFred('DGS10', { start: '2026-10-01' }, 'bad', f).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('api_key is not registered');
  });
});
