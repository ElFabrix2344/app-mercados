// «Liga de acciones»: cada uno simula una cartera con acciones y ETF de verdad de EE. UU. (las mismas que hay en Hapi)
// y compite con el grupo. Empieza con US$ 10 000 de mentira y las órdenes se cumplen al cierre de Nueva York, así es el
// mismo precio para todos y nadie compra con ventaja.
//
// Se compite por temporadas de quincena (del 1 al 15 y del 16 a fin de mes, pedido del usuario el 4 nov): la cartera
// sigue igual de una a otra y gana quien más rinde en esos días. Al cerrar cada una queda guardado el resultado de todos
// (`SEASON` + id) y el campeón suma un trofeo.
//
// Los precios salen de Twelve Data con la clave gratis de cada jugador: la licencia gratis no permite mostrarles a
// otras personas los datos de la clave de Rueda. Cada uno ve sus precios con la suya; entre todos solo se comparan
// porcentajes y qué acciones tiene cada uno. El dueño juega con la clave de Rueda. Las claves se guardan cifradas
// (lib/secretbox.ts), y la tarea programada valoriza las carteras después de cada cierre, de a pocos símbolos.

import { ApiError } from '../lib/http';
import { isTradingDay, lastClosedSession, nextCloseSession } from '../lib/market-hours';
import { addDays, isoDate } from '../lib/num';
import { seal, unseal, type Sealed } from '../lib/secretbox';
import { getQuotes, getRecentCloses } from '../lib/twelvedata';
import type { GameStorage } from './juego';

export const START_USD = 10_000;
/** Contra qué se compara cada uno (solo lo ve él, con su clave). */
export const BENCHMARK = 'SPY';
/** Accesos rápidos para la primera compra: índices, tecnológicas, oro, Perú y empresas peruanas que cotizan en NY. */
export const POPULAR = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'GLD', 'EPU', 'BAP', 'SCCO', 'BVN'];
/** Símbolos por pasada de la tarea programada (cada 10 minutos): el plan gratis da 8 créditos por minuto y clave. */
const PER_TICK = 8;
/** El dueño comparte su clave con el panel: menos por pasada. */
const PER_TICK_APP = 4;
const MAX_ORDERS = 10;
const MAX_HOLDINGS = 30;
/** Sesiones de valor que se guardan por persona (más de un año). */
const MAX_VALUES = 400;
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const KEY_RE = /^[A-Za-z0-9]{16,64}$/;
const MEMBER = 'sm:';
/** Resultado guardado de cada temporada ya cerrada. */
const SEASON = 'ls:';
/** Si alguien no se valoriza (p. ej. su clave falla), la temporada se cierra igual a los 3 días. */
const SEASON_WAIT_DAYS = 3;
/** Temporadas que se mandan al panel (la lista completa de campeones crece de a 2 por mes). */
const SEASONS_SHOWN = 24;
const NY = 'America/New_York';

export interface Holding {
  shares: number;
  /** Dólares puestos (para mostrar cuánto gana o pierde). */
  cost: number;
  name: string;
}

export interface StockOrder {
  id: number;
  kind: 'comprar' | 'vender';
  symbol: string;
  name: string;
  /** Compra: cuántos dólares. Venta: cuántos dólares de esa posición (null = toda). */
  usd: number | null;
  /** Sesión (fecha de NY) cuyo cierre la cumple. */
  session: string;
}

interface Member {
  pid: string;
  key: Sealed | null;
  /** El dueño usa la clave de Rueda. */
  appKey: boolean;
  cash: number;
  holdings: Record<string, Holding>;
  orders: StockOrder[];
  nextOrder: number;
  /** Últimos cierres de cada símbolo, traídos con su clave. */
  closes: Record<string, { d: string; c: number }[]>;
  /** Valor de la cartera al cierre de cada sesión, y el SPY de ese día. */
  values: { d: string; v: number; spy: number | null }[];
  lastValued: string | null;
  joinedAt: string;
  /** Último problema con su clave (se muestra solo a él). */
  error: string | null;
}

export interface StockDeps {
  /** Para cifrar las claves (LOGIN_LINK_SECRET). */
  secret: string;
  /** La clave de Rueda (la usa el dueño). */
  appKey: string | undefined;
  fetch?: typeof fetch;
}

export interface StockView {
  /** La temporada en curso. `last`: su última sesión; `total` y `left`: sesiones en total y cierres que faltan. */
  season: Season & { last: string; total: number; left: number };
  popular: string[];
  me: {
    connected: boolean;
    appKey: boolean;
    error: string | null;
    value: number;
    cash: number;
    retSeason: number | null;
    retTotal: number;
    /** El SPY en la temporada, con su clave: solo lo ve él. */
    spySeason: number | null;
    holdings: { symbol: string; name: string; shares: number; value: number | null; ret: number | null }[];
    orders: StockOrder[];
    lastValued: string | null;
  } | null;
  /** Lo que ven todos: porcentajes y qué acciones tiene cada uno (nunca precios). */
  standings: { alias: string; retSeason: number | null; retTotal: number; symbols: string[]; mine: boolean }[];
  /** La carrera de la temporada: el rendimiento de cada uno al cierre de cada sesión (solo porcentajes). */
  race: { alias: string; mine: boolean; points: { d: string; r: number }[] }[];
  /** Temporadas cerradas, de la más nueva a la más vieja, con su podio. */
  seasons: { id: string; from: string; to: string; podium: { alias: string; ret: number; mine: boolean }[]; players: number }[];
  titles: { alias: string; titles: number; mine: boolean }[];
}

/** Una temporada: "2026-11-1" va del 1 al 15 de noviembre y "2026-11-2", del 16 al 30 (fechas de sesión de NY). */
export interface Season {
  id: string;
  from: string;
  to: string;
}

interface SeasonRecord extends Season {
  /** Del primero al último; vacío si nadie jugó esa temporada. */
  rows: { pid: string; ret: number }[];
  closedAt: string;
}

const bad = (message: string) => new ApiError('bad_request', 400, message);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Cierre de un símbolo en esa sesión o, si no hubo, el anterior. */
function closeOn(m: Member, symbol: string, session: string): number | null {
  let c: number | null = null;
  for (const p of m.closes[symbol] ?? []) {
    if (p.d > session) break;
    c = p.c;
  }
  return c;
}

/** Último valor guardado antes de esa fecha (para el arranque de un mes). */
const valueBefore = (m: Member, date: string) => [...m.values].reverse().find((x) => x.d < date) ?? null;
const lastDayOf = (month: string) => {
  const [y, mm] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
};

export function seasonOf(date: string): Season {
  const month = date.slice(0, 7);
  return Number(date.slice(8, 10)) <= 15
    ? { id: `${month}-1`, from: `${month}-01`, to: `${month}-15` }
    : { id: `${month}-2`, from: `${month}-16`, to: lastDayOf(month) };
}

const prevSeason = (s: Season) => seasonOf(addDays(s.from, -1));

/** Sesiones de la temporada (días hábiles de la NYSE). */
export function seasonSessions(s: Season): string[] {
  const out: string[] = [];
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}

/**
 * Lo que rindió en una temporada cerrada: del último valor antes de que empiece (o los US$ 10 000, si entró después) al
 * último dentro de ella. Sin ningún valor dentro de la temporada, no jugó esa temporada.
 */
function seasonReturn(m: Member, s: Season): number | null {
  const end = [...m.values].reverse().find((x) => x.d <= s.to);
  if (!end || end.d < s.from) return null;
  return end.v / (valueBefore(m, s.from)?.v ?? START_USD) - 1;
}

export class Acciones {
  constructor(
    private readonly store: GameStorage,
    private readonly deps: StockDeps,
  ) {}

  private get f(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  private async members(): Promise<Member[]> {
    return [...(await this.store.list<Member>({ prefix: MEMBER })).values()];
  }

  private member(pid: string) {
    return this.store.get<Member>(`${MEMBER}${pid}`);
  }

  private save(m: Member) {
    return this.store.put(`${MEMBER}${m.pid}`, m);
  }

  private fresh(pid: string, now: Date): Member {
    return { pid, key: null, appKey: false, cash: START_USD, holdings: {}, orders: [], nextOrder: 1, closes: {}, values: [], lastValued: null, joinedAt: now.toISOString(), error: null };
  }

  private async keyOf(m: Member): Promise<string | null> {
    if (m.appKey) return this.deps.appKey ?? null;
    return m.key ? unseal(this.deps.secret, m.key) : null;
  }

  // ---------- entrar ----------

  /** Conecta la clave gratis del jugador (la prueba pidiendo el precio del SPY) y lo hace entrar con US$ 10 000. */
  async connect(pid: string, body: unknown, now: Date): Promise<void> {
    const raw = (body as { key?: unknown } | null)?.key;
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!KEY_RE.test(key)) throw bad('Esa no parece una clave de Twelve Data: cópiala completa desde «API keys».');
    try {
      const q = await getQuotes([BENCHMARK], key, this.f);
      if (!q.quotes.length) throw new Error('sin precio');
    } catch (e) {
      throw bad(e instanceof ApiError && e.code === 'rate_limited' ? 'Twelve Data pidió esperar un minuto. Prueba de nuevo.' : 'Twelve Data no aceptó esa clave. Revisa que la copiaste completa.');
    }
    const m = (await this.member(pid)) ?? this.fresh(pid, now);
    Object.assign(m, { key: await seal(this.deps.secret, key), appKey: false, error: null });
    await this.save(m);
  }

  /** El dueño entra con la clave de Rueda, sin pegar nada. */
  async joinWithAppKey(pid: string, now: Date): Promise<void> {
    if (!this.deps.appKey) throw bad('Rueda no tiene clave de Twelve Data cargada.');
    const m = (await this.member(pid)) ?? this.fresh(pid, now);
    Object.assign(m, { key: null, appKey: true, error: null });
    await this.save(m);
  }

  /** Quita la clave: la cartera queda, pero deja de valorizarse hasta que se conecte otra. */
  async disconnect(pid: string): Promise<void> {
    const m = await this.member(pid);
    if (!m) return;
    Object.assign(m, { key: null, appKey: false });
    await this.save(m);
  }

  // ---------- órdenes ----------

  async order(pid: string, body: unknown, now: Date): Promise<void> {
    const b = (body ?? {}) as { action?: unknown; symbol?: unknown; usd?: unknown; cancel?: unknown };
    const m = await this.member(pid);
    if (!m || (!m.key && !m.appKey)) throw bad('Primero conecta tu clave de Twelve Data.');
    if (b.action === 'cancelar') {
      const before = m.orders.length;
      m.orders = m.orders.filter((o) => o.id !== b.cancel);
      if (m.orders.length === before) throw bad('Esa orden ya se cumplió o no existe.');
      return this.save(m);
    }
    const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
    if (!SYMBOL_RE.test(symbol)) throw bad('Escribe el símbolo de una acción o ETF de EE. UU., como NVDA o SPY.');
    if (m.orders.length >= MAX_ORDERS) throw bad(`Ya tienes ${MAX_ORDERS} órdenes esperando el cierre.`);
    const usd = b.usd == null || b.usd === '' ? null : Math.floor(Number(b.usd));
    const kind = b.action;
    let name = m.holdings[symbol]?.name ?? symbol;
    if (kind === 'comprar') {
      if (usd == null || !Number.isFinite(usd) || usd < 1) throw bad('Escribe cuántos dólares quieres poner.');
      const committed = m.orders.filter((o) => o.kind === 'comprar').reduce((s, o) => s + (o.usd ?? 0), 0);
      if (usd > m.cash - committed) throw bad(`Te quedan US$ ${Math.floor(Math.max(0, m.cash - committed))} sin invertir.`);
      if (!m.holdings[symbol] && Object.keys(m.holdings).length >= MAX_HOLDINGS) throw bad(`Máximo ${MAX_HOLDINGS} acciones distintas.`);
      name = await this.verify(m, symbol);
    } else if (kind === 'vender') {
      if (usd != null && (!Number.isFinite(usd) || usd < 1)) throw bad('Escribe cuántos dólares quieres vender, o vende todo.');
      if (!m.holdings[symbol] && !m.orders.some((o) => o.kind === 'comprar' && o.symbol === symbol)) throw bad(`No tienes ${symbol}.`);
    } else throw bad('¿Comprar o vender?');
    m.orders.push({ id: m.nextOrder++, kind, symbol, name, usd, session: nextCloseSession(now) });
    await this.save(m);
  }

  /** Que el símbolo exista y cotice en dólares (con la clave de quien compra). Devuelve su nombre. */
  private async verify(m: Member, symbol: string): Promise<string> {
    const key = await this.keyOf(m);
    if (!key) throw bad('Primero conecta tu clave de Twelve Data.');
    let q;
    try {
      q = await getQuotes([symbol], key, this.f);
    } catch (e) {
      throw bad(e instanceof ApiError && e.code === 'rate_limited' ? 'Twelve Data pidió esperar un minuto (límite del plan gratis). Prueba de nuevo.' : 'No se pudo consultar Twelve Data. Prueba de nuevo en un rato.');
    }
    const quote = q.quotes[0];
    if (!quote) throw bad(`No encontré ${symbol} en Twelve Data.`);
    if (quote.currency && quote.currency !== 'USD') throw bad(`${symbol} no cotiza en dólares: la liga es con acciones y ETF de EE. UU.`);
    return quote.name;
  }

  // ---------- cierre ----------

  /**
   * Después de cada cierre de Nueva York (la tarea programada, cada 10 minutos): por cada jugador, trae con su clave
   * los cierres que faltan, de a pocos; cuando están todos, cumple las órdenes de esa sesión y guarda el valor.
   */
  async tick(now: Date): Promise<void> {
    const session = lastClosedSession(now, 20);
    const nyToday = isoDate(now, NY);
    for (const m of await this.members()) {
      if ((m.lastValued && m.lastValued >= session) || (!m.key && !m.appKey)) continue;
      const need = new Set([BENCHMARK, ...Object.keys(m.holdings), ...m.orders.filter((o) => o.session <= session).map((o) => o.symbol)]);
      // Listo si hay cierre de esa sesión o, si ya pasó el día y no llegó (símbolo sin datos), el último anterior.
      const ready = (s: string) => {
        const pts = m.closes[s];
        if (!pts) return false;
        return pts.some((p) => p.d === session) || (nyToday > session && pts.some((p) => p.d < session));
      };
      const missing = [...need].filter((s) => !ready(s));
      if (missing.length) {
        try {
          const key = await this.keyOf(m);
          if (!key) continue;
          const r = await getRecentCloses(missing.slice(0, m.appKey ? PER_TICK_APP : PER_TICK), key, this.f);
          for (const [s, pts] of Object.entries(r.series)) m.closes[s] = pts.slice(-10).map((p) => ({ d: p.date, c: p.close }));
          m.error = null;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'not_configured') m.error = 'Twelve Data rechazó tu clave: conéctala de nuevo.';
          await this.save(m);
          continue;
        }
        if ([...need].some((s) => !ready(s))) {
          await this.save(m);
          continue;
        }
      }
      const left: StockOrder[] = [];
      for (const o of m.orders) {
        if (o.session > session) left.push(o);
        else {
          const c = closeOn(m, o.symbol, o.session);
          if (c != null) execute(m, o, c);
        }
      }
      m.orders = left;
      const value = m.cash + Object.entries(m.holdings).reduce((sum, [s, h]) => sum + h.shares * (closeOn(m, s, session) ?? 0), 0);
      m.values.push({ d: session, v: round2(value), spy: closeOn(m, BENCHMARK, session) });
      if (m.values.length > MAX_VALUES) m.values.splice(0, m.values.length - MAX_VALUES);
      m.lastValued = session;
      await this.save(m);
    }
    await this.closeSeasons(now);
  }

  /**
   * Guarda el resultado de las temporadas que ya terminaron y todavía no tienen registro. Espera a que estén
   * valorizados todos los que juegan; si alguno no se valoriza (clave rota), cierra igual a los 3 días.
   */
  private async closeSeasons(now: Date): Promise<void> {
    const today = isoDate(now, NY);
    const prev = prevSeason(seasonOf(today));
    if (await this.store.get(`${SEASON}${prev.id}`)) return;
    const members = await this.members();
    const first = members.flatMap((m) => m.values.map((x) => x.d)).sort()[0];
    if (!first) return;
    for (let s = prev; s.to >= first; s = prevSeason(s)) {
      if (s !== prev && (await this.store.get(`${SEASON}${s.id}`))) break; // las anteriores ya están guardadas
      const sessions = seasonSessions(s);
      const last = sessions.at(-1) ?? s.to;
      const waiting = members.some((m) => (m.key || m.appKey) && !m.error && m.lastValued != null && m.lastValued < last);
      if (waiting && today <= addDays(s.to, SEASON_WAIT_DAYS)) return;
      const rows = members
        .map((m) => ({ pid: m.pid, ret: seasonReturn(m, s) }))
        .filter((r): r is { pid: string; ret: number } => r.ret != null)
        .sort((a, b) => b.ret - a.ret)
        .map((r) => ({ pid: r.pid, ret: Math.round(r.ret * 1e6) / 1e6 }));
      const record: SeasonRecord = { ...s, rows, closedAt: now.toISOString() };
      await this.store.put(`${SEASON}${s.id}`, record);
    }
  }

  // ---------- lo que se ve ----------

  async view(pid: string, now: Date, aliases: Map<string, string>): Promise<StockView> {
    const season = seasonOf(isoDate(now, NY));
    const first = season.from;
    const members = await this.members();
    const name = (id: string) => aliases.get(id) ?? 'Sin nombre';
    const valueNow = (m: Member) => m.values.at(-1)?.v ?? START_USD;
    // Al empezar una temporada, antes del primer cierre, todos van en 0.
    const retSeason = (m: Member) => (m.values.length ? valueNow(m) / (valueBefore(m, first)?.v ?? START_USD) - 1 : null);
    // Al último cierre ya valorizado: así cada posición suma lo mismo que el valor del ranking.
    const latest = (m: Member, s: string) => (m.lastValued ? closeOn(m, s, m.lastValued) : (m.closes[s]?.at(-1)?.c ?? null));

    const playing = members.filter((m) => m.key || m.appKey || m.values.length);
    const standings = playing
      .map((m) => ({
        alias: name(m.pid),
        retSeason: retSeason(m),
        retTotal: valueNow(m) / START_USD - 1,
        symbols: Object.entries(m.holdings)
          .sort(([a, x], [b, y]) => y.shares * (latest(m, b) ?? 0) - x.shares * (latest(m, a) ?? 0))
          .map(([s]) => s),
        mine: m.pid === pid,
      }))
      .sort((a, b) => (b.retSeason ?? -Infinity) - (a.retSeason ?? -Infinity) || b.retTotal - a.retTotal || a.alias.localeCompare(b.alias));

    // La carrera: cada uno sale de 0 (si ya jugaba antes de la temporada) y suma un punto por cierre valorizado.
    const race = playing
      .map((m) => {
        const base = valueBefore(m, first);
        // Objetos y no tuplas: las tuplas pierden el tipo al cruzar el RPC del Durable Object.
        // La salida va el día antes de que empiece, para no caer en la fecha del primer cierre.
        const points: { d: string; r: number }[] = base ? [{ d: addDays(first, -1), r: 0 }] : [];
        for (const x of m.values) if (x.d >= first && x.d <= season.to) points.push({ d: x.d, r: Math.round((x.v / (base?.v ?? START_USD) - 1) * 1e6) / 1e6 });
        return { alias: name(m.pid), mine: m.pid === pid, points };
      })
      .filter((r) => r.points.length);

    // Campeones: las temporadas cerradas que guardó la tarea programada (las vacías no cuentan).
    const records = [...(await this.store.list<SeasonRecord>({ prefix: SEASON })).values()]
      .filter((r) => r.rows.length)
      .sort((a, b) => b.id.localeCompare(a.id));
    const titles = new Map<string, number>();
    for (const r of records) titles.set(r.rows[0]!.pid, (titles.get(r.rows[0]!.pid) ?? 0) + 1);
    const sessions = seasonSessions(season);
    const next = nextCloseSession(now);

    const mine = members.find((m) => m.pid === pid);
    let me: StockView['me'] = null;
    if (mine) {
      const base = valueBefore(mine, first);
      const spyNow = mine.values.at(-1)?.spy ?? null;
      me = {
        connected: !!(mine.key || mine.appKey),
        appKey: mine.appKey,
        error: mine.error,
        value: valueNow(mine),
        cash: round2(mine.cash),
        retSeason: retSeason(mine),
        retTotal: valueNow(mine) / START_USD - 1,
        spySeason: base?.spy && spyNow ? spyNow / base.spy - 1 : null,
        holdings: Object.entries(mine.holdings).map(([symbol, h]) => {
          const c = latest(mine, symbol);
          const value = c != null ? round2(h.shares * c) : null;
          return { symbol, name: h.name, shares: h.shares, value, ret: value != null && h.cost > 0 ? value / h.cost - 1 : null };
        }),
        orders: mine.orders,
        lastValued: mine.lastValued,
      };
    }
    return {
      season: { ...season, last: sessions.at(-1) ?? season.to, total: sessions.length, left: sessions.filter((d) => d >= next).length },
      popular: POPULAR,
      me,
      standings,
      race,
      seasons: records.slice(0, SEASONS_SHOWN).map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        podium: r.rows.slice(0, 3).map((x) => ({ alias: name(x.pid), ret: x.ret, mine: x.pid === pid })),
        players: r.rows.length,
      })),
      titles: [...titles.entries()].map(([id, n]) => ({ alias: name(id), titles: n, mine: id === pid })).sort((a, b) => b.titles - a.titles || a.alias.localeCompare(b.alias)),
    };
  }
}

/** Cumple una orden al cierre. Si ya no alcanza (o no queda qué vender), se cumple lo que se pueda. */
function execute(m: Member, o: StockOrder, close: number): void {
  const h = (m.holdings[o.symbol] ??= { shares: 0, cost: 0, name: o.name });
  if (o.kind === 'comprar') {
    const usd = Math.min(o.usd ?? 0, m.cash);
    h.shares += usd / close;
    h.cost += usd;
    m.cash -= usd;
  } else {
    const held = h.shares * close;
    const usd = o.usd == null ? held : Math.min(o.usd, held);
    const share = held > 0 ? usd / held : 0;
    h.shares -= h.shares * share;
    h.cost -= h.cost * share;
    m.cash += usd;
  }
  if (h.shares < 1e-9) delete m.holdings[o.symbol];
}
