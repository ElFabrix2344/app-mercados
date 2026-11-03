// Mercado de predicciones del grupo (hoja «Juego»): preguntas de Sí o No que se juegan con fichas, sin plata real.
// El precio lo pone un creador de mercado automático (lib/lmsr.ts) y se lee como la probabilidad que le da el grupo.
// Cualquiera propone preguntas y el dueño las aprueba. Las ligadas a un dato del juego de pronósticos se resuelven
// solas; el resto las resuelve el dueño, con el enlace a la fuente. Todo vive en un Durable Object (game/juego-do.ts),
// que atiende los pedidos de a uno: dos compras al mismo tiempo no se pisan. Aquí está la lógica, sobre un
// almacenamiento clave-valor (el del Durable Object, o uno en memoria en las pruebas).

import { zonedToUtc } from '../lib/calendar';
import { parseForecast, questionById, type Choice, type ForecastValue } from '../lib/forecasts';
import { ApiError } from '../lib/http';
import { priceYes, saleValue, sharesFor, type Side } from '../lib/lmsr';
import { addDays, isoDate } from '../lib/num';
import type { Results } from '../services/forecasts';

export type { Side };

/** Fichas al entrar y cada lunes. No son plata ni se cambian por nada. */
export const START_CHIPS = 1000;
export const WEEKLY_CHIPS = 100;
/** Fichas que paga cada acción ganadora: el precio va de 1 a 99. */
export const PAYOUT = 100;
/** Liquidez del creador de mercado, en acciones: unas 280 fichas llevan el precio de 50 a 75. */
export const LIQUIDITY = 4;
/** Propuestas de una misma persona esperando aprobación. */
export const MAX_PENDING = 3;
/** Días que se siguen viendo las preguntas resueltas, anuladas o rechazadas. */
const SHOW_DAYS = 60;
/** Puntos del gráfico de precio que se guardan por pregunta. */
const MAX_HISTORY = 200;
const LIMA = 'America/Lima';

export const CATEGORIES = { universidad: 'Universidad', peru: 'Perú', mundo: 'Mundo', economia: 'Economía' } as const;
export type Category = keyof typeof CATEGORIES;
export type Status = 'propuesta' | 'abierta' | 'rechazada' | 'resuelta' | 'anulada';

/** Resolución automática con el dato de una pregunta del juego de pronósticos. */
export interface AutoRule {
  qid: string;
  /** «es»: el resultado es ese (sube, mantiene o baja); «min» y «max»: el número es al menos o a lo más ese. */
  op: 'es' | 'min' | 'max';
  value: ForecastValue;
}

/** Un punto del gráfico de precio (objeto y no tupla: así viaja tal cual por RPC). */
export interface PricePoint {
  at: string;
  p: number;
}

export interface Position {
  yes: number;
  no: number;
  /** Fichas netas puestas: compras menos ventas (si se anula la pregunta, es lo que se devuelve). */
  spent: number;
}

export interface Market {
  id: number;
  question: string;
  /** Cómo se resuelve: criterio y fuente. */
  details: string;
  category: Category;
  status: Status;
  createdBy: string;
  createdAt: string;
  closesAt: string;
  b: number;
  qYes: number;
  qNo: number;
  /** Fichas movidas, en compras y ventas. */
  volume: number;
  positions: Record<string, Position>;
  /** Precio en el tiempo: hora ISO y probabilidad de Sí. */
  history: PricePoint[];
  auto: AutoRule | null;
  outcome: Side | null;
  /** Cuándo se resolvió, se anuló o se rechazó. */
  resolvedAt: string | null;
  source: string | null;
}

export interface Player {
  pid: string;
  alias: string;
  chips: number;
  joinedAt: string;
  /** Última semana (desde un lunes) en que recibió sus fichas. */
  week: number;
}

/** Quién pide: el jugador (hash del correo, como en los pronósticos), su nombre y si es el dueño de la app. */
export interface Who {
  pid: string;
  alias: string | null;
  owner: boolean;
}

/** Lo que usa el juego del almacenamiento del Durable Object. */
export interface GameStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface MarketView {
  id: number;
  question: string;
  details: string;
  category: Category;
  /** «cerrada»: pasó la fecha de cierre y falta el resultado. */
  state: 'propuesta' | 'rechazada' | 'abierta' | 'cerrada' | 'resuelta' | 'anulada';
  createdAt: string;
  closesAt: string;
  /** Probabilidad de Sí (0 a 1). Con b, qYes y qNo, el navegador calcula cuánto recibirías antes de comprar. */
  price: number;
  b: number;
  qYes: number;
  qNo: number;
  history: PricePoint[];
  volume: number;
  traders: number;
  mine: { yes: number; no: number; spent: number; value: number } | null;
  outcome: Side | null;
  resolvedAt: string | null;
  source: string | null;
  /** Cómo se resuelve sola, si está ligada a un dato. */
  auto: string | null;
  /** Nombre de quien la propuso (solo en las propuestas que ve el dueño). */
  proposer: string | null;
}

export interface GameView {
  me: { alias: string | null; chips: number | null; value: number | null };
  markets: MarketView[];
  proposals: MarketView[];
  /** Fichas totales: las que tiene cada uno más lo que recibiría si vendiera hoy sus acciones. */
  ranking: { alias: string; value: number; mine: boolean }[];
  rules: { start: number; weekly: number; payout: number; maxPending: number };
}

export type Reply = { view: GameView } | { error: { status: number; message: string } };

/** Respuesta para el Worker: los errores del juego viajan como datos (los de RPC no conservan su clase). */
export async function reply(fn: () => Promise<GameView>): Promise<Reply> {
  try {
    return { view: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { error: { status: e.status, message: e.message } };
    throw e;
  }
}

const bad = (message: string) => new ApiError('bad_request', 400, message);
const round2 = (v: number) => Math.round(v * 100) / 100;
const marketKey = (id: number) => `market:${String(id).padStart(6, '0')}`;

/** Semanas enteras desde el lunes 5 ene 1970, en la fecha de Lima: cambia cada lunes a la medianoche. */
export function weekOf(now: Date): number {
  const days = (Date.parse(`${isoDate(now, LIMA)}T00:00:00Z`) - Date.UTC(1970, 0, 5)) / 86_400_000;
  return Math.floor(days / 7);
}

/** Una línea de texto: sin caracteres de control y con los espacios juntos, de `min` a `max` caracteres. */
function text(v: unknown, min: number, max: number, what: string): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (s.length < min || s.length > max) throw bad(`${what}: de ${min} a ${max} caracteres.`);
  return s;
}

const CHOICE_TEXT: Record<Choice, string> = { sube: 'sube', mantiene: 'se mantiene', baja: 'baja' };

/** «Sí si el resultado de «…» es «baja»». */
export function describeAuto(rule: AutoRule): string {
  const q = questionById(rule.qid);
  const fmt = (v: ForecastValue) => (typeof v !== 'number' ? `«${CHOICE_TEXT[v as Choice] ?? v}»` : q?.unit === 'S/' ? `S/ ${v}` : `${v}%`);
  const cond = rule.op === 'es' ? `es ${fmt(rule.value)}` : `es ${fmt(rule.value)} o ${rule.op === 'min' ? 'más' : 'menos'}`;
  return `Se resuelve sola con el dato del juego de pronósticos: Sí si «${q?.title ?? rule.qid}» ${cond}.`;
}

export function autoOutcome(rule: AutoRule, result: ForecastValue): Side {
  if (rule.op === 'es') return result === rule.value ? 'si' : 'no';
  if (typeof result !== 'number' || typeof rule.value !== 'number') return 'no';
  return (rule.op === 'min' ? result >= rule.value : result <= rule.value) ? 'si' : 'no';
}

export class Juego {
  constructor(private readonly store: GameStorage) {}

  // ---------- lectura ----------

  private async markets(): Promise<Market[]> {
    return [...(await this.store.list<Market>({ prefix: 'market:' })).values()];
  }

  /** ¿Hay alguna pregunta (en cualquier estado)? Para cargar las de ejemplo solo en un mercado vacío. */
  async hasMarkets(): Promise<boolean> {
    return (await this.store.list({ prefix: 'market:' })).size > 0;
  }

  private async players(): Promise<Map<string, Player>> {
    const out = new Map<string, Player>();
    for (const p of (await this.store.list<Player>({ prefix: 'player:' })).values()) out.set(p.pid, p);
    return out;
  }

  private async market(id: unknown): Promise<Market> {
    const m = Number.isInteger(id) ? await this.store.get<Market>(marketKey(id as number)) : undefined;
    if (!m) throw bad('Esa pregunta no existe.');
    return m;
  }

  private savePlayer(p: Player) {
    return this.store.put(`player:${p.pid}`, p);
  }

  private saveMarket(m: Market) {
    return this.store.put(marketKey(m.id), m);
  }

  /**
   * Pone al día a todos: las fichas de cada lunes y las preguntas ligadas a un dato que ya salió. Corre en cada pedido
   * (son pocos y el Durable Object los atiende de a uno), así no hace falta una tarea programada.
   */
  private async settle(now: Date, results: Results): Promise<void> {
    const week = weekOf(now);
    const players = await this.players();
    for (const p of players.values()) {
      if (p.week >= week) continue;
      p.chips = round2(p.chips + WEEKLY_CHIPS * (week - p.week));
      p.week = week;
      await this.savePlayer(p);
    }
    for (const m of await this.markets()) {
      const r = m.status === 'abierta' && m.auto ? results[m.auto.qid] : undefined;
      if (r) await this.payout(m, autoOutcome(m.auto!, r.value), now, null, players);
    }
  }

  /** El jugador de quien pide (lo crea con sus fichas iniciales la primera vez). Sin nombre no se juega. */
  async join(who: Who, now: Date): Promise<Player | null> {
    if (!who.alias) return null;
    const p = await this.store.get<Player>(`player:${who.pid}`);
    if (p && p.alias === who.alias) return p;
    const next: Player = p ? { ...p, alias: who.alias } : { pid: who.pid, alias: who.alias, chips: START_CHIPS, joinedAt: now.toISOString(), week: weekOf(now) };
    await this.savePlayer(next);
    return next;
  }

  private async player(who: Who, now: Date): Promise<Player> {
    const p = await this.join(who, now);
    if (!p) throw bad('Para jugar, elige tu nombre en «Pronósticos».');
    return p;
  }

  async view(who: Who, now: Date, results: Results): Promise<GameView> {
    await this.settle(now, results);
    const me = await this.join(who, now);
    const players = await this.players();
    const markets = await this.markets();
    const since = Date.parse(addDays(isoDate(now, LIMA), -SHOW_DAYS));
    const recent = (m: Market) => !!m.resolvedAt && Date.parse(m.resolvedAt) >= since;

    const live = markets.filter((m) => m.status === 'abierta').sort((a, b) => a.closesAt.localeCompare(b.closesAt));
    const done = markets
      .filter((m) => (m.status === 'resuelta' || m.status === 'anulada') && recent(m))
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
    const proposals = markets
      .filter((m) => (who.owner ? m.status === 'propuesta' : m.createdBy === who.pid && (m.status === 'propuesta' || (m.status === 'rechazada' && recent(m)))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const valueOf = (pid: string, chips: number) =>
      round2(chips + live.reduce((sum, m) => sum + positionValue(m, m.positions[pid]), 0));
    const ranking = [...players.values()]
      .map((p) => ({ alias: p.alias, value: valueOf(p.pid, p.chips), mine: p.pid === who.pid }))
      .sort((a, b) => b.value - a.value || a.alias.localeCompare(b.alias));

    const show = (m: Market): MarketView => {
      const pos = m.positions[who.pid];
      const price = priceYes(m.qYes, m.qNo, m.b);
      const state = m.status === 'abierta' ? (now.getTime() >= Date.parse(m.closesAt) ? 'cerrada' : 'abierta') : m.status;
      return {
        id: m.id,
        question: m.question,
        details: m.details,
        category: m.category,
        state,
        createdAt: m.createdAt,
        closesAt: m.closesAt,
        price,
        b: m.b,
        qYes: m.qYes,
        qNo: m.qNo,
        history: m.history,
        volume: round2(m.volume),
        traders: Object.keys(m.positions).length,
        mine: pos ? { yes: pos.yes, no: pos.no, spent: round2(pos.spent), value: round2(m.status === 'abierta' ? positionValue(m, pos) : 0) } : null,
        outcome: m.outcome,
        resolvedAt: m.resolvedAt,
        source: m.source,
        auto: m.auto ? describeAuto(m.auto) : null,
        proposer: who.owner && m.status === 'propuesta' ? (players.get(m.createdBy)?.alias ?? null) : null,
      };
    };

    return {
      me: { alias: who.alias, chips: me ? round2(me.chips) : null, value: me ? valueOf(me.pid, me.chips) : null },
      markets: [...live, ...done].map(show),
      proposals: proposals.map(show),
      ranking,
      rules: { start: START_CHIPS, weekly: WEEKLY_CHIPS, payout: PAYOUT, maxPending: MAX_PENDING },
    };
  }

  // ---------- proponer y aprobar ----------

  /** Propone una pregunta. Las del dueño se abren de una; las demás esperan su aprobación. */
  async propose(who: Who, body: unknown, now: Date, results: Results): Promise<GameView> {
    await this.player(who, now);
    const b = (body ?? {}) as Record<string, unknown>;
    const question = text(b.question, 10, 140, 'La pregunta');
    const category = typeof b.category === 'string' && b.category in CATEGORIES ? (b.category as Category) : null;
    if (!category) throw bad('Elige una categoría.');

    let auto: AutoRule | null = null;
    let closesAt: string;
    if (b.auto != null) {
      if (!who.owner) throw new ApiError('forbidden', 403, 'Solo el dueño liga preguntas a un dato.');
      const a = b.auto as Record<string, unknown>;
      const q = typeof a.qid === 'string' ? questionById(a.qid) : null;
      if (!q || now.getTime() >= Date.parse(q.closesAt)) throw bad('Ese dato ya no está abierto en el juego de pronósticos.');
      const op = q.type === 'choice' ? 'es' : a.op === 'min' || a.op === 'max' ? a.op : null;
      if (!op) throw bad('Elige si el número tiene que ser mayor o menor.');
      const parsed = parseForecast(q, a.value);
      if ('error' in parsed) throw bad(parsed.error);
      auto = { qid: q.id, op, value: parsed.value };
      closesAt = q.closesAt;
    } else {
      const day = typeof b.closesOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.closesOn) ? b.closesOn : '';
      const today = isoDate(now, LIMA);
      if (!day || day <= today || day > addDays(today, 366)) throw bad('La fecha de cierre tiene que ser desde mañana y hasta dentro de un año.');
      // Se puede comprar hasta las 23:59 de ese día, hora de Lima.
      closesAt = zonedToUtc(day, '23:59', LIMA);
    }
    const details = auto && (b.details == null || b.details === '') ? describeAuto(auto) : text(b.details, 10, 300, 'Cómo se resuelve');

    const markets = await this.markets();
    if (!who.owner && markets.filter((m) => m.createdBy === who.pid && m.status === 'propuesta').length >= MAX_PENDING) {
      throw bad(`Ya tienes ${MAX_PENDING} preguntas esperando aprobación.`);
    }
    const meta = (await this.store.get<{ nextId: number }>('meta')) ?? { nextId: 1 };
    const at = now.toISOString();
    const open = who.owner;
    await this.saveMarket({
      id: meta.nextId,
      question,
      details,
      category,
      status: open ? 'abierta' : 'propuesta',
      createdBy: who.pid,
      createdAt: at,
      closesAt,
      b: LIQUIDITY,
      qYes: 0,
      qNo: 0,
      volume: 0,
      positions: {},
      history: open ? [{ at, p: 0.5 }] : [],
      auto,
      outcome: null,
      resolvedAt: null,
      source: null,
    });
    await this.store.put('meta', { nextId: meta.nextId + 1 });
    return this.view(who, now, results);
  }

  /** El dueño aprueba (se abre al 50 %) o rechaza una propuesta. */
  async review(who: Who, body: unknown, now: Date, results: Results): Promise<GameView> {
    if (!who.owner) throw new ApiError('forbidden', 403, 'Solo el dueño de la app aprueba preguntas.');
    const b = (body ?? {}) as { id?: unknown; approve?: unknown };
    const m = await this.market(b.id);
    if (m.status !== 'propuesta') throw bad('Esa pregunta ya no está esperando aprobación.');
    const at = now.toISOString();
    if (b.approve === true) {
      if (now.getTime() >= Date.parse(m.closesAt)) throw bad('Su fecha de cierre ya pasó: recházala y que la propongan con otra fecha.');
      Object.assign(m, { status: 'abierta', history: [{ at, p: 0.5 }] });
    } else Object.assign(m, { status: 'rechazada', resolvedAt: at });
    await this.saveMarket(m);
    return this.view(who, now, results);
  }

  // ---------- comprar y vender ----------

  async trade(who: Who, body: unknown, now: Date, results: Results): Promise<GameView> {
    await this.settle(now, results);
    const p = await this.player(who, now);
    const b = (body ?? {}) as { id?: unknown; side?: unknown; action?: unknown; chips?: unknown };
    const m = await this.market(b.id);
    if (m.status !== 'abierta' || now.getTime() >= Date.parse(m.closesAt)) throw bad('Esta pregunta ya cerró.');
    const side = b.side === 'si' || b.side === 'no' ? b.side : null;
    if (!side) throw bad('Elige Sí o No.');
    const pos = (m.positions[who.pid] ??= { yes: 0, no: 0, spent: 0 });
    const key = side === 'si' ? 'yes' : 'no';
    const q = side === 'si' ? 'qYes' : 'qNo';

    if (b.action === 'comprar') {
      const chips = Math.floor(Number(b.chips));
      if (!Number.isFinite(chips) || chips < 1) throw bad('Escribe cuántas fichas quieres poner.');
      if (chips > p.chips) throw bad(`Te alcanzan ${Math.floor(p.chips)} fichas.`);
      const shares = sharesFor(m.qYes, m.qNo, m.b, side, chips / PAYOUT);
      if (!(shares > 0)) throw bad('No se pudo calcular la compra.');
      m[q] += shares;
      pos[key] += shares;
      pos.spent = round2(pos.spent + chips);
      p.chips = round2(p.chips - chips);
      m.volume += chips;
    } else if (b.action === 'vender') {
      const shares = pos[key];
      if (shares < 1e-9) throw bad('No tienes acciones de ese lado.');
      const value = round2(saleValue(m.qYes, m.qNo, m.b, side, shares) * PAYOUT);
      m[q] -= shares;
      pos[key] = 0;
      pos.spent = round2(pos.spent - value);
      p.chips = round2(p.chips + value);
      m.volume += value;
    } else throw bad('¿Comprar o vender?');

    m.history.push({ at: now.toISOString(), p: priceYes(m.qYes, m.qNo, m.b) });
    if (m.history.length > MAX_HISTORY) m.history.splice(1, m.history.length - MAX_HISTORY);
    await this.saveMarket(m);
    await this.savePlayer(p);
    return this.view(who, now, results);
  }

  // ---------- resolver ----------

  /** El dueño da el resultado (Sí o No) o anula la pregunta (se devuelve lo puesto), con el enlace a la fuente. */
  async resolve(who: Who, body: unknown, now: Date, results: Results): Promise<GameView> {
    if (!who.owner) throw new ApiError('forbidden', 403, 'Solo el dueño de la app resuelve preguntas.');
    const b = (body ?? {}) as { id?: unknown; outcome?: unknown; source?: unknown };
    const m = await this.market(b.id);
    if (m.status !== 'abierta') throw bad('Esa pregunta no está abierta.');
    const outcome = b.outcome === 'si' || b.outcome === 'no' || b.outcome === 'anular' ? b.outcome : null;
    if (!outcome) throw bad('Elige Sí, No o anular.');
    let source: string | null = null;
    if (typeof b.source === 'string' && b.source.trim()) {
      source = b.source.trim();
      let ok = false;
      try {
        ok = new URL(source).protocol === 'https:';
      } catch {
        /* no es una URL */
      }
      if (!ok || source.length > 300) throw bad('La fuente tiene que ser un enlace que empiece con https://.');
    }
    await this.payout(m, outcome, now, source, await this.players());
    return this.view(who, now, results);
  }

  /** Paga las acciones ganadoras (o devuelve lo puesto si se anula) y cierra la pregunta. */
  private async payout(m: Market, outcome: Side | 'anular', now: Date, source: string | null, players: Map<string, Player>): Promise<void> {
    for (const [pid, pos] of Object.entries(m.positions)) {
      const p = players.get(pid);
      if (!p) continue;
      const credit = outcome === 'anular' ? pos.spent : (outcome === 'si' ? pos.yes : pos.no) * PAYOUT;
      p.chips = Math.max(0, round2(p.chips + credit));
      await this.savePlayer(p);
    }
    Object.assign(m, {
      status: outcome === 'anular' ? 'anulada' : 'resuelta',
      outcome: outcome === 'anular' ? null : outcome,
      resolvedAt: now.toISOString(),
      source,
    });
    await this.saveMarket(m);
  }
}

/**
 * Lo que valen hoy unas acciones: lo que se recibiría al venderlas ahora (en fichas). No se usa el último precio:
 * con él, comprar mucho de un lado empujaría el precio y «valdría» más de lo pagado, y el ranking se podría inflar.
 */
function positionValue(m: Market, pos: Position | undefined): number {
  if (!pos) return 0;
  const yes = pos.yes > 1e-9 ? saleValue(m.qYes, m.qNo, m.b, 'si', pos.yes) : 0;
  const no = pos.no > 1e-9 ? saleValue(m.qYes - pos.yes, m.qNo, m.b, 'no', pos.no) : 0;
  return (yes + no) * PAYOUT;
}
