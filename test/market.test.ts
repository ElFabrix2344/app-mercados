import { describe, expect, it } from 'vitest';
import { verifyAccess } from '../src/auth/access';
import type { Env } from '../src/env';
import { DAILY_CREDIT_CAP, history, quotes, rangeStart, sliceRange, validateWatchlist } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

const quoteBody = (symbol: string) => ({ symbol, name: symbol, exchange: 'NYSE', currency: 'USD', close: '10', last_quote_at: 1792162380 });
const batchFetch = () =>
  fakeFetch((url) => {
    const syms = url.searchParams.get('symbol')!.split(',');
    return { body: syms.length === 1 ? quoteBody(syms[0]!) : Object.fromEntries(syms.map((s) => [s, quoteBody(s)])) };
  });

describe('quotes (caché y freno)', () => {
  const t0 = new Date('2026-10-16T15:00:00Z');

  it('reutiliza la caché dentro de 9 minutos y cobra un crédito por símbolo', async () => {
    const { kv } = memoryKV();
    const { f, calls } = batchFetch();
    const d = { kv, now: t0, fetch: f, twelveKey: 'k' };
    await quotes(d, ['BAP', 'SPY'], false);
    const again = await quotes({ ...d, now: new Date(t0.getTime() + 60_000) }, ['BAP', 'SPY'], false);
    expect(calls).toHaveLength(1);
    expect(again.stale).toBe(false);
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-16', used: 2 });
  });

  it('«Actualizar» no renueva antes de 30 s, pero sí después', async () => {
    const { kv } = memoryKV();
    const { f, calls } = batchFetch();
    const d = { kv, now: t0, fetch: f, twelveKey: 'k' };
    await quotes(d, ['BAP'], false);
    await quotes({ ...d, now: new Date(t0.getTime() + 10_000) }, ['BAP'], true);
    expect(calls).toHaveLength(1);
    await quotes({ ...d, now: new Date(t0.getTime() + 40_000) }, ['BAP'], true);
    expect(calls).toHaveLength(2);
  });

  it('si se agrega un símbolo, pide solo ese y conserva los demás', async () => {
    const { kv } = memoryKV();
    const { f, calls } = batchFetch();
    const d = { kv, now: t0, fetch: f, twelveKey: 'k' };
    await quotes(d, ['BAP'], false);
    const r = await quotes(d, ['BAP', 'SPY'], false);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get('symbol')).toBe('SPY');
    expect(r.data.quotes.map((q) => q.symbol).sort()).toEqual(['BAP', 'SPY']);
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-16', used: 2 });
  });

  it('con `only` renueva solo esos símbolos y guarda la lista completa', async () => {
    const { kv } = memoryKV();
    const { f, calls } = batchFetch();
    const d = { kv, now: t0, fetch: f, twelveKey: 'k' };
    await quotes(d, ['BAP', 'SPY'], false);
    const later = { ...d, now: new Date(t0.getTime() + 10 * 60_000) };
    const r = await quotes(later, ['BAP', 'SPY'], false, ['SPY']);
    expect(calls.map((u) => u.searchParams.get('symbol'))).toEqual(['BAP,SPY', 'SPY']);
    expect(r.data.quotes.map((q) => q.symbol).sort()).toEqual(['BAP', 'SPY']);
    expect(r.data.fetched.BAP).toBe(t0.toISOString());
  });

  it('con el freno alcanzado muestra el último dato sin llamar a la API', async () => {
    const { kv } = memoryKV({
      budget: { day: '2026-10-16', used: DAILY_CREDIT_CAP },
      quotes: { fetchedAt: '2026-10-16T10:00:00.000Z', data: { quotes: [], errors: {}, symbols: ['BAP'] } },
    });
    const { f, calls } = batchFetch();
    const r = await quotes({ kv, now: t0, fetch: f, twelveKey: 'k' }, ['BAP'], false);
    expect(calls).toHaveLength(0);
    expect(r.stale).toBe(true);
    expect(r.note).toContain('Freno');
  });

  it('el contador de créditos se reinicia cada día (UTC)', async () => {
    const { kv } = memoryKV({ budget: { day: '2026-10-15', used: DAILY_CREDIT_CAP } });
    const { f, calls } = batchFetch();
    await quotes({ kv, now: t0, fetch: f, twelveKey: 'k' }, ['BAP'], false);
    expect(calls).toHaveLength(1);
  });

  it('sin clave y sin caché avisa qué falta', async () => {
    const { kv } = memoryKV();
    await expect(quotes({ kv, now: t0 }, ['BAP'], false)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('quotes con la bolsa de Nueva York cerrada', () => {
  // Viernes 16 oct 2026, 16:30 en NY (cerrada) y sábado 17 oct: NY está en UTC-4.
  const stored = (fetchedBySymbol: Record<string, string>) => ({
    quotes: {
      fetchedAt: Object.values(fetchedBySymbol)[0],
      data: {
        quotes: Object.keys(fetchedBySymbol).map((s) => ({ symbol: s, name: s, exchange: 'NYSE', currency: 'USD', price: 1 })),
        errors: {},
        symbols: Object.keys(fetchedBySymbol),
        fetched: fetchedBySymbol,
      },
    },
  });

  it('no vuelve a pedir acciones ya cerradas, pero sí divisas y cripto', async () => {
    const { kv } = memoryKV(stored({ BAP: '2026-10-16T20:30:00.000Z', 'USD/PEN': '2026-10-16T20:30:00.000Z' }));
    const { f, calls } = batchFetch();
    const r = await quotes({ kv, now: new Date('2026-10-17T15:00:00Z'), fetch: f, twelveKey: 'k' }, ['BAP', 'USD/PEN'], false);
    expect(calls.map((u) => u.searchParams.get('symbol'))).toEqual(['USD/PEN']);
    expect(r.market.open).toBe(false);
    expect(r.data.quotes.map((q) => q.symbol).sort()).toEqual(['BAP', 'USD/PEN']);
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-17', used: 1 });
  });

  it('«Actualizar» tampoco cobra acciones con la bolsa cerrada', async () => {
    const { kv } = memoryKV(stored({ BAP: '2026-10-16T20:30:00.000Z' }));
    const { f, calls } = batchFetch();
    await quotes({ kv, now: new Date('2026-10-17T15:00:00Z'), fetch: f, twelveKey: 'k' }, ['BAP'], true);
    expect(calls).toHaveLength(0);
  });

  it('después del cierre pide una vez más lo que se pidió en plena sesión (para tener el cierre)', async () => {
    const { kv } = memoryKV(stored({ BAP: '2026-10-16T19:55:00.000Z' })); // 15:55 en NY
    const { f, calls } = batchFetch();
    const d = { kv, fetch: f, twelveKey: 'k' };
    await quotes({ ...d, now: new Date('2026-10-16T20:02:00Z') }, ['BAP'], false); // 16:02: aún no pasan 9 min
    expect(calls).toHaveLength(0);
    await quotes({ ...d, now: new Date('2026-10-16T20:10:00Z') }, ['BAP'], false); // 16:10: toma el cierre
    expect(calls).toHaveLength(1);
    await quotes({ ...d, now: new Date('2026-10-16T21:30:00Z') }, ['BAP'], false); // ya no vuelve a pedir
    expect(calls).toHaveLength(1);
  });

  it('si hubo una sesión desde el último pedido, pide la acción aunque la bolsa esté cerrada', async () => {
    const { kv } = memoryKV(stored({ BAP: '2026-10-15T23:00:00.000Z' })); // jueves 19:00 en NY
    const { f, calls } = batchFetch();
    await quotes({ kv, now: new Date('2026-10-16T22:00:00Z'), fetch: f, twelveKey: 'k' }, ['BAP'], false); // viernes 18:00
    expect(calls).toHaveLength(1);
  });

  it('la primera vez pide todo aunque la bolsa esté cerrada', async () => {
    const { kv } = memoryKV();
    const { f, calls } = batchFetch();
    await quotes({ kv, now: new Date('2026-10-17T15:00:00Z'), fetch: f, twelveKey: 'k' }, ['BAP', 'BTC/USD'], false);
    expect(calls[0]!.searchParams.get('symbol')).toBe('BAP,BTC/USD');
  });
});

describe('history', () => {
  const series = [
    { datetime: '2026-10-15', close: '121' },
    { datetime: '2026-09-15', close: '115' },
    { datetime: '2025-12-31', close: '110' },
    { datetime: '2025-10-15', close: '100' },
    { datetime: '2021-10-15', close: '50' },
  ];

  it('pide 5 años hasta hoy (sin incluirlo) con 1 solo crédito, y por defecto muestra 1 año', async () => {
    const { kv } = memoryKV();
    const { f, calls } = fakeFetch(() => ({ body: { values: series, status: 'ok' } }));
    const r = await history({ kv, now: new Date('2026-10-16T15:00:00Z'), fetch: f, twelveKey: 'k' }, 'BAP');
    expect(calls[0]!.searchParams.get('start_date')! < '2021-10-16').toBe(true);
    expect(calls[0]!.searchParams.get('end_date')).toBe('2026-10-16');
    expect(r.range).toBe('1A');
    expect(r.data.points[0]).toEqual(['2025-10-15', 100]); // cierre base: el anterior al 16 oct 2025
    expect(r.stats!.totalReturn).toBeCloseTo(0.21, 10);
    expect(r.available).toEqual({ from: '2021-10-15', to: '2026-10-15' });
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-16', used: 1 });
  });

  it('los demás rangos salen de la misma caché, sin volver a pedir ni gastar créditos', async () => {
    const { kv } = memoryKV();
    const { f, calls } = fakeFetch(() => ({ body: { values: series, status: 'ok' } }));
    const d = { kv, now: new Date('2026-10-16T15:00:00Z'), fetch: f, twelveKey: 'k' };
    await history(d, 'BAP');
    const ytd = await history(d, 'BAP', 'YTD');
    const cinco = await history(d, 'BAP', '5A');
    expect(calls).toHaveLength(1);
    expect(ytd.stats!.totalReturn).toBeCloseTo(121 / 110 - 1, 10); // desde el cierre del 31 dic
    expect(cinco.stats!.totalReturn).toBeCloseTo(121 / 50 - 1, 10);
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-16', used: 1 });
  });
});

describe('rangos', () => {
  it('calcula el inicio de cada rango', () => {
    expect(rangeStart('1M', '2026-10-16')).toBe('2026-09-16');
    expect(rangeStart('3M', '2026-10-16')).toBe('2026-07-16');
    expect(rangeStart('YTD', '2026-10-16')).toBe('2026-01-01');
    expect(rangeStart('1A', '2026-10-16')).toBe('2025-10-16');
    expect(rangeStart('5A', '2026-10-16')).toBe('2021-10-16');
  });

  it('empieza en el último cierre anterior al inicio y, si falta historia, usa toda la que hay', () => {
    const pts: [string, number][] = [['2026-09-14', 1], ['2026-09-17', 2], ['2026-10-15', 3]];
    expect(sliceRange(pts, '1M', '2026-10-16')).toEqual(pts); // base: 14 sep (el 16 no hubo cierre)
    expect(sliceRange(pts.slice(1), '5A', '2026-10-16')).toEqual(pts.slice(1));
  });
});

describe('validateWatchlist', () => {
  it('normaliza, quita duplicados y limita a 8', () => {
    expect(validateWatchlist({ symbols: [' bap', 'usd/pen', 'BAP'] })).toEqual(['BAP', 'USD/PEN']);
    expect(() => validateWatchlist({ symbols: Array.from({ length: 9 }, (_, i) => `S${i}`) })).toThrow(/Máximo 8/);
    expect(() => validateWatchlist({ symbols: ['<script>'] })).toThrow(/no válido/);
    expect(() => validateWatchlist({ symbols: [] })).toThrow(/vacía/);
  });
});

describe('verifyAccess', () => {
  it('falla cerrado si ALLOWED_EMAILS está vacío', async () => {
    const env = { ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64), ALLOWED_EMAILS: ' ' } as Env;
    expect(await verifyAccess(new Request('https://m.example/'), env)).toMatchObject({ ok: false, status: 503 });
  });
});
