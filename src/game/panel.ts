// Precios para los amigos con su propia clave de Twelve Data (pedido del usuario el 4 nov: «que puedan ver toda la
// info»). Es la misma clave que conectan para la liga, una para todo. Corre dentro del Durable Object del juego, donde
// esa clave ya está cifrada, así que no sale de ahí.
//
// Cada amigo tiene su propia caché con el prefijo `pn:<pid>:`: su lista de seguimiento, sus precios, sus historiales de
// 5 años y sus créditos del día, con el mismo freno de 600 de 800 que el dueño. Lo que trae la clave de uno no lo ve
// nadie más: es su uso personal, como en la liga. El dueño sigue con la KV y la clave de Rueda. Va en el Durable Object
// y no en la KV porque el plan gratis le da 100.000 escrituras al día, contra 1.000 de la KV para toda la cuenta.
//
// No llega a los amigos lo que es solo del dueño: Finnhub (sus términos), la lista diaria y su cartera.

import { ApiError } from '../lib/http';
import { mockSymbolNews } from '../mock';
import {
  compare,
  compareSymbols,
  creditsUsed,
  DAILY_CREDIT_CAP,
  getWatchlist,
  history,
  isRange,
  MAX_SYMBOLS,
  quotes,
  RANGES,
  saveWatchlist,
  validateWatchlist,
  type CacheStore,
  type Range,
} from '../services/market';
import { quoteName, symbolNews } from '../services/news';
import { thermometer } from '../services/thermometer';
import type { GameStorage } from './juego';

/** Prefijo de la caché de cada amigo en el Durable Object. */
export const PANEL = 'pn:';
/** Lo único que queda si quita su clave: la lista que eligió (no son datos de Twelve Data). */
const KEEP = 'watchlist';

export type PanelRequest =
  | { op: 'watchlist' }
  | { op: 'save-watchlist'; body: unknown }
  | { op: 'quotes'; refresh: boolean }
  | { op: 'history'; symbol: string; range: string; ind: boolean }
  | { op: 'compare'; symbols: string[]; range: string }
  | { op: 'thermometer' }
  | { op: 'news'; symbol: string };

/** La respuesta ya en JSON y con su código: así cruza el RPC tal cual y el Worker la devuelve sin tocarla. */
export interface PanelReply {
  status: number;
  body: string;
}

/** La caché de un amigo, con la misma forma que la KV del panel del dueño (se guarda el mismo JSON). */
export function panelStore(store: GameStorage, pid: string): CacheStore {
  const prefix = `${PANEL}${pid}:`;
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await store.get<string>(prefix + key);
      return raw == null ? null : (JSON.parse(raw) as T);
    },
    async put(key: string, value: string): Promise<void> {
      await store.put(prefix + key, value);
    },
  };
}

/** Borra lo que trajo la clave de un amigo (precios, historiales y créditos). Su lista queda. */
export async function forgetPanel(store: GameStorage, pid: string): Promise<void> {
  const prefix = `${PANEL}${pid}:`;
  for (const key of (await store.list({ prefix })).keys()) {
    if (key !== prefix + KEEP) await store.delete(key);
  }
}

function rangeOf(v: string): Range {
  if (!isRange(v)) throw new ApiError('bad_request', 400, `Rango no válido. Usa uno de: ${RANGES.join(', ')}.`);
  return v;
}

export class PanelAmigo {
  constructor(
    private readonly store: GameStorage,
    /** La clave propia del jugador (la de la liga), o null si no conectó una. */
    private readonly keyOf: (pid: string) => Promise<string | null>,
    /** En local: el Twelve Data de mentira y noticias de prueba. */
    private readonly opts: { fetch?: typeof fetch; mock?: boolean } = {},
  ) {}

  async handle(pid: string, now: Date, req: PanelRequest): Promise<unknown> {
    const key = await this.keyOf(pid);
    if (!key) throw new ApiError('forbidden', 403, 'Para ver precios y gráficos, conecta tu clave gratis de Twelve Data (la misma de la liga).');
    const kv = panelStore(this.store, pid);
    const d = { kv, now, twelveKey: key, fetch: this.opts.fetch };
    const list = () => getWatchlist(kv);
    /** Historiales, comparaciones y noticias: solo de los símbolos de su lista. */
    const inList = async (raw: string): Promise<string> => {
      const symbol = raw.trim().toUpperCase();
      if (!(await list()).includes(symbol)) throw new ApiError('bad_request', 400, 'Eso solo se puede ver de los símbolos de tu lista de seguimiento.');
      return symbol;
    };
    switch (req.op) {
      case 'watchlist':
        return { symbols: await list(), max: MAX_SYMBOLS };
      case 'save-watchlist': {
        const symbols = validateWatchlist(req.body);
        await saveWatchlist(kv, symbols);
        return { symbols, max: MAX_SYMBOLS };
      }
      case 'quotes': {
        const res = await quotes(d, await list(), req.refresh);
        return { ...res, credits: { used: await creditsUsed(kv, now), cap: DAILY_CREDIT_CAP } };
      }
      case 'history': {
        const symbol = await inList(req.symbol);
        const r = await history(d, symbol, rangeOf(req.range));
        // Indicadores, velas y volumen pesan más que los cierres: van solo si se piden (como para el dueño).
        return req.ind ? r : { ...r, indicators: undefined, bars: undefined };
      }
      case 'compare': {
        const own = await list();
        const symbols = compareSymbols(req.symbols);
        const outside = symbols.filter((s) => !own.includes(s));
        if (outside.length) throw new ApiError('bad_request', 400, `${outside.join(', ')} no está en tu lista.`);
        return compare(d, symbols, rangeOf(req.range));
      }
      case 'thermometer':
        return thermometer(d);
      case 'news': {
        // Titulares públicos (RSS), sin guardar nada: el nombre de la empresa sale de sus propios precios.
        const symbol = await inList(req.symbol);
        const items = this.opts.mock ? mockSymbolNews(symbol, now) : await symbolNews(d, symbol, await quoteName(kv, symbol));
        return { symbol, items, fetchedAt: now.toISOString() };
      }
    }
  }
}

/** Corre un pedido del panel y deja la respuesta lista para el Worker; los errores van con su código y su mensaje. */
export async function panelReply(fn: () => Promise<unknown>): Promise<PanelReply> {
  try {
    return { status: 200, body: JSON.stringify(await fn()) };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: JSON.stringify({ error: { code: e.code, message: e.message, provider: e.provider ?? null } }) };
    throw e;
  }
}
