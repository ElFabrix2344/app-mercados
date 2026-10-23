// Cuenta de Hapi de cada persona (dueño y amigos), privada: solo la ve quien la anota, nadie más en la app.
// Compras, ventas, dividendos, depósitos y retiros, con los costos de Hapi calculados si no se escriben. Un registro
// por persona en KV (`hapi:<jugador>`, el mismo id del juego de pronósticos): cada cambio es una escritura.
// Valor de mercado solo para el dueño, con los precios que el panel ya guardó (Twelve Data no permite mostrarlos a
// otras personas). Cualquiera puede anotar, además, el valor total que le muestra Hapi.

import { DEPOSIT_FEE, DIVIDEND_WITHHOLDING, HAPI_PLANS, orderFee, WITHDRAWAL_FEE, type HapiPlan } from '../lib/hapi';
import { ApiError } from '../lib/http';
import { isoDate } from '../lib/num';
import { playerId } from './forecasts';
import { SYMBOL_RE } from './market';
import type { PriceSource } from './portfolio';

export const MAX_OPS = 1000;
/** Las operaciones más viejas que se aceptan (Hapi abrió en 2021). */
const MIN_DATE = '2015-01-01';
const EPS = 1e-9;

export type OpKind = 'buy' | 'sell' | 'dividend' | 'deposit' | 'withdrawal';
const KINDS: readonly OpKind[] = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'];

export interface HapiOp {
  id: string;
  kind: OpKind;
  /** Día de la operación (YYYY-MM-DD). */
  date: string;
  /** Compras, ventas y dividendos. */
  symbol?: string;
  qty?: number;
  /** Precio por acción, en US$. */
  price?: number;
  /** En US$: el dividendo bruto, lo que llegó a Hapi en un depósito o lo que salió de Hapi en un retiro. */
  amount?: number;
  /** Soles pagados por el depósito o recibidos por el retiro (opcional: sirve para el rendimiento en soles). */
  pen?: number;
  /** Costos de Hapi en US$: compensación, SEC y FINRA en las órdenes; el del método en depósitos y retiros. */
  fee: number;
  /** Retención de impuestos de EE. UU. sobre el dividendo, en US$. */
  tax?: number;
}

export interface HapiAccount {
  plan: HapiPlan;
  ops: HapiOp[];
  /** El valor total de la cuenta que muestra Hapi, anotado a mano. */
  snapshot: { date: string; value: number } | null;
}

const EMPTY: HapiAccount = { plan: 'standard', ops: [], snapshot: null };
const keyOf = async (email: string) => `hapi:${await playerId(email)}`;
const round = (x: number, dec = 6) => Math.round(x * 10 ** dec) / 10 ** dec;
const money = (x: number) => round(x, 2);

export async function readAccount(kv: KVNamespace, email: string): Promise<HapiAccount> {
  const rec = await kv.get<HapiAccount>(await keyOf(email), 'json');
  return rec ? { ...EMPTY, ...rec, ops: Array.isArray(rec.ops) ? rec.ops : [] } : { ...EMPTY };
}

async function saveAccount(kv: KVNamespace, email: string, a: HapiAccount): Promise<void> {
  await kv.put(await keyOf(email), JSON.stringify(a));
}

/** Orden cronológico; el mismo día, en el orden en que se anotaron. */
function chrono(ops: HapiOp[]): HapiOp[] {
  return ops
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.date < b.o.date ? -1 : a.o.date > b.o.date ? 1 : a.i - b.i))
    .map((x) => x.o);
}

export interface Position {
  qty: number;
  /** Costo de lo que queda, a costo promedio y con los costos de compra. */
  cost: number;
  /** Ganancia de las ventas, neta de costos, frente al costo promedio. */
  realized: number;
}

export interface Ledger {
  positions: Map<string, Position>;
  /** Efectivo en la cuenta según lo anotado (depósitos − retiros − compras + ventas + dividendos netos). */
  cash: number;
  deposits: number;
  withdrawals: number;
  /** Soles netos puestos (depósitos − retiros); null si a algún movimiento le faltan los soles. */
  pen: number | null;
  transfers: number;
  dividends: { gross: number; tax: number; net: number };
  fees: { orders: number; transfers: number };
}

/** Recorre la cuenta en orden. Falla si una venta supera lo que había ese día. */
export function accountLedger(ops: HapiOp[]): Ledger {
  const l: Ledger = { positions: new Map(), cash: 0, deposits: 0, withdrawals: 0, pen: 0, transfers: 0, dividends: { gross: 0, tax: 0, net: 0 }, fees: { orders: 0, transfers: 0 } };
  for (const o of chrono(ops)) {
    if (o.kind === 'buy' || o.kind === 'sell') {
      const p = l.positions.get(o.symbol!) ?? { qty: 0, cost: 0, realized: 0 };
      const gross = o.qty! * o.price!;
      l.fees.orders += o.fee;
      if (o.kind === 'buy') {
        p.qty += o.qty!;
        p.cost += gross + o.fee;
        l.cash -= gross + o.fee;
      } else {
        if (o.qty! > p.qty + EPS) {
          throw new ApiError('bad_request', 400, `No se puede vender más de lo que había: el ${o.date} tenías ${round(p.qty)} ${o.symbol}.`);
        }
        const avg = p.qty > 0 ? p.cost / p.qty : 0;
        p.realized += gross - o.fee - o.qty! * avg;
        p.cost -= o.qty! * avg;
        p.qty -= o.qty!;
        if (p.qty < EPS) {
          p.qty = 0;
          p.cost = 0;
        }
        l.cash += gross - o.fee;
      }
      l.positions.set(o.symbol!, p);
    } else if (o.kind === 'dividend') {
      const tax = o.tax ?? 0;
      l.dividends.gross += o.amount!;
      l.dividends.tax += tax;
      l.dividends.net += o.amount! - tax;
      l.cash += o.amount! - tax;
    } else {
      // Depósito: llegó `amount` (el costo ya se descontó). Retiro: salió `amount` de la cuenta (con su costo).
      const sign = o.kind === 'deposit' ? 1 : -1;
      l.transfers += 1;
      l.fees.transfers += o.fee;
      if (sign > 0) l.deposits += o.amount!;
      else l.withdrawals += o.amount!;
      l.cash += sign * o.amount!;
      l.pen = l.pen === null || o.pen === undefined ? null : l.pen + sign * o.pen;
    }
  }
  return l;
}

// ---------- validar y guardar ----------

function num(o: Record<string, unknown>, key: string, label: string, opts: { required?: boolean; min?: number } = {}): number | undefined {
  const raw = o[key];
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new ApiError('bad_request', 400, `Falta ${label}.`);
    return undefined;
  }
  const v = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isFinite(v) || v < min || v > 1e9 || (min === 0 && opts.required && v === 0)) {
    throw new ApiError('bad_request', 400, `${label[0]!.toUpperCase()}${label.slice(1)} no es válido.`);
  }
  return v;
}

/** Valida una operación y completa los costos de Hapi que falten. */
export function validateOp(input: unknown, plan: HapiPlan, today: string): Omit<HapiOp, 'id'> {
  const o = (input ?? {}) as Record<string, unknown>;
  const kind = KINDS.find((k) => k === o.kind);
  if (!kind) throw new ApiError('bad_request', 400, 'El tipo debe ser compra, venta, dividendo, depósito o retiro.');
  const date = String(o.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ApiError('bad_request', 400, 'Fecha no válida: usa AAAA-MM-DD.');
  }
  if (date > today) throw new ApiError('bad_request', 400, 'La fecha no puede ser futura.');
  if (date < MIN_DATE) throw new ApiError('bad_request', 400, 'La fecha es demasiado antigua.');
  const fee = num(o, 'fee', 'el costo');

  if (kind === 'buy' || kind === 'sell' || kind === 'dividend') {
    const symbol = String(o.symbol ?? '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol) || symbol.includes('/')) throw new ApiError('bad_request', 400, 'Escribe el símbolo de la acción o ETF, como SCCO o VOO.');
    if (kind === 'dividend') {
      const amount = round(num(o, 'amount', 'el monto del dividendo', { required: true })!, 2);
      const tax = num(o, 'tax', 'la retención') ?? money(amount * DIVIDEND_WITHHOLDING);
      if (tax > amount) throw new ApiError('bad_request', 400, 'La retención no puede ser mayor que el dividendo.');
      return { kind, date, symbol, amount, tax: money(tax), fee: 0 };
    }
    const qty = round(num(o, 'qty', 'la cantidad', { required: true })!);
    const price = round(num(o, 'price', 'el precio', { required: true })!);
    if (qty <= 0 || price <= 0) throw new ApiError('bad_request', 400, 'La cantidad y el precio deben ser mayores que cero.');
    return { kind, date, symbol, qty, price, fee: money(fee ?? orderFee(kind, qty, price, date, plan).total) };
  }

  const amount = money(num(o, 'amount', 'el monto en US$', { required: true })!);
  if (amount <= 0) throw new ApiError('bad_request', 400, 'El monto debe ser mayor que cero.');
  const pen = num(o, 'pen', 'el monto en soles');
  return {
    kind,
    date,
    amount,
    ...(pen !== undefined ? { pen: money(pen) } : {}),
    fee: money(fee ?? (kind === 'deposit' ? DEPOSIT_FEE : WITHDRAWAL_FEE)),
  };
}

export async function addOp(kv: KVNamespace, email: string, now: Date, input: unknown): Promise<HapiOp> {
  const a = await readAccount(kv, email);
  if (a.ops.length >= MAX_OPS) throw new ApiError('bad_request', 400, `Máximo ${MAX_OPS} movimientos.`);
  const op: HapiOp = { id: crypto.randomUUID().slice(0, 8), ...validateOp(input, a.plan, isoDate(now)) };
  accountLedger([...a.ops, op]);
  await saveAccount(kv, email, { ...a, ops: [...a.ops, op] });
  return op;
}

export async function deleteOp(kv: KVNamespace, email: string, id: string): Promise<void> {
  const a = await readAccount(kv, email);
  const rest = a.ops.filter((o) => o.id !== id);
  if (rest.length === a.ops.length) throw new ApiError('not_found', 404, 'Ese movimiento ya no existe.');
  try {
    accountLedger(rest);
  } catch {
    throw new ApiError('bad_request', 400, 'Si borras esa compra, una venta posterior quedaría sin respaldo: borra primero la venta.');
  }
  await saveAccount(kv, email, { ...a, ops: rest });
}

/** Cambia el plan (Standard o Prime) o el valor total que muestra Hapi (`snapshot: null` lo borra). */
export async function updateSettings(kv: KVNamespace, email: string, now: Date, input: unknown): Promise<void> {
  const o = (input ?? {}) as Record<string, unknown>;
  const a = await readAccount(kv, email);
  if (o.plan !== undefined) {
    const plan = HAPI_PLANS.find((p) => p === o.plan);
    if (!plan) throw new ApiError('bad_request', 400, 'El plan debe ser standard o prime.');
    a.plan = plan;
  }
  if (o.snapshot === null) a.snapshot = null;
  else if (o.snapshot !== undefined) {
    const s = (o.snapshot ?? {}) as Record<string, unknown>;
    const date = String(s.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > isoDate(now) || date < MIN_DATE) throw new ApiError('bad_request', 400, 'Fecha no válida: usa AAAA-MM-DD.');
    const value = num(s, 'value', 'el valor de la cuenta', { required: true })!;
    a.snapshot = { date, value: money(value) };
  }
  await saveAccount(kv, email, a);
}

// ---------- lo que ve cada uno ----------

export interface HapiPositionView {
  symbol: string;
  qty: number;
  avgCost: number;
  cost: number;
  /** Solo el dueño: precio guardado del panel. */
  price: number | null;
  value: number | null;
  gain: number | null;
  ret: number | null;
  realized: number;
}

export interface HapiView {
  plan: HapiPlan;
  /** Del más nuevo al más viejo. */
  ops: HapiOp[];
  positions: HapiPositionView[];
  totals: {
    deposits: number;
    withdrawals: number;
    netDeposits: number;
    netPen: number | null;
    /** null si no se anotó ningún depósito (sin ellos el efectivo no dice nada). */
    cash: number | null;
    cost: number;
    /** Lo que queda a precios de mercado: solo el dueño y solo si todas las posiciones tienen precio. */
    value: number | null;
    /** value + efectivo. */
    account: number | null;
    realized: number;
    unrealized: number | null;
    dividends: { gross: number; tax: number; net: number };
    fees: { orders: number; transfers: number; total: number };
  } | null;
  snapshot: HapiAccount['snapshot'];
  /** Dólar interbancario del BCRP (venta), para pasar a soles. */
  fx: { rate: number; date: string } | null;
  /** Si quien mira recibe precios de mercado (solo el dueño). */
  priced: boolean;
  notes: string[];
}

export interface HapiViewDeps {
  /** Precios del panel (solo el dueño); null para los amigos. */
  prices: ((symbols: string[]) => PriceSource) | null;
  usdPen: () => Promise<{ rate: number; date: string } | null>;
}

export async function hapiView(kv: KVNamespace, email: string, deps: HapiViewDeps): Promise<HapiView> {
  const a = await readAccount(kv, email);
  const l = accountLedger(a.ops);
  const open = [...l.positions].filter(([, p]) => p.qty > 0);
  const src = deps.prices && open.length ? deps.prices(open.map(([s]) => s)) : null;
  const quotes = src ? await src.quotes() : null;
  const notes: string[] = [];
  const positions: HapiPositionView[] = [];
  let value: number | null = src ? 0 : null;
  for (const [symbol, p] of l.positions) {
    if (p.qty <= 0) {
      if (Math.abs(p.realized) > EPS) positions.push({ symbol, qty: 0, avgCost: 0, cost: 0, price: null, value: null, gain: null, ret: null, realized: money(p.realized) });
      continue;
    }
    let price: number | null = null;
    if (src) {
      price = quotes?.quotes.find((q) => q.symbol === symbol)?.price ?? (await src.closes(symbol, false))?.at(-1)?.[1] ?? null;
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
  const cost = open.reduce((s, [, p]) => s + p.cost, 0);
  const realized = [...l.positions.values()].reduce((s, p) => s + p.realized, 0);
  const cash = l.transfers ? money(l.cash) : null;
  if (cash !== null && cash < -0.5) notes.push('El efectivo da negativo: falta anotar algún depósito.');
  return {
    plan: a.plan,
    ops: chrono(a.ops).reverse(),
    positions,
    totals: a.ops.length
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
    snapshot: a.snapshot,
    fx: await deps.usdPen(),
    priced: deps.prices !== null,
    notes,
  };
}
