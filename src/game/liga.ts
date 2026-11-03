// «Liga de carteras»: cada uno recibe S/ 10 000 de mentira y compra o vende dólares, oro, cobre y la Bolsa de Lima;
// lo que no invierte queda en soles y rinde la tasa del BCRP. Todo se valoriza en soles con datos del BCRP, que
// también ven los amigos (las acciones no pueden entrar así: la licencia gratis de Twelve Data no permite mostrarles
// sus precios). Gana el mes quien más rinda.
//
// Los datos del BCRP llegan con un día de atraso: si una compra usara el último precio publicado, se podría comprar
// oro a precio de ayer sabiendo que hoy subió. Por eso cada orden se cumple con el cierre del primer día hábil
// después del día en que la diste.

import { ApiError } from '../lib/http';
import { addDays, isoDate } from '../lib/num';
import type { GameStorage } from './juego';
import type { LeaguePrices, SeriesPoint } from './series';

export const ASSETS = ['dolar', 'oro', 'cobre', 'bvl'] as const;
export type Asset = (typeof ASSETS)[number];
export const ASSET_NAMES: Record<Asset, string> = { dolar: 'Dólar', oro: 'Oro', cobre: 'Cobre', bvl: 'Bolsa de Lima' };
/** Con lo que entra cada uno, en soles de mentira. */
export const START_SOLES = 10_000;
/** Órdenes esperando el cierre, por persona. */
const MAX_ORDERS = 10;

const MEMBER = 'lm:';
const RESULT = 'lr:';
const LIMA = 'America/Lima';

export interface Order {
  id: number;
  kind: 'comprar' | 'vender';
  asset: Asset;
  /** Compra: cuántos soles. Venta: cuántos soles de esa posición (null = toda). */
  soles: number | null;
  /** Día (de Lima) en que se dio: se cumple con el primer cierre después. */
  on: string;
}

interface Member {
  pid: string;
  /** Soles sin invertir y desde cuándo rinden. */
  cash: number;
  cashSince: string;
  units: Record<Asset, number>;
  /** Soles puestos en cada posición (para mostrar cuánto gana o pierde). */
  cost: Record<Asset, number>;
  orders: Order[];
  nextOrder: number;
  /** Valor al empezar cada mes (o al entrar, si entró a mitad de mes). */
  monthStart: Record<string, number>;
  joinedAt: string;
}

interface MonthResult {
  month: string;
  rows: { pid: string; ret: number }[];
}

export interface LeagueView {
  month: string;
  /** Último día con todos los precios. */
  asOf: string | null;
  tasa: number | null;
  /** Lo que rindió cada activo en el mes, en soles (y los soles sin invertir, a la tasa del BCRP). */
  assets: { id: Asset | 'soles'; name: string; ret: number | null }[];
  me: {
    value: number | null;
    ret: number | null;
    cash: number;
    positions: { asset: Asset; name: string; value: number; ret: number | null }[];
    orders: Order[];
  } | null;
  standings: { alias: string; ret: number; mine: boolean }[];
  last: { month: string; champion: string; ret: number } | null;
  titles: { alias: string; titles: number; mine: boolean }[];
}

/** Último valor en esa fecha o antes. */
function at(series: SeriesPoint[], date: string): number | null {
  let v: number | null = null;
  for (const p of series) {
    if (p.d > date) break;
    v = p.v;
  }
  return v;
}

/** Precio en soles de una unidad de cada activo en esa fecha (null si falta alguno). */
function pricesOn(px: LeaguePrices, date: string): Record<Asset, number> | null {
  const fx = at(px.dolar, date);
  const oro = at(px.oro, date);
  const cobre = at(px.cobre, date);
  const bvl = at(px.bvl, date);
  if (fx == null || oro == null || cobre == null || bvl == null) return null;
  return { dolar: fx, oro: oro * fx, cobre: cobre * fx, bvl };
}

/** El último día en que hay todos los precios. */
export function latestCommon(px: LeaguePrices): string | null {
  const lasts = [px.dolar, px.oro, px.cobre, px.bvl].map((s) => s.at(-1)?.d);
  if (lasts.some((d) => !d)) return null;
  return (lasts as string[]).reduce((a, b) => (a < b ? a : b));
}

const days = (from: string, to: string) => Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Soles sin invertir: interés simple a la tasa del BCRP. */
function grow(amount: number, from: string, to: string, tasa: number | null): number {
  return amount * (1 + ((tasa ?? 0) / 100) * (days(from, to) / 365));
}

export function valueOn(m: Member, px: LeaguePrices, date: string): number | null {
  const p = pricesOn(px, date);
  if (!p) return null;
  return grow(m.cash, m.cashSince, date, px.tasa) + ASSETS.reduce((sum, a) => sum + m.units[a] * p[a], 0);
}

/** Primer día con todos los precios después de `on`: ahí se cumple una orden dada ese día. */
function executionDate(px: LeaguePrices, on: string): string | null {
  for (const p of px.dolar) if (p.d > on && pricesOn(px, p.d)) return p.d;
  return null;
}

/** Cumple una orden a los precios de esa fecha. Si ya no alcanza (o no queda qué vender), se cumple lo que se pueda. */
function execute(m: Member, o: Order, px: LeaguePrices, date: string): void {
  const p = pricesOn(px, date)!;
  m.cash = grow(m.cash, m.cashSince, date, px.tasa);
  m.cashSince = date;
  if (o.kind === 'comprar') {
    const soles = Math.min(o.soles ?? 0, m.cash);
    m.units[o.asset] += soles / p[o.asset];
    m.cost[o.asset] += soles;
    m.cash -= soles;
  } else {
    const held = m.units[o.asset] * p[o.asset];
    const soles = o.soles == null ? held : Math.min(o.soles, held);
    const share = held > 0 ? soles / held : 0;
    m.units[o.asset] -= m.units[o.asset] * share;
    m.cost[o.asset] -= m.cost[o.asset] * share;
    m.cash += soles;
  }
}

/** Último día del mes anterior a `month` (YYYY-MM): los precios de ahí son los del arranque del mes. */
const monthStartDate = (month: string) => addDays(`${month}-01`, -1);
const prevMonth = (month: string) => monthStartDate(month).slice(0, 7);
const round2 = (v: number) => Math.round(v * 100) / 100;

export class Liga {
  constructor(private readonly store: GameStorage) {}

  private async members(): Promise<Member[]> {
    return [...(await this.store.list<Member>({ prefix: MEMBER })).values()];
  }

  private save(m: Member) {
    return this.store.put(`${MEMBER}${m.pid}`, m);
  }

  /**
   * Pone al día a todos, en orden: las órdenes que se cumplen hasta fin del mes pasado, el cierre de ese mes (su
   * campeón), el valor de arranque de este mes y las órdenes que se cumplen después. Corre en cada pedido.
   */
  async settle(now: Date, px: LeaguePrices): Promise<void> {
    const asOf = latestCommon(px);
    if (!asOf) return;
    const month = isoDate(now, LIMA).slice(0, 7);
    const start = monthStartDate(month);
    const prev = prevMonth(month);
    const members = await this.members();
    const fill = (m: Member, until: string) => {
      const left: Order[] = [];
      for (const o of m.orders) {
        const day = executionDate(px, o.on);
        if (day && day <= until) execute(m, o, px, day);
        else left.push(o);
      }
      m.orders = left;
    };
    for (const m of members) fill(m, asOf < start ? asOf : start);
    if (asOf >= start) {
      if (!(await this.store.get(`${RESULT}${prev}`))) {
        const rows = members
          .filter((m) => m.monthStart[prev])
          .map((m) => ({ pid: m.pid, ret: (valueOn(m, px, start) ?? m.monthStart[prev]!) / m.monthStart[prev]! - 1 }))
          .sort((a, b) => b.ret - a.ret);
        if (rows.length) await this.store.put(`${RESULT}${prev}`, { month: prev, rows } satisfies MonthResult);
      }
      for (const m of members) m.monthStart[month] ??= valueOn(m, px, start) ?? START_SOLES;
    }
    for (const m of members) {
      fill(m, asOf);
      await this.save(m);
    }
  }

  /** Da una orden de compra o venta (la primera vez, entras con S/ 10 000). Se cumple con el próximo cierre. */
  async order(pid: string, body: unknown, now: Date): Promise<void> {
    const b = (body ?? {}) as { action?: unknown; asset?: unknown; soles?: unknown; cancel?: unknown };
    const today = isoDate(now, LIMA);
    const m: Member = (await this.store.get<Member>(`${MEMBER}${pid}`)) ?? {
      pid,
      cash: START_SOLES,
      cashSince: today,
      units: { dolar: 0, oro: 0, cobre: 0, bvl: 0 },
      cost: { dolar: 0, oro: 0, cobre: 0, bvl: 0 },
      orders: [],
      nextOrder: 1,
      monthStart: { [today.slice(0, 7)]: START_SOLES },
      joinedAt: now.toISOString(),
    };
    if (b.action === 'cancelar') {
      const before = m.orders.length;
      m.orders = m.orders.filter((o) => o.id !== b.cancel);
      if (m.orders.length === before) throw new ApiError('bad_request', 400, 'Esa orden ya se cumplió o no existe.');
      return this.save(m);
    }
    const asset = typeof b.asset === 'string' && (ASSETS as readonly string[]).includes(b.asset) ? (b.asset as Asset) : null;
    if (!asset) throw new ApiError('bad_request', 400, 'Elige qué comprar o vender.');
    if (m.orders.length >= MAX_ORDERS) throw new ApiError('bad_request', 400, `Ya tienes ${MAX_ORDERS} órdenes esperando el cierre.`);
    const soles = b.soles == null || b.soles === '' ? null : Math.floor(Number(b.soles));
    const kind = b.action;
    if (kind === 'comprar') {
      if (soles == null || !Number.isFinite(soles) || soles < 1) throw new ApiError('bad_request', 400, 'Escribe cuántos soles quieres poner.');
      const committed = m.orders.filter((o) => o.kind === 'comprar').reduce((s, o) => s + (o.soles ?? 0), 0);
      if (soles > m.cash - committed) throw new ApiError('bad_request', 400, `Te quedan S/ ${Math.floor(Math.max(0, m.cash - committed))} sin invertir.`);
    } else if (kind === 'vender') {
      if (soles != null && (!Number.isFinite(soles) || soles < 1)) throw new ApiError('bad_request', 400, 'Escribe cuántos soles quieres vender, o vende todo.');
      const buying = m.orders.some((o) => o.kind === 'comprar' && o.asset === asset);
      if (m.units[asset] <= 1e-12 && !buying) throw new ApiError('bad_request', 400, `No tienes ${ASSET_NAMES[asset].toLowerCase()} para vender.`);
    } else throw new ApiError('bad_request', 400, '¿Comprar o vender?');
    m.orders.push({ id: m.nextOrder++, kind, asset, soles, on: today });
    await this.save(m);
  }

  async view(pid: string, now: Date, px: LeaguePrices, aliases: Map<string, string>): Promise<LeagueView> {
    const month = isoDate(now, LIMA).slice(0, 7);
    const start = monthStartDate(month);
    const asOf = latestCommon(px);
    const name = (id: string) => aliases.get(id) ?? 'Sin nombre';
    const p0 = pricesOn(px, start);
    const p1 = asOf ? pricesOn(px, asOf) : null;
    const assets: LeagueView['assets'] = [
      { id: 'soles', name: 'Soles (tasa del BCRP)', ret: asOf && asOf > start ? grow(1, start, asOf, px.tasa) - 1 : 0 },
      ...ASSETS.map((id) => ({ id, name: ASSET_NAMES[id], ret: p0 && p1 ? p1[id] / p0[id] - 1 : null })),
    ];

    const members = await this.members();
    const retOf = (m: Member) => {
      const v = asOf ? valueOn(m, px, asOf) : null;
      const s = m.monthStart[month];
      return v != null && s ? v / s - 1 : null;
    };
    const mine = members.find((m) => m.pid === pid);
    let me: LeagueView['me'] = null;
    if (mine) {
      const positions = p1
        ? ASSETS.filter((a) => mine.units[a] > 1e-12).map((a) => {
            const value = mine.units[a] * p1[a];
            return { asset: a, name: ASSET_NAMES[a], value: round2(value), ret: mine.cost[a] > 0 ? value / mine.cost[a] - 1 : null };
          })
        : [];
      me = {
        value: asOf ? valueOn(mine, px, asOf) : null,
        ret: retOf(mine),
        cash: round2(asOf ? grow(mine.cash, mine.cashSince, asOf, px.tasa) : mine.cash),
        positions,
        orders: mine.orders,
      };
    }
    const results = [...(await this.store.list<MonthResult>({ prefix: RESULT })).values()];
    const lastResult = results.at(-1);
    const titles = new Map<string, number>();
    for (const r of results) if (r.rows[0]) titles.set(r.rows[0].pid, (titles.get(r.rows[0].pid) ?? 0) + 1);
    return {
      month,
      asOf,
      tasa: px.tasa,
      assets,
      me,
      standings: members
        .map((m) => ({ alias: name(m.pid), ret: retOf(m), mine: m.pid === pid }))
        .filter((r): r is { alias: string; ret: number; mine: boolean } => r.ret != null)
        .sort((a, b) => b.ret - a.ret || a.alias.localeCompare(b.alias)),
      last: lastResult?.rows[0] ? { month: lastResult.month, champion: name(lastResult.rows[0].pid), ret: lastResult.rows[0].ret } : null,
      titles: [...titles.entries()].map(([id, n]) => ({ alias: name(id), titles: n, mine: id === pid })).sort((a, b) => b.titles - a.titles),
    };
  }
}
