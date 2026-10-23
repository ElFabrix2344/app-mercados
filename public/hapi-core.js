// Cuenta de Hapi: comisiones, validación, libro de movimientos y lo que se muestra. Corre en el navegador de cada uno
// porque la cuenta se guarda cifrada con su frase: el servidor no puede leerla. Sin DOM, para probarlo con vitest.
//
// Comisiones de Hapi para acciones y ETF en horario regular, según su centro de ayuda (help.hapi.trade, octubre de
// 2026). Son el valor por defecto al anotar; cada una se corrige con lo que diga la confirmación de Hapi.

export const PLANS = ['standard', 'prime'];
export const KINDS = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'];
export const MAX_OPS = 2000;
/** Las operaciones más viejas que se aceptan (Hapi abrió en 2021). */
const MIN_DATE = '2015-01-01';
const EPS = 1e-9;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

/** Cargo de compensación por orden, en US$: acciones enteras o fracciones (con Prime, lo mismo para ambas). */
const CLEARING = { standard: { whole: 0.1, fraction: 0.15 }, prime: { whole: 0.05, fraction: 0.05 } };
/** Cargo de la SEC en las ventas: US$ 20,60 por millón vendido, vigente desde el 4 de abril de 2026. */
export const SEC_FEE_RATE = 20.6 / 1_000_000;
/** FINRA TAF en las ventas: por acción vendida, con tope por orden; no se cobra del 1 oct al 31 dic 2026. */
export const TAF_PER_SHARE = 0.000195;
export const TAF_MAX = 9.79;
const TAF_PAUSE = { from: '2026-10-01', to: '2026-12-31' };
/** Depósito en soles (Cross Payments, el más barato desde el Perú) y retiro en soles, en US$. */
export const DEPOSIT_FEE = 1.99;
export const WITHDRAWAL_FEE = 4.99;
/** EE. UU. retiene el 30 % de los dividendos a los no residentes: el Perú no tiene convenio con EE. UU. */
export const DIVIDEND_WITHHOLDING = 0.3;

const round = (x, dec = 6) => Math.round(x * 10 ** dec) / 10 ** dec;
const money = (x) => round(x, 2);
const centsUp = (x) => Math.ceil(x * 100 - 1e-7) / 100;

/** Costos de una orden de Hapi; los de la SEC y FINRA solo en las ventas, al centavo hacia arriba. */
export function orderFee(side, qty, price, date, plan) {
  const whole = Math.abs(qty - Math.round(qty)) < 1e-9;
  const clearing = (CLEARING[plan] ?? CLEARING.standard)[whole ? 'whole' : 'fraction'];
  let sec = 0;
  let taf = 0;
  if (side === 'sell') {
    sec = centsUp(qty * price * SEC_FEE_RATE);
    taf = date >= TAF_PAUSE.from && date <= TAF_PAUSE.to ? 0 : Math.min(TAF_MAX, centsUp(qty * TAF_PER_SHARE));
  }
  return { clearing, sec, taf, total: money(clearing + sec + taf) };
}

/**
 * @typedef {{ id: string, kind: string, date: string, symbol?: string, qty?: number, price?: number, amount?: number, pen?: number, fee: number, tax?: number, note?: string }} Op
 * @typedef {{ v: number, plan: string, ops: Op[], snapshot: { date: string, value: number, source?: string } | null }} Account
 */

/** @returns {Account} */
export const emptyAccount = () => ({ v: 1, plan: 'standard', ops: [], snapshot: null });

/** Orden cronológico; el mismo día, en el orden en que se anotaron. */
export function chrono(ops) {
  return ops
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.date < b.o.date ? -1 : a.o.date > b.o.date ? 1 : a.i - b.i))
    .map((x) => x.o);
}

function num(o, key, label, { required = false } = {}) {
  const raw = o[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new Error(`Falta ${label}.`);
    return undefined;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1e9 || (required && v === 0)) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} no es válido.`);
  return v;
}

function validDate(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Fecha no válida: usa AAAA-MM-DD.');
  if (date > today) throw new Error('La fecha no puede ser futura.');
  if (date < MIN_DATE) throw new Error('La fecha es demasiado antigua.');
}

/** Valida un movimiento y completa los costos de Hapi que falten. Devuelve el movimiento sin id. */
export function validateOp(input, plan, today) {
  const o = input ?? {};
  const kind = KINDS.find((k) => k === o.kind);
  if (!kind) throw new Error('El tipo debe ser compra, venta, dividendo, depósito o retiro.');
  const date = String(o.date ?? '');
  validDate(date, today);
  const fee = num(o, 'fee', 'el costo');
  const note = typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim().slice(0, 80) } : {};

  if (kind === 'buy' || kind === 'sell' || kind === 'dividend') {
    const symbol = String(o.symbol ?? '').trim().toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new Error('Escribe el símbolo de la acción o ETF, como SCCO o VOO.');
    if (kind === 'dividend') {
      const amount = money(num(o, 'amount', 'el monto del dividendo', { required: true }));
      const tax = num(o, 'tax', 'la retención') ?? money(amount * DIVIDEND_WITHHOLDING);
      if (tax > amount) throw new Error('La retención no puede ser mayor que el dividendo.');
      return { kind, date, symbol, amount, tax: money(tax), fee: 0, ...note };
    }
    const qty = round(num(o, 'qty', 'la cantidad', { required: true }));
    const price = round(num(o, 'price', 'el precio', { required: true }));
    if (qty <= 0 || price <= 0) throw new Error('La cantidad y el precio deben ser mayores que cero.');
    return { kind, date, symbol, qty, price, fee: money(fee ?? orderFee(kind, qty, price, date, plan).total), ...note };
  }

  const amount = money(num(o, 'amount', 'el monto en US$', { required: true }));
  if (amount <= 0) throw new Error('El monto debe ser mayor que cero.');
  const pen = num(o, 'pen', 'el monto en soles');
  return { kind, date, amount, ...(pen !== undefined ? { pen: money(pen) } : {}), fee: money(fee ?? (kind === 'deposit' ? DEPOSIT_FEE : WITHDRAWAL_FEE)), ...note };
}

/** Recorre la cuenta en orden. Falla si una venta supera lo que había ese día. */
export function accountLedger(ops) {
  const l = { positions: new Map(), cash: 0, deposits: 0, withdrawals: 0, pen: 0, transfers: 0, dividends: { gross: 0, tax: 0, net: 0 }, fees: { orders: 0, transfers: 0 } };
  for (const o of chrono(ops)) {
    if (o.kind === 'buy' || o.kind === 'sell') {
      const p = l.positions.get(o.symbol) ?? { qty: 0, cost: 0, realized: 0 };
      const gross = o.qty * o.price;
      l.fees.orders += o.fee;
      if (o.kind === 'buy') {
        p.qty += o.qty;
        p.cost += gross + o.fee;
        l.cash -= gross + o.fee;
      } else {
        if (o.qty > p.qty + EPS) throw new Error(`No se puede vender más de lo que había: el ${o.date} tenías ${round(p.qty)} ${o.symbol}.`);
        const avg = p.qty > 0 ? p.cost / p.qty : 0;
        p.realized += gross - o.fee - o.qty * avg;
        p.cost -= o.qty * avg;
        p.qty -= o.qty;
        if (p.qty < EPS) {
          p.qty = 0;
          p.cost = 0;
        }
        l.cash += gross - o.fee;
      }
      l.positions.set(o.symbol, p);
    } else if (o.kind === 'dividend') {
      const tax = o.tax ?? 0;
      l.dividends.gross += o.amount;
      l.dividends.tax += tax;
      l.dividends.net += o.amount - tax;
      l.cash += o.amount - tax;
    } else {
      // Depósito: llegó `amount` (el costo ya se descontó). Retiro: salió `amount` de la cuenta (con su costo).
      const sign = o.kind === 'deposit' ? 1 : -1;
      l.transfers += 1;
      l.fees.transfers += o.fee;
      if (sign > 0) l.deposits += o.amount;
      else l.withdrawals += o.amount;
      l.cash += sign * o.amount;
      l.pen = l.pen === null || o.pen === undefined ? null : l.pen + sign * o.pen;
    }
  }
  return l;
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 10);

/** Agrega movimientos ya validados o por validar; devuelve la cuenta nueva (o falla sin tocar la vieja). */
export function addOps(account, inputs, today) {
  if (account.ops.length + inputs.length > MAX_OPS) throw new Error(`Máximo ${MAX_OPS} movimientos.`);
  const added = inputs.map((x) => ({ id: newId(), ...validateOp(x, account.plan, today) }));
  const ops = [...account.ops, ...added];
  accountLedger(ops);
  return { ...account, ops };
}

export function deleteOp(account, id) {
  const ops = account.ops.filter((o) => o.id !== id);
  if (ops.length === account.ops.length) throw new Error('Ese movimiento ya no existe.');
  try {
    accountLedger(ops);
  } catch {
    throw new Error('Si borras esa compra, una venta posterior quedaría sin respaldo: borra primero la venta.');
  }
  return { ...account, ops };
}

export function setPlan(account, plan) {
  if (!PLANS.includes(plan)) throw new Error('El plan debe ser standard o prime.');
  return { ...account, plan };
}

/** El valor total que muestra Hapi (o el del estado de cuenta); null lo borra. */
export function setSnapshot(account, snapshot, today) {
  if (snapshot === null) return { ...account, snapshot: null };
  const date = String(snapshot?.date ?? '');
  validDate(date, today);
  const value = num(snapshot, 'value', 'el valor de la cuenta', { required: true });
  return { ...account, snapshot: { date, value: money(value), ...(snapshot.source ? { source: String(snapshot.source).slice(0, 40) } : {}) } };
}

/**
 * Lo que se muestra de la cuenta. `prices`: Map símbolo → precio (solo el dueño, con los precios del panel) o null.
 * `fx`: dólar del BCRP { rate, date } o null.
 */
/**
 * @param {Account} account
 * @param {{ prices?: Map<string, number> | null, fx?: { rate: number, date: string } | null }} [opts]
 */
export function accountView(account, { prices = null, fx = null } = {}) {
  const l = accountLedger(account.ops);
  const notes = [];
  const positions = [];
  let value = prices ? 0 : null;
  let cost = 0;
  let realized = 0;
  for (const [symbol, p] of l.positions) {
    realized += p.realized;
    if (p.qty <= 0) {
      if (Math.abs(p.realized) > EPS) positions.push({ symbol, qty: 0, avgCost: 0, cost: 0, price: null, value: null, gain: null, ret: null, realized: money(p.realized) });
      continue;
    }
    cost += p.cost;
    let price = null;
    if (prices) {
      price = prices.get(symbol) ?? null;
      if (price === null) notes.push(`Sin precio guardado de ${symbol}: agrégalo a tu lista diaria para valorizarlo.`);
    }
    const v = price === null ? null : p.qty * price;
    if (value !== null) value = v === null ? null : value + v;
    positions.push({
      symbol,
      qty: round(p.qty),
      avgCost: round(p.cost / p.qty, 4),
      cost: money(p.cost),
      price,
      value: v === null ? null : money(v),
      gain: v === null ? null : money(v - p.cost),
      ret: v === null || p.cost <= 0 ? null : v / p.cost - 1,
      realized: money(p.realized),
    });
  }
  positions.sort((x, y) => (y.value ?? y.cost) - (x.value ?? x.cost));
  const cash = l.transfers ? money(l.cash) : null;
  if (cash !== null && cash < -0.5) notes.push('El efectivo da negativo: falta anotar algún depósito.');
  return {
    plan: account.plan,
    ops: chrono(account.ops).reverse(),
    positions,
    totals: account.ops.length
      ? {
          deposits: money(l.deposits),
          withdrawals: money(l.withdrawals),
          netDeposits: money(l.deposits - l.withdrawals),
          netPen: l.transfers && l.pen !== null ? money(l.pen) : null,
          cash,
          cost: money(cost),
          value: value === null ? null : money(value),
          account: value === null || cash === null ? null : money(value + cash),
          realized: money(realized),
          unrealized: value === null ? null : money(value - cost),
          dividends: { gross: money(l.dividends.gross), tax: money(l.dividends.tax), net: money(l.dividends.net) },
          fees: { orders: money(l.fees.orders), transfers: money(l.fees.transfers), total: money(l.fees.orders + l.fees.transfers) },
        }
      : null,
    snapshot: account.snapshot,
    fx,
    priced: prices !== null,
    notes,
  };
}

/** Lo que se tiene de cada símbolo según los movimientos anotados (para comparar con un estado de cuenta). */
export function holdings(account) {
  const out = new Map();
  for (const [symbol, p] of accountLedger(account.ops).positions) if (p.qty > EPS) out.set(symbol, round(p.qty));
  return out;
}
