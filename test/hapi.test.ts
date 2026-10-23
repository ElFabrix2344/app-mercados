import { describe, expect, it } from 'vitest';
import { orderFee } from '../src/lib/hapi';
import type { Quote } from '../src/lib/twelvedata';
import { accountLedger, addOp, deleteOp, hapiView, readAccount, updateSettings, validateOp, type HapiOp } from '../src/services/hapi';
import type { PriceSource } from '../src/services/portfolio';
import { memoryKV } from './helpers';

const NOW = new Date('2026-10-23T15:00:00Z');
const TODAY = '2026-10-23';
const ME = 'yo@example.com';
const FRIEND = 'amigo@example.com';

describe('orderFee', () => {
  it('compras: US$ 0,10 por acciones enteras y 0,15 por fracciones; con Prime, 0,05', () => {
    expect(orderFee('buy', 3, 100, '2026-10-20', 'standard').total).toBe(0.1);
    expect(orderFee('buy', 0.5, 100, '2026-10-20', 'standard').total).toBe(0.15);
    expect(orderFee('buy', 0.5, 100, '2026-10-20', 'prime').total).toBe(0.05);
  });

  it('ventas: suman la SEC y FINRA (al centavo hacia arriba), salvo la pausa de FINRA de fin de 2026', () => {
    // 10 × 500 = 5.000 vendidos → SEC 0,103 → 0,11; el TAF no se cobra en octubre de 2026.
    expect(orderFee('sell', 10, 500, '2026-10-20', 'standard')).toEqual({ clearing: 0.1, sec: 0.11, taf: 0, total: 0.21 });
    // En setiembre sí: 10 × 0,000195 = 0,00195 → 0,01.
    expect(orderFee('sell', 10, 500, '2026-09-20', 'standard')).toEqual({ clearing: 0.1, sec: 0.11, taf: 0.01, total: 0.22 });
    // Tope del TAF por orden.
    expect(orderFee('sell', 100_000, 1, '2027-01-04', 'prime')).toMatchObject({ sec: 2.06, taf: 9.79 });
  });
});

describe('validateOp', () => {
  it('completa los costos de Hapi y la retención de los dividendos', () => {
    expect(validateOp({ kind: 'buy', date: '2026-10-01', symbol: ' voo ', qty: '2', price: '500' }, 'standard', TODAY)).toEqual({
      kind: 'buy',
      date: '2026-10-01',
      symbol: 'VOO',
      qty: 2,
      price: 500,
      fee: 0.1,
    });
    expect(validateOp({ kind: 'dividend', date: '2026-10-01', symbol: 'VOO', amount: 10 }, 'standard', TODAY)).toMatchObject({ amount: 10, tax: 3, fee: 0 });
    expect(validateOp({ kind: 'deposit', date: '2026-10-01', amount: 1000, pen: 3800 }, 'standard', TODAY)).toEqual({ kind: 'deposit', date: '2026-10-01', amount: 1000, pen: 3800, fee: 1.99 });
    expect(validateOp({ kind: 'withdrawal', date: '2026-10-01', amount: 200, fee: 0 }, 'standard', TODAY)).toEqual({ kind: 'withdrawal', date: '2026-10-01', amount: 200, fee: 0 });
  });

  it('rechaza lo que no cuadra', () => {
    const bad = (x: object) => () => validateOp(x, 'standard', TODAY);
    expect(bad({ kind: 'buy', date: '2026-10-24', symbol: 'VOO', qty: 1, price: 1 })).toThrow('futura');
    expect(bad({ kind: 'buy', date: '2026-10-01', symbol: 'BTC/USD', qty: 1, price: 1 })).toThrow('símbolo');
    expect(bad({ kind: 'buy', date: '2026-10-01', symbol: 'VOO', price: 1 })).toThrow('Falta la cantidad');
    expect(bad({ kind: 'dividend', date: '2026-10-01', symbol: 'VOO', amount: 5, tax: 6 })).toThrow('retención');
    expect(bad({ kind: 'deposit', date: '2026-10-01', amount: 0 })).toThrow('monto');
    expect(bad({ kind: 'regalo', date: '2026-10-01' })).toThrow('tipo');
  });
});

describe('accountLedger', () => {
  let n = 0;
  const op = (o: Partial<HapiOp> & Pick<HapiOp, 'kind' | 'date'>): HapiOp => ({ id: String(n++), fee: 0, ...o });

  it('costo promedio con las comisiones, ganancia realizada neta, dividendos y efectivo', () => {
    const l = accountLedger([
      op({ kind: 'deposit', date: '2026-01-02', amount: 1000, pen: 3700, fee: 1.99 }),
      op({ kind: 'buy', date: '2026-01-05', symbol: 'VOO', qty: 2, price: 400, fee: 0.1 }),
      op({ kind: 'sell', date: '2026-03-02', symbol: 'VOO', qty: 1, price: 450, fee: 0.11 }),
      op({ kind: 'dividend', date: '2026-03-30', symbol: 'VOO', amount: 5, tax: 1.5 }),
    ]);
    const voo = l.positions.get('VOO')!;
    expect(voo.qty).toBe(1);
    expect(voo.cost).toBeCloseTo(400.05, 9);
    expect(voo.realized).toBeCloseTo(450 - 0.11 - 400.05, 9);
    expect(l.cash).toBeCloseTo(1000 - 800.1 + 449.89 + 3.5, 9);
    expect(l.pen).toBe(3700);
    expect(l.fees.orders).toBeCloseTo(0.21, 9);
    expect(l.fees.transfers).toBe(1.99);
    expect(l.dividends).toEqual({ gross: 5, tax: 1.5, net: 3.5 });
  });

  it('sin los soles de un depósito no hay rendimiento en soles; no deja vender más de lo que había', () => {
    expect(accountLedger([op({ kind: 'deposit', date: '2026-01-02', amount: 100, pen: 370 }), op({ kind: 'deposit', date: '2026-02-02', amount: 100 })]).pen).toBeNull();
    const early = [op({ kind: 'buy', date: '2026-01-05', symbol: 'VOO', qty: 1, price: 1 }), op({ kind: 'sell', date: '2026-01-04', symbol: 'VOO', qty: 1, price: 1 })];
    expect(() => accountLedger(early)).toThrow('vender más');
  });
});

describe('cuenta de Hapi en KV', () => {
  it('cada persona tiene la suya: nadie ve la de otro', async () => {
    const { kv } = memoryKV();
    await addOp(kv, ME, NOW, { kind: 'buy', date: '2026-10-01', symbol: 'VOO', qty: 1, price: 500 });
    expect((await readAccount(kv, ME)).ops).toHaveLength(1);
    expect((await readAccount(kv, FRIEND)).ops).toHaveLength(0);
    expect((await readAccount(kv, ' YO@example.com ')).ops).toHaveLength(1);
  });

  it('no se borra una compra que respalda una venta; el plan cambia los costos que se calculan', async () => {
    const { kv } = memoryKV();
    const buy = await addOp(kv, ME, NOW, { kind: 'buy', date: '2026-10-01', symbol: 'VOO', qty: 2, price: 500 });
    const sell = await addOp(kv, ME, NOW, { kind: 'sell', date: '2026-10-02', symbol: 'VOO', qty: 1, price: 510 });
    await expect(deleteOp(kv, ME, buy.id)).rejects.toThrow('borra primero la venta');
    await expect(addOp(kv, ME, NOW, { kind: 'sell', date: '2026-10-03', symbol: 'VOO', qty: 5, price: 510 })).rejects.toThrow('vender más');
    await updateSettings(kv, ME, NOW, { plan: 'prime' });
    expect((await addOp(kv, ME, NOW, { kind: 'buy', date: '2026-10-03', symbol: 'VOO', qty: 0.5, price: 500 })).fee).toBe(0.05);
    await deleteOp(kv, ME, sell.id);
    await deleteOp(kv, ME, buy.id);
    expect((await readAccount(kv, ME)).ops).toHaveLength(1);
    await expect(updateSettings(kv, ME, NOW, { plan: 'gold' })).rejects.toThrow('plan');
  });
});

describe('hapiView', () => {
  const quote = (symbol: string, price: number): Quote => ({
    symbol,
    name: symbol,
    exchange: 'NYSE',
    currency: 'USD',
    price,
    prevClose: price,
    change: 0,
    changePct: 0,
    isMarketOpen: true,
    low52: null,
    high52: null,
    asOf: NOW.toISOString(),
  });
  const prices = (map: Record<string, number>): PriceSource => ({
    quotes: async () => ({ quotes: Object.entries(map).map(([s, p]) => quote(s, p)), errors: {}, symbols: Object.keys(map), fetched: {} }),
    closes: async () => null,
    usdPen: async () => null,
  });
  const fx = async () => ({ rate: 3.8, date: '2026-10-22' });

  async function twoAccounts() {
    const { kv } = memoryKV();
    for (const e of [ME, FRIEND]) {
      await addOp(kv, e, NOW, { kind: 'deposit', date: '2026-09-01', amount: 1000, pen: 3700 });
      await addOp(kv, e, NOW, { kind: 'buy', date: '2026-09-02', symbol: 'VOO', qty: 2, price: 400 });
    }
    return kv;
  }

  it('el dueño la ve a precios de mercado', async () => {
    const kv = await twoAccounts();
    const v = await hapiView(kv, ME, { prices: () => prices({ VOO: 450 }), usdPen: fx });
    expect(v.priced).toBe(true);
    expect(v.positions[0]).toMatchObject({ symbol: 'VOO', qty: 2, cost: 800.1, price: 450, value: 900, gain: 99.9 });
    expect(v.totals).toMatchObject({ netDeposits: 1000, netPen: 3700, cash: 199.9, value: 900, account: 1099.9, unrealized: 99.9 });
    expect(v.totals!.fees).toEqual({ orders: 0.1, transfers: 1.99, total: 2.09 });
    expect(v.fx).toEqual({ rate: 3.8, date: '2026-10-22' });
  });

  it('un amigo, sin precios de mercado (licencia), a costo y con el valor que anotó de Hapi', async () => {
    const kv = await twoAccounts();
    await updateSettings(kv, FRIEND, NOW, { snapshot: { date: '2026-10-22', value: 1090 } });
    const v = await hapiView(kv, FRIEND, { prices: null, usdPen: fx });
    expect(v.priced).toBe(false);
    expect(v.positions[0]).toMatchObject({ cost: 800.1, price: null, value: null });
    expect(v.totals).toMatchObject({ cash: 199.9, value: null, account: null, unrealized: null });
    expect(v.snapshot).toEqual({ date: '2026-10-22', value: 1090 });
    await updateSettings(kv, FRIEND, NOW, { snapshot: null });
    expect((await hapiView(kv, FRIEND, { prices: null, usdPen: fx })).snapshot).toBeNull();
  });

  it('sin precio guardado de una posición no hay valor total, y se avisa', async () => {
    const kv = await twoAccounts();
    await addOp(kv, ME, NOW, { kind: 'buy', date: '2026-09-03', symbol: 'SCCO', qty: 1, price: 150 });
    const v = await hapiView(kv, ME, { prices: () => prices({ VOO: 450 }), usdPen: fx });
    expect(v.totals).toMatchObject({ value: null, account: null });
    expect(v.notes.join(' ')).toContain('SCCO');
  });
});
