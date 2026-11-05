// Buscador de acciones (5 nov, pedido del usuario: «una sección para poder buscar acciones específicas»; eligió la
// ficha completa y el buscador en la barra de arriba).
//
// Las sugerencias salen del buscador de EDGAR (SEC, público y gratis), así que son para todos. Abrir la ficha de una
// acción que no está en tus listas cuesta unos 2 créditos de Twelve Data (el precio y el historial de 5 años): con la
// clave de Rueda solo para el dueño, y para un amigo con la suya. Por eso cada persona tiene un tope de acciones nuevas
// al día y un registro de las que abrió (`buscadas`, en la KV del dueño o en la parte de cada amigo del Durable Object).
// Fuera de las listas, el historial, los titulares y los datos de empresa solo se piden de las que están ahí.
//
// El precio de las que busca el dueño sale de Finnhub (5 nov, pedido del usuario: «conecta finnhub a la búsqueda de
// precios»): no gasta créditos de Twelve Data, así que una acción nueva cuesta 1 crédito (el historial) en vez de 2. Sus
// términos no permiten mostrar sus datos a otros: los amigos siguen con su clave de Twelve Data.

import { finnhubGet, parseFinnhubQuote, parseProfile, shortExchange } from '../lib/finnhub';
import { ApiError } from '../lib/http';
import { usMarketOpen } from '../lib/market-hours';
import { isoDate } from '../lib/num';
import { SEARCH_RE, searchCompanies, type SecMatch } from '../lib/sec';
import { getQuotes, type Quote, type QuoteBatch } from '../lib/twelvedata';
import { creditsUsed, DAILY_CREDIT_CAP, needKey, quoteDue, spendCredits, SYMBOL_RE, type CacheDeps, type CacheStore } from './market';

/** Acciones nuevas por persona y por día (UTC, como los créditos): unos 40 créditos de los 800 del plan gratis. */
export const LOOKUP_DAILY_MAX = 20;
export const LOOKUP_KEY = 'buscadas';
/** Por cuánto sigue abierta la ficha de una buscada (historial, titulares, empresa) desde que se anotó. */
export const LOOKUP_KEEP_MS = 36 * 3_600_000;

export interface LookupEntry {
  /** Día (UTC) en que contó para el tope. */
  day: string;
  /** Cuándo se anotó por última vez. */
  at: string;
  quote: Quote | null;
  /** Cuándo se pidió el precio por última vez (null si nunca). */
  fetchedAt: string | null;
  /** Por qué no hay precio: Twelve Data no tiene el símbolo, o no en el plan gratis. */
  error: string | null;
  /** De dónde salió el precio (falta en lo guardado antes del 5 nov: era Twelve Data). */
  source?: PriceSource;
}

export type LookupStore = Record<string, LookupEntry>;

export type PriceSource = 'twelvedata' | 'finnhub';

/** El precio de una buscada, de dónde salió y cuántos créditos de Twelve Data costó (0 si vino de Finnhub). */
export interface QuotePick {
  batch: QuoteBatch;
  credits: number;
  source: PriceSource;
}

export type QuoteSource = (symbol: string) => Promise<QuotePick>;

/** Twelve Data: 1 crédito, con el freno del día. `get` reemplaza el pedido (pruebas y datos de prueba). */
export function twelveSource(d: CacheDeps, get?: (symbol: string) => Promise<QuoteBatch>): QuoteSource {
  return async (symbol) => {
    if ((await creditsUsed(d.kv, d.now)) + 1 > DAILY_CREDIT_CAP) {
      throw new ApiError('rate_limited', 429, 'Freno de créditos del día: se muestra el último precio guardado.', 'twelvedata');
    }
    const batch = await (get ? get(symbol) : getQuotes([symbol], needKey(d.twelveKey, 'TWELVE_DATA_API_KEY', 'twelvedata'), d.fetch));
    return { batch, credits: 1, source: 'twelvedata' };
  };
}

/**
 * Solo para el dueño: el precio de Finnhub (60 consultas por minuto en su plan gratis, sin créditos de Twelve Data), con
 * el nombre de su perfil. Divisas y cripto, o si Finnhub falla o no tiene el símbolo, van a Twelve Data. Finnhub da
 * precios de EE. UU., en dólares: la moneda del perfil es la de los informes (Credicorp informa en soles), no la del precio.
 */
export function finnhubFirst(d: CacheDeps & { finnhubKey?: string }, fallback: QuoteSource = twelveSource(d)): QuoteSource {
  return async (symbol) => {
    const key = d.finnhubKey;
    if (key && !symbol.includes('/')) {
      try {
        const [rawQuote, rawProfile] = await Promise.all([
          finnhubGet('/quote', { symbol }, key, d.fetch),
          finnhubGet('/stock/profile2', { symbol }, key, d.fetch).catch(() => null),
        ]);
        const q = parseFinnhubQuote(rawQuote);
        if (q) {
          const p = parseProfile(rawProfile);
          const quote: Quote = {
            symbol,
            name: p?.name ?? symbol,
            exchange: shortExchange(p?.exchange),
            currency: 'USD',
            price: q.price,
            prevClose: q.prevClose,
            change: q.change,
            changePct: q.changePct,
            asOf: q.asOf,
            isMarketOpen: null,
            low52: null,
            high52: null,
          };
          return { batch: { quotes: [quote], errors: {} }, credits: 0, source: 'finnhub' };
        }
      } catch {
        // Límite por minuto, clave o red de Finnhub: el precio sale de Twelve Data.
      }
    }
    return fallback(symbol);
  };
}

/** Lo guardado, sin lo que ya venció. */
async function readLookups(kv: CacheStore, now: Date): Promise<LookupStore> {
  const raw = await kv.get<LookupStore>(LOOKUP_KEY, 'json');
  const out: LookupStore = {};
  for (const [s, e] of Object.entries(raw ?? {})) if (e?.at && now.getTime() - Date.parse(e.at) < LOOKUP_KEEP_MS) out[s] = e;
  return out;
}

export interface LookupStatus {
  used: number;
  max: number;
  /** Las que ya se abrieron hoy: volver a abrirlas no cuenta. */
  today: string[];
}

function statusOf(store: LookupStore, now: Date): LookupStatus {
  const day = isoDate(now);
  const today = Object.keys(store).filter((s) => store[s]!.day === day);
  return { used: today.length, max: LOOKUP_DAILY_MAX, today };
}

export async function lookupStatus(kv: CacheStore, now: Date): Promise<LookupStatus> {
  return statusOf(await readLookups(kv, now), now);
}

/** La buscada con precio (de las demás no se pide nada más: Twelve Data tampoco tendría su historial). */
export async function lookedUp(kv: CacheStore, symbol: string, now: Date): Promise<LookupEntry | null> {
  const e = (await readLookups(kv, now))[symbol];
  return e?.quote ? e : null;
}

export interface LookupResult {
  symbol: string;
  quote: Quote | null;
  /** Si no hay precio, por qué. */
  error: string | null;
  fetchedAt: string | null;
  /** true si se muestra un precio guardado porque no se pudo renovar. */
  stale: boolean;
  note: string | null;
  market: { open: boolean };
  lookups: LookupStatus;
  /** Créditos de Twelve Data usados hoy con esta clave (el panel los muestra arriba). */
  credits: { used: number; cap: number };
  /** De dónde salió el precio. */
  source: PriceSource | null;
}

/**
 * Abre la ficha de un símbolo que no está en las listas: lo anota (si es nuevo hoy, cuenta para el tope) y trae su
 * precio con la regla de la lista (1 crédito; con la bolsa cerrada, una vez por sesión). Si el pedido falla por el
 * límite por minuto o el freno del día, no se anota: se puede volver a intentar. Si Twelve Data no tiene el símbolo, sí
 * (el crédito ya se gastó) y no se vuelve a pedir hasta la próxima sesión.
 */
export async function lookup(
  d: CacheDeps,
  raw: string,
  opts: { force?: boolean; getQuote?: (symbol: string) => Promise<QuoteBatch>; source?: QuoteSource } = {},
): Promise<LookupResult> {
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) throw new ApiError('bad_request', 400, 'Escribe un símbolo como AAPL, BRK.B o BTC/USD.');
  const store = await readLookups(d.kv, d.now);
  const day = isoDate(d.now);
  const prev = store[symbol];
  if (prev?.day !== day && statusOf(store, d.now).used >= LOOKUP_DAILY_MAX) {
    throw new ApiError(
      'daily_limit',
      429,
      `Ya abriste ${LOOKUP_DAILY_MAX} acciones nuevas hoy: es el tope del día, para cuidar los créditos. Las de tus listas se abren igual y mañana se libera.`,
      'twelvedata',
    );
  }
  const entry: LookupEntry = prev ? { ...prev, day } : { day, at: d.now.toISOString(), quote: null, fetchedAt: null, error: null };
  let changed = !prev || prev.day !== day;
  let stale = false;
  let note: string | null = null;
  if (quoteDue(entry.fetchedAt ?? undefined, symbol, d.now, !!opts.force)) {
    try {
      const pick = await (opts.source ?? twelveSource(d, opts.getQuote))(symbol);
      if (pick.credits) await spendCredits(d.kv, d.now, pick.credits);
      const batch = pick.batch;
      const q = batch.quotes.find((x) => x.symbol === symbol) ?? batch.quotes[0] ?? null;
      const why = batch.errors[symbol] ?? Object.values(batch.errors)[0] ?? 'sin precio';
      if (q) {
        entry.quote = { ...q, symbol };
        entry.error = null;
        entry.source = pick.source;
      } else if (entry.quote) {
        stale = true;
        note = `Twelve Data: ${why}`;
      } else {
        entry.error = noPrice(symbol, why);
      }
      entry.fetchedAt = d.now.toISOString();
      changed = true;
    } catch (e) {
      // Sin precio guardado no hay ficha: el error va tal cual y no se anota nada.
      if (!(e instanceof ApiError) || !entry.quote) throw e;
      stale = true;
      note = e.message;
    }
  }
  if (changed) {
    entry.at = d.now.toISOString();
    store[symbol] = entry;
    await d.kv.put(LOOKUP_KEY, JSON.stringify(store));
  }
  return {
    symbol,
    quote: entry.quote,
    error: entry.quote ? null : entry.error,
    fetchedAt: entry.fetchedAt,
    stale,
    note,
    market: { open: usMarketOpen(d.now) },
    lookups: statusOf({ ...store, [symbol]: entry }, d.now),
    credits: { used: await creditsUsed(d.kv, d.now), cap: DAILY_CREDIT_CAP },
    source: entry.quote ? (entry.source ?? 'twelvedata') : null,
  };
}

/** El error de Twelve Data en palabras del panel («**symbol** not found: X» → «no encuentra X»). */
export function noPrice(symbol: string, why: string): string {
  if (/not found|invalid symbol/i.test(why)) return `Twelve Data no encuentra ${symbol}: revisa el símbolo (las clases van con punto, como BRK.B).`;
  if (/plan|upgrade|available starting/i.test(why)) return `Twelve Data no tiene ${symbol} en el plan gratis.`;
  return `Twelve Data no tiene precios de ${symbol}: ${why.replace(/\*+/g, '')}`;
}

// ---------- sugerencias (SEC) ----------

const SEARCH_TTL_MS = 10 * 60_000;
/** Cada instancia del Worker recuerda las últimas búsquedas un rato: escribir «nvi», «nvid», «nvidia» repite pedidos. */
const searchCache = new Map<string, { at: number; results: SecMatch[] }>();

export function resetSearchCache(): void {
  searchCache.clear();
}

/** Lo escrito en el buscador, sin espacios de más; error si no es un nombre o un símbolo. */
export function searchQuery(q: string): string {
  const typed = q.trim().replace(/\s+/g, ' ');
  if (!SEARCH_RE.test(typed)) throw new ApiError('bad_request', 400, 'Escribe el nombre o el símbolo de una acción (hasta 40 letras).');
  return typed;
}

/**
 * Sugerencias del buscador: empresas de la SEC por nombre o ticker (acciones y algunos ETF de EE. UU. y ADR). Las
 * divisas y la cripto (USD/PEN, BTC/USD) no están en la SEC: el panel las ofrece tal como se escriben. No se guarda
 * nada en KV (cada búsqueda sería una escritura).
 */
export async function suggest(q: string, f?: typeof fetch, now = Date.now()): Promise<SecMatch[]> {
  const typed = searchQuery(q);
  if (typed.includes('/')) return [];
  const key = typed.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && now - hit.at < SEARCH_TTL_MS) return hit.results;
  const results = await searchCompanies(typed, f);
  searchCache.set(key, { at: now, results });
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value!);
  return results;
}
