// Polymarket: lo que pagan sus apostadores por «sí» en cada mercado de predicción (una probabilidad implícita, de 0
// a 1), de su API pública Gamma (sin clave). Sus términos dan una licencia personal y prohíben revender los datos a
// empresas financieras o a distribuidores de datos. El usuario eligió el 4 nov mostrarlos en Rueda con tarjetas propias
// y el widget oficial (embed.polymarket.com). Kalshi no: sus términos de datos prohíben mostrarlos a otros, guardarlos
// y usarlos con IA.

import { ApiError } from './http';

const BASE = 'https://gamma-api.polymarket.com';
/** Opciones que se muestran de cada evento (las demás se cuentan). */
const SHOWN = 4;

export interface PmOutcome {
  label: string;
  /** Probabilidad implícita (0 a 1). */
  p: number;
  /** Cambio en las últimas 24 horas (en la misma escala). */
  d1: number | null;
}

export interface PmEvent {
  slug: string;
  title: string;
  /** Cuándo se resuelve (ISO), si lo dice. */
  end: string | null;
  /** Dólares apostados en total y en la última semana. */
  volume: number;
  volume1wk: number;
  /**
   * «si-no»: una sola pregunta; «varias»: opciones que se excluyen (suman ~100 %, p. ej. quién gana); «escalera»:
   * preguntas sueltas sobre umbrales o fechas («¿llega a 800?», «¿antes de marzo?»), que no suman 100 %.
   */
  kind: 'si-no' | 'varias' | 'escalera';
  outcomes: PmOutcome[];
  /** Cuántas opciones abiertas tiene en total. */
  total: number;
  /** Para el widget oficial: un mercado (las de sí o no) o el evento entero. */
  embed: { market: string } | { event: string };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** «["Yes", "No"]» o ["Yes", "No"] → array (la API manda estos campos como texto con JSON adentro). */
function jsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Un evento de Gamma, ya listo para el panel; null si no tiene opciones abiertas. Las preguntas cuyo plazo ya pasó
 * (esperan que las resuelvan, como «¿sigue el alto el fuego hasta el 31 de octubre?» en noviembre) no cuentan.
 */
export function shapeEvent(raw: unknown, now = Date.now()): PmEvent | null {
  const e = (raw ?? {}) as Record<string, unknown>;
  const slug = typeof e.slug === 'string' ? e.slug : '';
  const title = typeof e.title === 'string' ? e.title.trim() : '';
  if (!slug || !title) return null;
  const ended = (m: Record<string, unknown>) => typeof m.endDate === 'string' && Date.parse(m.endDate) < now;
  const markets = (Array.isArray(e.markets) ? e.markets : [])
    .map((m) => (m ?? {}) as Record<string, unknown>)
    .filter((m) => m.closed !== true && m.active !== false && !ended(m));
  const rows = markets
    .map((m, i) => {
      const p = num(jsonList(m.outcomePrices)[0]);
      if (p === null) return null;
      const label = String(m.groupItemTitle || m.question || '').trim();
      const order = num(m.groupItemThreshold) ?? i;
      return { label, p: round(p), d1: num(m.oneDayPriceChange) === null ? null : round(num(m.oneDayPriceChange)!), order, slug: String(m.slug ?? '') };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!rows.length) return null;
  const kind: PmEvent['kind'] = rows.length === 1 ? 'si-no' : e.negRisk === true ? 'varias' : 'escalera';
  let shown: typeof rows;
  if (kind === 'si-no') shown = rows;
  else if (kind === 'varias') shown = [...rows].sort((a, b) => b.p - a.p).slice(0, SHOWN);
  else {
    // En una escalera lo que dice algo es lo que está cerca del 50 %: esas, en su orden (de umbral o de fecha).
    const near = [...rows].sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5)).slice(0, SHOWN);
    shown = rows.filter((r) => near.includes(r)).sort((a, b) => a.order - b.order);
  }
  return {
    slug,
    title,
    end: typeof e.endDate === 'string' ? e.endDate : null,
    volume: Math.round(num(e.volume) ?? 0),
    volume1wk: Math.round(num(e.volume1wk) ?? 0),
    kind,
    outcomes: shown.map(({ label, p, d1 }) => ({ label: kind === 'si-no' ? 'Sí' : label, p, d1 })),
    total: rows.length,
    embed: kind === 'si-no' && rows[0]!.slug ? { market: rows[0]!.slug } : { event: slug },
  };
}

async function gamma(path: string, f: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await f(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `Polymarket no respondió: ${(e as Error).message}`, 'polymarket');
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'Polymarket pidió esperar.', 'polymarket');
  if (!res.ok) throw new ApiError('upstream_error', 502, `Polymarket: HTTP ${res.status}`, 'polymarket');
  return res.json().catch(() => {
    throw new ApiError('bad_response', 502, 'Polymarket respondió algo que no es JSON.', 'polymarket');
  });
}

/** Los eventos abiertos de un tema (etiqueta de Polymarket), los de más dinero apostado en la semana primero. */
export async function eventsByTag(tag: string, limit: number, f: typeof fetch = fetch, now = Date.now()): Promise<PmEvent[]> {
  const body = await gamma(`/events?tag_slug=${encodeURIComponent(tag)}&closed=false&order=volume1wk&ascending=false&limit=${limit}`, f);
  return (Array.isArray(body) ? body : []).map((x) => shapeEvent(x, now)).filter((x): x is PmEvent => x !== null);
}

/** Un evento por su «slug» (lo que va después de /event/ en su dirección); null si no existe. */
export async function eventBySlug(slug: string, f: typeof fetch = fetch, now = Date.now()): Promise<PmEvent | null> {
  return shapeEvent(await gamma(`/events/slug/${encodeURIComponent(slug)}`, f), now);
}

/** «https://polymarket.com/event/fed-decision-in-december?tid=1» (o solo el slug) → «fed-decision-in-december». */
export function slugFromUrl(input: string): string | null {
  const s = input.trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?polymarket\.com\/(?:[a-z]{2}\/)?event\/([a-z0-9-]{3,200})(?:[/?#].*)?$/i.exec(s);
  if (m) return m[1]!.toLowerCase();
  const plain = s.toLowerCase();
  return /^[a-z0-9-]{3,200}$/.test(plain) ? plain : null;
}
