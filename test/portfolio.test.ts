import { describe, expect, it } from 'vitest';
import type { QuotesData } from '../src/services/market';
import {
  addTrade,
  benchmarkTotal,
  closeOn,
  deleteTrade,
  ledger,
  readTrades,
  validateTrade,
  valuePortfolio,
  type PriceSource,
  type Trade,
} from '../src/services/portfolio';
import { memoryKV } from './helpers';

const trade = (date: string, symbol: string, side: 'buy' | 'sell', qty: number, price: number, id = `${date}-${side}`): Trade => ({
  id,
  date,
  symbol,
  side,
  qty,
  price,
});

/** Precios fijos: cotizaciones de la lista, cierres diarios y dólar a 3,75. */
function source(prices: Record<string, number>, closes: Record<string, [string, number][]> = {}): PriceSource {
  const quotes: QuotesData = {
    quotes: Object.entries(prices).map(([symbol, price]) => ({ symbol, name: symbol, exchange: 'NYSE', currency: 'USD', price }) as never),
    errors: {},
    symbols: Object.keys(prices),
    fetched: Object.fromEntries(Object.keys(prices).map((s) => [s, '2026-10-22T15:00:00.000Z'])),
  };
  return {
    quotes: async () => quotes,
    closes: async (symbol) => closes[symbol] ?? null,
    usdPen: async () => ({ rate: 3.75, source: 'prueba' }),
  };
}

describe('libro de operaciones (costo promedio)', () => {
  it('promedia las compras y calcula la ganancia de las ventas', () => {
    const h = ledger([trade('2026-01-05', 'BAP', 'buy', 10, 100), trade('2026-02-05', 'BAP', 'buy', 10, 120), trade('2026-03-05', 'BAP', 'sell', 5, 130)]).get('BAP')!;
    expect(h.qty).toBe(15);
    expect(h.cost).toBeCloseTo(15 * 110, 10);
    expect(h.realized).toBeCloseTo(5 * (130 - 110), 10);
    expect(h.proceeds).toBe(650);
    expect(h.invested).toBe(2200);
  });

  it('no deja vender más de lo que había en esa fecha (aunque después haya más compras)', () => {
    expect(() => ledger([trade('2026-03-05', 'BAP', 'sell', 1, 130), trade('2026-04-05', 'BAP', 'buy', 10, 100)])).toThrow(/No se puede vender/);
  });

  it('el cierre de un día sin rueda es el del día hábil anterior', () => {
    const pts: [string, number][] = [['2026-10-16', 1], ['2026-10-19', 2]];
    expect(closeOn(pts, '2026-10-18')).toBe(1);
    expect(closeOn(pts, '2026-10-19')).toBe(2);
    expect(closeOn(pts, '2026-10-01')).toBeNull();
  });
});

describe('comparación con el S&P 500', () => {
  it('hace las mismas compras y ventas en el SPY', () => {
    const spy: [string, number][] = [['2026-01-05', 100], ['2026-02-05', 110]];
    // 1.000 en BAP → 10 SPY. Vender la mitad de BAP saca la mitad de esos SPY a 110 (550). Quedan 5 SPY a 121.
    const total = benchmarkTotal([trade('2026-01-05', 'BAP', 'buy', 10, 100), trade('2026-02-05', 'BAP', 'sell', 5, 90)], spy, 121);
    expect(total).toBeCloseTo(550 + 5 * 121, 10);
  });

  it('sin historial del SPY para esa fecha no inventa nada', () => {
    expect(benchmarkTotal([trade('2020-01-02', 'BAP', 'buy', 1, 1)], [['2021-01-04', 1]], 1)).toBeNull();
  });
});

describe('validar operaciones', () => {
  const list = ['BAP', 'SPY', 'USD/PEN', 'BTC/USD'];
  const today = '2026-10-22';
  const ok = { date: '2026-10-01', symbol: 'bap', side: 'buy', qty: '2.5' };

  it('normaliza y acepta cripto en US$', () => {
    expect(validateTrade(ok, list, today)).toEqual({ date: '2026-10-01', symbol: 'BAP', side: 'buy', qty: 2.5, price: null });
    expect(validateTrade({ ...ok, symbol: 'BTC/USD', price: '65000' }, list, today).price).toBe(65000);
  });

  it('rechaza fechas futuras o inválidas, símbolos fuera de la lista o en soles y cantidades no positivas', () => {
    expect(() => validateTrade({ ...ok, date: '2026-10-23' }, list, today)).toThrow(/futura/);
    expect(() => validateTrade({ ...ok, date: '2026-02-30' }, list, today)).toThrow(/Fecha no válida/);
    expect(() => validateTrade({ ...ok, symbol: 'NVDA' }, list, today)).toThrow(/no está en tu lista/);
    expect(() => validateTrade({ ...ok, symbol: 'USD/PEN' }, list, today)).toThrow(/no cotiza en dólares/);
    expect(() => validateTrade({ ...ok, qty: 0 }, list, today)).toThrow(/cantidad/);
    expect(() => validateTrade({ ...ok, side: 'short' }, list, today)).toThrow(/compra o venta/);
  });
});

describe('guardar y borrar', () => {
  const list = ['BAP', 'SPY'];
  const now = new Date('2026-10-22T15:00:00Z');
  const closes: [string, number][] = [['2026-10-01', 200], ['2026-10-02', 210]];

  it('sin precio usa el cierre de ese día; si es hoy, el precio guardado de la lista', async () => {
    const { kv } = memoryKV();
    const src = source({ BAP: 250, SPY: 600 }, { BAP: closes });
    const a = await addTrade({ kv, now }, src, { date: '2026-10-02', symbol: 'BAP', side: 'buy', qty: 3 }, list);
    expect(a.price).toBe(210);
    const b = await addTrade({ kv, now }, src, { date: '2026-10-22', symbol: 'BAP', side: 'buy', qty: 1 }, list);
    expect(b.price).toBe(250);
    expect((await readTrades(kv)).map((t) => t.price)).toEqual([210, 250]);
  });

  it('no deja borrar una compra que respalda una venta posterior', async () => {
    const { kv } = memoryKV();
    const src = source({ BAP: 250 }, { BAP: closes });
    const buy = await addTrade({ kv, now }, src, { date: '2026-10-01', symbol: 'BAP', side: 'buy', qty: 3 }, list);
    const sell = await addTrade({ kv, now }, src, { date: '2026-10-02', symbol: 'BAP', side: 'sell', qty: 2 }, list);
    await expect(deleteTrade({ kv, now }, buy.id)).rejects.toThrow(/borra primero la venta/);
    await deleteTrade({ kv, now }, sell.id);
    await deleteTrade({ kv, now }, buy.id);
    expect(await readTrades(kv)).toEqual([]);
    await expect(deleteTrade({ kv, now }, 'no-existe')).rejects.toThrow(/ya no existe/);
  });
});

describe('valorizar', () => {
  it('suma posiciones, ventas, soles y la comparación con el SPY', async () => {
    const trades = [trade('2026-01-05', 'BAP', 'buy', 10, 100), trade('2026-02-05', 'BAP', 'sell', 5, 130), trade('2026-03-05', 'SCCO', 'buy', 2, 50)];
    const spy: [string, number][] = [['2026-01-05', 100], ['2026-02-05', 110], ['2026-03-05', 105]];
    const p = await valuePortfolio(trades, source({ BAP: 120, SCCO: 60, SPY: 121 }, { SPY: spy }));
    expect(p.positions.map((x) => [x.symbol, x.qty, x.value])).toEqual([
      ['BAP', 5, 600],
      ['SCCO', 2, 120],
    ]);
    const t = p.totals!;
    expect(t.invested).toBe(1100);
    expect(t.proceeds).toBe(650);
    expect(t.total).toBe(1370);
    expect(t.gain).toBe(270);
    expect(t.realized).toBe(150);
    expect(t.unrealized).toBe(120); // BAP 600 − 500 y SCCO 120 − 100
    expect(p.fx).toEqual({ rate: 3.75, source: 'prueba' });
    // SPY: 10 unidades por BAP, la mitad se vende a 110 (550); SCCO pone 100 a 105.
    expect(p.benchmark!.total).toBeCloseTo(550 + 5 * 121 + (100 / 105) * 121, 2);
  });

  it('sin operaciones no hay totales ni comparación', async () => {
    const p = await valuePortfolio([], source({ SPY: 1 }));
    expect(p.totals).toBeNull();
    expect(p.benchmark).toBeNull();
    expect(p.positions).toEqual([]);
  });
});
