// Cartera simulada: compras y ventas guardadas en KV («portfolio») y valorizadas con los precios que el panel
// ya tiene guardados, así que no gasta créditos de Twelve Data (salvo el historial de un símbolo que no esté en
// caché). Solo para el dueño, porque usa precios de Twelve Data.
// Reglas elegidas: solo símbolos de la lista que cotizan en dólares, costo promedio, totales también en soles,
// sin dividendos ni comisiones. La comparación hace las mismas compras y ventas en el S&P 500 (SPY).

import { ApiError } from '../lib/http';
import { addDays, isoDate } from '../lib/num';
import { storedHistory, type Deps, type HistoryData, type PeruData, type QuotesData, type Stored } from './market';

export interface Trade {
  id: string;
  /** Día de la operación (YYYY-MM-DD). */
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Precio por unidad, en US$. */
  price: number;
}

export const MAX_TRADES = 300;
export const BENCHMARK = 'SPY';
const KEY = 'portfolio';
const EPS = 1e-9;

/** Acciones y ETF (sin «/») o pares que terminan en /USD (cripto). USD/PEN no: su precio está en soles. */
export const isUsdSymbol = (s: string) => !s.includes('/') || s.endsWith('/USD');

const round = (x: number, dec = 6) => Math.round(x * 10 ** dec) / 10 ** dec;

// ---------- de dónde salen los precios ----------

/** Precios para valorizar. La versión normal lee KV; en desarrollo local se usan datos de prueba. */
export interface PriceSource {
  /** Precios guardados de la lista (no gasta créditos). */
  quotes(): Promise<QuotesData | null>;
  /** Cierres diarios guardados (5 años). Con `fetch`, si no están se piden (1 crédito). */
  closes(symbol: string, fetch: boolean): Promise<[string, number][] | null>;
  /** Dólar en soles, para mostrar los totales también en soles. */
  usdPen(quotes: QuotesData | null): Promise<{ rate: number; source: string } | null>;
}

export function kvSource(d: Deps): PriceSource {
  return {
    quotes: async () => (await d.kv.get<Stored<QuotesData>>('quotes', 'json'))?.data ?? null,
    closes: async (symbol, fetch) => {
      if (!fetch) return (await d.kv.get<Stored<HistoryData>>(`hist5:${symbol}`, 'json'))?.data.points ?? null;
      try {
        return (await storedHistory(d, symbol)).data.points;
      } catch (e) {
        if (e instanceof ApiError) return null;
        throw e;
      }
    },
    usdPen: async (q) => {
      const live = q?.quotes.find((x) => x.symbol === 'USD/PEN')?.price;
      if (live) return { rate: live, source: 'USD/PEN de tu lista' };
      const fx = (await d.kv.get<Stored<PeruData>>('peru', 'json'))?.data.fx.at(-1);
      return fx ? { rate: fx.sell, source: `dólar interbancario del BCRP (venta, ${fx.date})` } : null;
    },
  };
}

// ---------- operaciones ----------

export async function readTrades(kv: KVNamespace): Promise<Trade[]> {
  const rec = await kv.get<{ trades?: Trade[] }>(KEY, 'json');
  return Array.isArray(rec?.trades) ? rec.trades : [];
}

async function saveTrades(kv: KVNamespace, trades: Trade[]): Promise<void> {
  await kv.put(KEY, JSON.stringify({ trades }));
}

/** Orden cronológico; el mismo día, en el orden en que se cargaron. */
export function chrono(trades: Trade[]): Trade[] {
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i))
    .map((x) => x.t);
}

export interface Holding {
  qty: number;
  /** Costo de lo que queda, a costo promedio. */
  cost: number;
  /** Ganancia de las ventas frente al costo promedio. */
  realized: number;
  /** Lo cobrado en ventas. */
  proceeds: number;
  /** Lo pagado en compras. */
  invested: number;
}

/** Recorre las operaciones en orden. Falla si alguna venta supera lo que había en ese momento. */
export function ledger(trades: Trade[]): Map<string, Holding> {
  const book = new Map<string, Holding>();
  for (const t of chrono(trades)) {
    const h = book.get(t.symbol) ?? { qty: 0, cost: 0, realized: 0, proceeds: 0, invested: 0 };
    if (t.side === 'buy') {
      h.qty += t.qty;
      h.cost += t.qty * t.price;
      h.invested += t.qty * t.price;
    } else {
      if (t.qty > h.qty + EPS) {
        throw new ApiError('bad_request', 400, `No se puede vender más de lo que había: el ${t.date} tenías ${round(h.qty, 6)} ${t.symbol}.`);
      }
      const avg = h.qty > 0 ? h.cost / h.qty : 0;
      h.realized += t.qty * (t.price - avg);
      h.proceeds += t.qty * t.price;
      h.cost -= t.qty * avg;
      h.qty -= t.qty;
      if (h.qty < EPS) {
        h.qty = 0;
        h.cost = 0;
      }
    }
    book.set(t.symbol, h);
  }
  return book;
}

/** Cierre del día o, si ese día no hubo, el último anterior. */
export function closeOn(points: [string, number][], date: string): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? points[found]![1] : null;
}

/**
 * Las mismas operaciones hechas en el SPY: cada compra pone esa misma plata en el SPY y cada venta saca la
 * parte proporcional de lo que se había puesto por ese símbolo. Devuelve cuánto valdría hoy (SPY + lo cobrado),
 * o null si alguna operación es anterior al historial del SPY.
 */
export function benchmarkTotal(trades: Trade[], spy: [string, number][], spyLast: number): number | null {
  const units = new Map<string, number>();
  const held = new Map<string, number>();
  let cash = 0;
  for (const t of chrono(trades)) {
    const p = closeOn(spy, t.date);
    if (p === null) return null;
    const q = held.get(t.symbol) ?? 0;
    const u = units.get(t.symbol) ?? 0;
    if (t.side === 'buy') {
      units.set(t.symbol, u + (t.qty * t.price) / p);
      held.set(t.symbol, q + t.qty);
    } else {
      const sold = q > 0 ? u * Math.min(1, t.qty / q) : 0;
      cash += sold * p;
      units.set(t.symbol, u - sold);
      held.set(t.symbol, q - t.qty);
    }
  }
  let total = cash;
  for (const u of units.values()) total += u * spyLast;
  return total;
}

// ---------- validar y guardar ----------

export interface TradeInput {
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number | null;
}

export function validateTrade(input: unknown, list: string[], today: string): TradeInput {
  const o = (input ?? {}) as Record<string, unknown>;
  const date = String(o.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ApiError('bad_request', 400, 'Fecha no válida: usa AAAA-MM-DD.');
  }
  if (date > today) throw new ApiError('bad_request', 400, 'La fecha no puede ser futura.');
  if (date < addDays(today, -5 * 365)) throw new ApiError('bad_request', 400, 'Solo hasta 5 años atrás (es el historial que guarda el panel).');
  const symbol = String(o.symbol ?? '').trim().toUpperCase();
  if (!list.includes(symbol)) throw new ApiError('bad_request', 400, `${symbol || 'Ese símbolo'} no está en tu lista de seguimiento.`);
  if (!isUsdSymbol(symbol)) throw new ApiError('bad_request', 400, `${symbol} no cotiza en dólares: la cartera es en US$.`);
  const side = o.side === 'buy' || o.side === 'sell' ? o.side : null;
  if (!side) throw new ApiError('bad_request', 400, 'La operación debe ser compra o venta.');
  const qty = Number(o.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw new ApiError('bad_request', 400, 'La cantidad debe ser un número mayor que cero.');
  let price: number | null = null;
  if (o.price !== undefined && o.price !== null && o.price !== '') {
    price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0 || price > 1e9) throw new ApiError('bad_request', 400, 'El precio debe ser un número mayor que cero.');
  }
  return { date, symbol, side, qty, price };
}

/**
 * Agrega una operación. Sin precio, usa el cierre de ese día (o el último anterior); si la fecha es hoy, el
 * precio guardado de la lista.
 */
export async function addTrade(d: Deps, src: PriceSource, input: unknown, list: string[]): Promise<Trade> {
  const today = isoDate(d.now);
  const t = validateTrade(input, list, today);
  let price = t.price;
  if (price === null && t.date >= today) {
    price = (await src.quotes())?.quotes.find((q) => q.symbol === t.symbol)?.price ?? null;
  }
  if (price === null) {
    const closes = await src.closes(t.symbol, true);
    price = closes ? closeOn(closes, t.date) : null;
  }
  if (price === null) throw new ApiError('bad_request', 400, `No hay precio guardado de ${t.symbol} para el ${t.date}: escríbelo a mano.`);
  const trades = await readTrades(d.kv);
  if (trades.length >= MAX_TRADES) throw new ApiError('bad_request', 400, `Máximo ${MAX_TRADES} operaciones.`);
  const trade: Trade = { id: crypto.randomUUID().slice(0, 8), date: t.date, symbol: t.symbol, side: t.side, qty: round(t.qty), price: round(price) };
  ledger([...trades, trade]);
  await saveTrades(d.kv, [...trades, trade]);
  return trade;
}

export async function deleteTrade(d: Deps, id: string): Promise<void> {
  const trades = await readTrades(d.kv);
  const rest = trades.filter((t) => t.id !== id);
  if (rest.length === trades.length) throw new ApiError('not_found', 404, 'Esa operación ya no existe.');
  try {
    ledger(rest);
  } catch {
    throw new ApiError('bad_request', 400, 'Si borras esa compra, una venta posterior quedaría sin respaldo: borra primero la venta.');
  }
  await saveTrades(d.kv, rest);
}

// ---------- valorizar ----------

export interface PositionView {
  symbol: string;
  qty: number;
  avgCost: number;
  cost: number;
  price: number | null;
  value: number | null;
  /** Ganancia no realizada (valor − costo). */
  gain: number | null;
  ret: number | null;
  realized: number;
}

export interface PortfolioView {
  trades: Trade[];
  positions: PositionView[];
  totals: {
    invested: number;
    /** Valor de lo que queda, con los últimos precios. */
    value: number;
    /** Lo cobrado en ventas. */
    proceeds: number;
    /** Valor + lo cobrado. */
    total: number;
    gain: number;
    ret: number;
    realized: number;
    unrealized: number;
  } | null;
  /** Las mismas operaciones en el SPY. */
  benchmark: { symbol: string; total: number; ret: number } | null;
  fx: { rate: number; source: string } | null;
  /** Hora de los precios usados (la más reciente). */
  pricesAt: string | null;
  notes: string[];
}

export async function valuePortfolio(trades: Trade[], src: PriceSource): Promise<PortfolioView> {
  const ordered = chrono(trades);
  const book = ledger(ordered);
  const quotes = await src.quotes();
  const notes: string[] = [];
  const priceOf = async (symbol: string): Promise<number | null> => {
    const q = quotes?.quotes.find((x) => x.symbol === symbol)?.price;
    if (q) return q;
    const closes = await src.closes(symbol, false);
    return closes?.at(-1)?.[1] ?? null;
  };

  const positions: PositionView[] = [];
  let value = 0;
  let invested = 0;
  let proceeds = 0;
  let realized = 0;
  let openCost = 0;
  for (const [symbol, h] of book) {
    invested += h.invested;
    proceeds += h.proceeds;
    realized += h.realized;
    if (h.qty <= 0) continue;
    const price = await priceOf(symbol);
    if (price === null) notes.push(`Sin precio guardado de ${symbol}: no entra en el valor.`);
    const v = price === null ? null : h.qty * price;
    if (v !== null) {
      value += v;
      openCost += h.cost;
    }
    positions.push({
      symbol,
      qty: round(h.qty),
      avgCost: round(h.cost / h.qty),
      cost: round(h.cost, 2),
      price,
      value: v === null ? null : round(v, 2),
      gain: v === null ? null : round(v - h.cost, 2),
      ret: v === null || h.cost <= 0 ? null : v / h.cost - 1,
      realized: round(h.realized, 2),
    });
  }
  positions.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const total = value + proceeds;
  const totals = ordered.length
    ? {
        invested: round(invested, 2),
        value: round(value, 2),
        proceeds: round(proceeds, 2),
        total: round(total, 2),
        gain: round(total - invested, 2),
        ret: invested > 0 ? total / invested - 1 : 0,
        realized: round(realized, 2),
        unrealized: round(value - openCost, 2),
      }
    : null;

  let benchmark: PortfolioView['benchmark'] = null;
  if (ordered.length && invested > 0) {
    const spy = await src.closes(BENCHMARK, true);
    const spyLast = (await priceOf(BENCHMARK)) ?? spy?.at(-1)?.[1] ?? null;
    const b = spy && spyLast ? benchmarkTotal(ordered, spy, spyLast) : null;
    if (b === null) notes.push('No se pudo calcular la comparación con el S&P 500 (falta el historial del SPY).');
    else benchmark = { symbol: BENCHMARK, total: round(b, 2), ret: b / invested - 1 };
  }

  const times = Object.values(quotes?.fetched ?? {});
  return {
    trades: ordered,
    positions,
    totals,
    benchmark,
    fx: ordered.length ? await src.usdPen(quotes) : null,
    pricesAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
    notes,
  };
}
