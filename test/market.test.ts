import { describe, expect, it } from 'vitest';
import { verifyAccess } from '../src/auth/access';
import type { Env } from '../src/env';
import {
  DAILY_CREDIT_CAP,
  compare,
  compareSymbols,
  history,
  peruMarkets,
  quotes,
  rangeStart,
  rangeStartIndex,
  shapeCompare,
  sliceRange,
  summarize,
  validateWatchlist,
} from '../src/services/market';
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
    expect(rangeStartIndex(['2026-01-02', '2026-01-05'], '1M', '2026-10-16')).toBe(1); // nada en el rango: el último
    expect(rangeStartIndex([], '1A', '2026-10-16')).toBe(0);
  });
});

describe('history con indicadores', () => {
  it('calcula los indicadores con los 5 años y los recorta igual que los cierres', async () => {
    // 300 días hábiles subiendo 1 por día: la media de 200 del último cierre es conocida.
    const values = Array.from({ length: 300 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 7, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { datetime: d, close: String(100 + i) };
    }).reverse();
    const { kv } = memoryKV();
    const { f } = fakeFetch(() => ({ body: { values, status: 'ok' } }));
    const r = await history({ kv, now: new Date('2026-05-28T15:00:00Z'), fetch: f, twelveKey: 'k' }, 'BAP', '1M');
    const n = r.data.points.length;
    expect(n).toBeGreaterThan(20);
    expect(r.indicators.sma200).toHaveLength(n);
    expect(r.indicators.sma200.at(-1)).toBeCloseTo(399 - 99.5, 6); // media de 200..399
    expect(r.indicators.sma50.at(-1)).toBeCloseTo(399 - 24.5, 6);
    expect(r.indicators.rsi14.at(-1)).toBe(100);
  });
});

describe('comparar', () => {
  // Acción L–V y cripto todos los días, del 1 al 14 de octubre de 2026.
  const days = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
  const stock: [string, number][] = days.filter(weekday).map((d, i) => [d, 100 + (i % 2 ? 2 : -1) * i]);
  const crypto: [string, number][] = days.map((d, i) => [d, 50 + i]);

  it('alinea por fecha, recorta el rango y mide todo con los mismos días', () => {
    const r = shapeCompare(
      [
        { symbol: 'BAP', points: stock },
        { symbol: 'BTC/USD', points: crypto },
      ],
      '5A',
      '2026-10-15',
    );
    expect(r.dates).toEqual(days.filter(weekday));
    expect(r.series[1]!.closes).toEqual(r.dates.map((d) => crypto.find(([x]) => x === d)![1]));
    expect(r.series.map((s) => s.rebased[0])).toEqual([100, 100]);
    expect(r.series[0]!.stats!.totalReturn).toBeCloseTo(stock.at(-1)![1] / stock[0]![1] - 1, 10);
    expect(r.correlation[0]![0]).toBe(1);
    expect(r.correlation[0]![1]).toBe(r.correlation[1]![0]);
    expect(Math.abs(r.correlation[0]![1]!)).toBeLessThanOrEqual(1);
  });

  it('una serie contra sí misma escalada tiene correlación 1', () => {
    const doubled: [string, number][] = stock.map(([d, v]) => [d, v * 2]);
    const r = shapeCompare(
      [
        { symbol: 'A', points: stock },
        { symbol: 'B', points: doubled },
      ],
      '5A',
      '2026-10-15',
    );
    expect(r.correlation[0]![1]).toBe(1);
  });

  it('pide cada símbolo una vez (1 crédito cada uno) y compara el resto si uno falla', async () => {
    const { kv } = memoryKV();
    const { f, calls } = fakeFetch((url) => {
      const sym = url.searchParams.get('symbol');
      if (sym === 'BVN') return { status: 200, body: { status: 'error', code: 404, message: 'symbol not found' } };
      const pts = sym === 'BTC/USD' ? crypto : stock;
      return { body: { status: 'ok', values: [...pts].reverse().map(([datetime, close]) => ({ datetime, close: String(close) })) } };
    });
    const d = { kv, now: new Date('2026-10-15T15:00:00Z'), fetch: f, twelveKey: 'k' };
    const r = await compare(d, ['BAP', 'BTC/USD', 'BVN'], '1M');
    expect(calls).toHaveLength(3);
    expect(r.series.map((s) => s.symbol)).toEqual(['BAP', 'BTC/USD']);
    expect(Object.keys(r.errors)).toEqual(['BVN']);
    expect(await kv.get('budget', 'json')).toEqual({ day: '2026-10-15', used: 2 });

    // La segunda vez sale de la caché: no pide ni gasta.
    await compare(d, ['BAP', 'BTC/USD'], '1A');
    expect(calls).toHaveLength(3);
    await expect(compare(d, ['BVN', 'NADA'], '1A')).rejects.toThrow();
  });

  it('valida la selección', () => {
    expect(compareSymbols([' bap', 'SPY', 'BAP'])).toEqual(['BAP', 'SPY']);
    expect(() => compareSymbols(['BAP'])).toThrow(/de 2 a 4/);
    expect(() => compareSymbols(['A', 'B', 'C', 'D', 'E'])).toThrow(/de 2 a 4/);
  });
});

describe('Perú: cobre, oro, reservas y BVL', () => {
  it('pide las 4 series en un solo pedido, pasa el cobre a US$ por libra y calcula variaciones', async () => {
    // BCRPData responde ordenado por código: reservas, cobre (centavos), oro, BVL.
    const { f, calls } = fakeFetch(() => ({
      body: {
        periods: [
          { name: '10.Oct.25', values: ['80000', '450', '2500', '30000'] },
          { name: '15.Set.26', values: ['95000', '640', '4000', 'n.d.'] },
          { name: '16.Oct.26', values: ['96654.60272427', '662.018070575889', '4165.58', '59870.67'] },
        ],
      },
    }));
    const { kv } = memoryKV();
    const r = await peruMarkets({ kv, now: new Date('2026-10-17T15:00:00Z'), fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toContain('/PD04650MD-PD04701XD-PD04704XD-PD38026MD/json/');
    const m = r.data;
    expect(m.copper.points.at(-1)).toEqual(['2026-10-16', 6.6202]);
    expect(m.reserves.summary.last).toEqual({ date: '2026-10-16', value: 96654.6027 });
    expect(m.copper.summary.y1).toMatchObject({ date: '2025-10-10', value: 4.5 });
    expect(m.copper.summary.y1!.pct).toBeCloseTo(6.6202 / 4.5 - 1, 10);
    expect(m.copper.summary.m1).toMatchObject({ date: '2026-09-15', value: 6.4 });
    // La BVL no tiene dato a mediados de setiembre: sin base cercana no se inventa la variación del mes.
    expect(m.bvl.points).toHaveLength(2);
    expect(m.bvl.summary.m1).toBeNull();
    expect(m.bvl.summary.y1!.pct).toBeCloseTo(59870.67 / 30000 - 1, 10);
  });

  it('sin historia suficiente no hay variación a 12 meses', () => {
    const s = summarize([['2026-06-01', 10], ['2026-10-15', 12]]);
    expect(s.last).toEqual({ date: '2026-10-15', value: 12 });
    expect(s.y1).toBeNull();
    expect(summarize([])).toEqual({ last: null, m1: null, y1: null });
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
