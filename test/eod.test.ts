import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { lastClosedSession } from '../src/lib/market-hours';
import { EOD_MAX, EOD_PER_RUN, eodTarget, knownSymbols, refreshEod, shapeEod, summarizeHistory, validateEodList, type EodSummary } from '../src/services/eod';
import type { Deps } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

describe('lastClosedSession', () => {
  it('la sesión de hoy cuenta como cerrada recién después del cierre más el margen', () => {
    // Jueves 22 oct 2026: la bolsa cierra a las 16:00 de NY (20:00 UTC).
    expect(lastClosedSession(new Date('2026-10-22T15:00:00Z'))).toBe('2026-10-21'); // en plena sesión
    expect(lastClosedSession(new Date('2026-10-22T20:20:00Z'), 30)).toBe('2026-10-21'); // cerró hace 20 min
    expect(lastClosedSession(new Date('2026-10-22T20:31:00Z'), 30)).toBe('2026-10-22');
    // Lunes antes de la apertura: el viernes.
    expect(lastClosedSession(new Date('2026-10-26T12:00:00Z'))).toBe('2026-10-23');
    // Jueves de Acción de Gracias (feriado): el miércoles.
    expect(lastClosedSession(new Date('2026-11-26T22:00:00Z'))).toBe('2026-11-25');
  });
});

describe('validateEodList', () => {
  it('normaliza, quita repetidos y deja la lista vacía', () => {
    expect(validateEodList({ symbols: ['nvda', ' AAPL', 'NVDA', 'eth/usd'] }, ['BAP'])).toEqual(['NVDA', 'AAPL', 'ETH/USD']);
    expect(validateEodList({ symbols: [] }, ['BAP'])).toEqual([]);
  });

  it('rechaza símbolos de la lista de seguimiento, inválidos o de más', () => {
    expect(() => validateEodList({ symbols: ['NVDA', 'BAP'] }, ['BAP'])).toThrow('BAP ya está en tu lista de seguimiento');
    expect(() => validateEodList({ symbols: ['no válido'] }, [])).toThrow('Símbolo no válido');
    expect(() => validateEodList({ symbols: Array.from({ length: EOD_MAX + 1 }, (_, i) => `S${i}`) }, [])).toThrow(`Máximo ${EOD_MAX}`);
    expect(() => validateEodList(null, [])).toThrow('Envía');
  });
});

describe('eodTarget', () => {
  it('acciones: el último cierre firme de Nueva York; cripto y divisas: ayer (UTC)', () => {
    const now = new Date('2026-10-22T21:00:00Z');
    expect(eodTarget('NVDA', now)).toBe('2026-10-22');
    expect(eodTarget('ETH/USD', now)).toBe('2026-10-21');
    expect(eodTarget('NVDA', new Date('2026-10-22T20:10:00Z'))).toBe('2026-10-21');
  });
});

describe('summarizeHistory', () => {
  it('último cierre, el anterior, el cierre de cada semana del año y el rendimiento de 1 año', () => {
    // Un cierre por día hábil desde el 1 oct 2025, subiendo 1 por día.
    const points: [string, number][] = [];
    for (let i = 0, d = new Date(Date.UTC(2025, 9, 1)); points.length < 270; d = new Date(d.getTime() + 86_400_000), i++) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) points.push([d.toISOString().slice(0, 10), 100 + points.length]);
    }
    const r = summarizeHistory({ symbol: 'NVDA', points }, 'NVIDIA', '2026-10-22', '2026-10-22T21:00:00.000Z', '2026-10-22')!;
    const last = points.at(-1)!;
    expect(r).toMatchObject({ symbol: 'NVDA', name: 'NVIDIA', date: last[0], close: last[1], prevClose: last[1] - 1, checked: '2026-10-22' });
    // Una semana = un punto (el último de la semana), y el último cierre siempre está.
    expect(r.spark.length).toBeGreaterThan(50);
    expect(r.spark.length).toBeLessThan(56);
    expect(r.spark.at(-1)).toEqual(last);
    // Desde el último cierre anterior al 22 oct 2025.
    const base = points.filter(([d]) => d < '2025-10-22').at(-1)!;
    expect(r.ret1y).toBeCloseTo(last[1] / base[1] - 1, 10);
  });
});

/** Twelve Data falso: cierres diarios hasta el día anterior a `end_date` (así trabaja la API). */
const series = (lastBySymbol: Record<string, string> = {}) =>
  fakeFetch((url) => {
    const symbol = url.searchParams.get('symbol')!;
    const end = lastBySymbol[symbol] ?? new Date(Date.parse(`${url.searchParams.get('end_date')}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const prev = new Date(Date.parse(`${end}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return {
      body: {
        values: [
          { datetime: end, open: '101', high: '103', low: '99', close: '102', volume: '1000' },
          { datetime: prev, open: '99', high: '101', low: '98', close: '100', volume: '900' },
        ],
        status: 'ok',
      },
    };
  });

describe('refreshEod', () => {
  // Jueves 22 oct, 17:00 en NY: la sesión del día ya cerró y quedó firme.
  const NOW = new Date('2026-10-22T21:00:00Z');
  const LIST = ['NVDA', 'AAPL', 'EPU', 'ETH/USD', 'MSFT', 'AMZN', 'GOOG'];

  it('pide de a pocos (primero los que nunca se cargaron), hasta el día del cierre inclusive, y no repite', async () => {
    const mem = memoryKV({ 'watchlist-eod': LIST });
    const { f, calls } = series();
    const d: Deps = { kv: mem.kv, now: NOW, fetch: f, twelveKey: 'k' };

    const first = await refreshEod(d);
    expect(first.refreshed).toEqual(LIST.slice(0, EOD_PER_RUN));
    expect(calls).toHaveLength(EOD_PER_RUN);
    // Acciones: hasta el 22 inclusive (end_date no incluye su día). Cripto: hasta ayer (21).
    expect(calls.find((u) => u.searchParams.get('symbol') === 'NVDA')!.searchParams.get('end_date')).toBe('2026-10-23');
    expect(calls.find((u) => u.searchParams.get('symbol') === 'ETH/USD')!.searchParams.get('end_date')).toBe('2026-10-22');

    const second = await refreshEod(d);
    expect(second.refreshed).toEqual(['AMZN', 'GOOG']);

    const summary = JSON.parse(mem.store.get('eod')!) as EodSummary;
    expect(Object.keys(summary.rows).sort()).toEqual([...LIST].sort());
    expect(summary.rows.NVDA).toMatchObject({ date: '2026-10-22', close: 102, prevClose: 100, checked: '2026-10-22' });
    expect(summary.rows['ETH/USD']).toMatchObject({ date: '2026-10-21', checked: '2026-10-21' });

    // Todo al día: no pide ni escribe nada.
    const writes = mem.writes();
    expect((await refreshEod(d)).refreshed).toEqual([]);
    expect(calls).toHaveLength(LIST.length);
    expect(mem.writes()).toBe(writes);
  });

  it('si un símbolo no cotizó ese día, lo marca como revisado y no lo vuelve a pedir', async () => {
    const mem = memoryKV({ 'watchlist-eod': ['NVDA'] });
    const { f, calls } = series({ NVDA: '2026-10-21' });
    const d: Deps = { kv: mem.kv, now: NOW, fetch: f, twelveKey: 'k' };
    await refreshEod(d);
    await refreshEod(d);
    expect(calls).toHaveLength(1);
    expect((JSON.parse(mem.store.get('eod')!) as EodSummary).rows.NVDA).toMatchObject({ date: '2026-10-21', checked: '2026-10-22' });
  });

  it('al guardar solo pide los nuevos, y borra del resumen lo que salió de la lista', async () => {
    const old: EodSummary = {
      rows: {
        NVDA: { symbol: 'NVDA', name: null, date: '2026-10-20', close: 1, prevClose: 1, spark: [], ret1y: null, checked: '2026-10-20', fetchedAt: '2026-10-20T21:00:00.000Z' },
        TSLA: { symbol: 'TSLA', name: null, date: '2026-10-22', close: 1, prevClose: 1, spark: [], ret1y: null, checked: '2026-10-22', fetchedAt: '2026-10-22T21:00:00.000Z' },
      },
    };
    const mem = memoryKV({ 'watchlist-eod': ['NVDA', 'AAPL'], eod: old });
    const { f, calls } = series();
    const r = await refreshEod({ kv: mem.kv, now: NOW, fetch: f, twelveKey: 'k' }, { max: 4, onlyNew: true });
    expect(r.refreshed).toEqual(['AAPL']); // NVDA está vencido, pero eso lo hace la tarea programada
    expect(calls).toHaveLength(1);
    const summary = JSON.parse(mem.store.get('eod')!) as EodSummary;
    expect(Object.keys(summary.rows).sort()).toEqual(['AAPL', 'NVDA']);
  });

  it('los símbolos que pasaron a la lista de seguimiento no se piden aquí', async () => {
    const mem = memoryKV({ 'watchlist-eod': ['BAP', 'NVDA'] }); // BAP está en la lista por defecto
    const { f, calls } = series();
    await refreshEod({ kv: mem.kv, now: NOW, fetch: f, twelveKey: 'k' });
    expect(calls.map((u) => u.searchParams.get('symbol'))).toEqual(['NVDA']);
    expect(await knownSymbols(mem.kv)).toEqual(['BAP', 'SCCO', 'BVN', 'SPY', 'USD/PEN', 'BTC/USD', 'NVDA']);
  });
});

describe('shapeEod', () => {
  it('una fila por símbolo, en orden, con la variación del día; «pendiente» si no tiene cierre', () => {
    const summary: EodSummary = {
      rows: { NVDA: { symbol: 'NVDA', name: 'NVIDIA', date: '2026-10-22', close: 110, prevClose: 100, spark: [['2026-10-22', 110]], ret1y: 0.5, checked: '2026-10-22', fetchedAt: '' } },
    };
    const v = shapeEod(['AAPL', 'NVDA'], summary);
    expect(v.rows[0]).toEqual({ symbol: 'AAPL', pending: true });
    expect(v.rows[1]).toMatchObject({ symbol: 'NVDA', pending: false, close: 110, change: 10, ret1y: 0.5 });
    expect((v.rows[1] as { changePct: number }).changePct).toBeCloseTo(10, 10);
  });
});

describe('tarea programada', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renueva la lista diaria con la hora de la ejecución', async () => {
    const mem = memoryKV({ 'watchlist-eod': ['NVDA'] });
    const { f, calls } = series();
    vi.stubGlobal('fetch', f);
    const env = { CACHE: mem.kv, TIMEZONE: 'America/Lima', TWELVE_DATA_API_KEY: 'k' } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const controller = { scheduledTime: Date.parse('2026-10-22T21:00:00Z'), cron: '*/10 * * * *', noRetry() {} } as ScheduledController;
    await worker.scheduled(controller, env, ctx);
    await Promise.all(pending);
    expect(calls.map((u) => u.searchParams.get('end_date'))).toEqual(['2026-10-23']);
    expect((JSON.parse(mem.store.get('eod')!) as EodSummary).rows.NVDA).toMatchObject({ date: '2026-10-22', checked: '2026-10-22' });
  });
});