// «Lo que espera el mercado» (Polymarket, pedido del usuario el 4 nov: «agregar cosas como Polymarket o Kalshi»).
// Eligió tarjetas con el diseño de Rueda y el widget oficial, y dos temas de partida: «Bolsa y empresas» y «Política y
// mundo». En cada tema van los eventos abiertos con más dinero apostado en la semana; arriba, los que el dueño fija
// pegando su enlace. Un registro en KV (`polymarket`) que se renueva cada 30 minutos como mucho (hasta 48 escrituras
// al día); la lista de fijados va aparte (`polymarket-fijados`) y solo cambia cuando el dueño agrega o quita uno.

import { ApiError } from '../lib/http';
import { eventBySlug, eventsByTag, slugFromUrl, type PmEvent } from '../lib/polymarket';
import { cached, type Deps, type Fresh } from './market';

export const PM_TOPICS = [
  { id: 'bolsa', label: 'Bolsa y empresas', tags: ['business', 'stocks'] },
  { id: 'mundo', label: 'Política y mundo', tags: ['geopolitics', 'politics', 'world'] },
] as const;
export const PM_TTL_MS = 30 * 60_000;
export const PIN_MAX = 6;
const PER_TAG = 8;
const PER_TOPIC = 5;
const KEY = 'polymarket';
const PINS = 'polymarket-fijados';

export interface PmData {
  /** Los fijados por el dueño, en su orden (los que ya cerraron no aparecen). */
  pinned: PmEvent[];
  topics: { id: string; label: string; events: PmEvent[] }[];
  /** Con qué fijados se armó (si cambian, se arma de nuevo). */
  pins: string[];
}

export async function readPins(kv: KVNamespace): Promise<string[]> {
  const v = await kv.get<string[]>(PINS, 'json');
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}

const sameList = (a: string[] | undefined, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

async function load(d: Deps, pins: string[]): Promise<PmData> {
  const now = d.now.getTime();
  // Los que ya pasaron su fecha y esperan que los resuelvan no dicen nada nuevo.
  const open = (e: PmEvent) => !e.end || Date.parse(e.end) > now;
  const seen = new Set<string>();
  const pinned: PmEvent[] = [];
  for (const slug of pins) {
    const e = await eventBySlug(slug, d.fetch, now).catch(() => null);
    if (e) {
      pinned.push(e);
      seen.add(e.slug);
    }
  }
  const topics: PmData['topics'] = [];
  for (const t of PM_TOPICS) {
    const all: PmEvent[] = [];
    for (const tag of t.tags) all.push(...(await eventsByTag(tag, PER_TAG, d.fetch, now)));
    const events: PmEvent[] = [];
    for (const e of all.filter(open).sort((a, b) => b.volume1wk - a.volume1wk)) {
      // Un evento con varias etiquetas va una sola vez (en el primer tema y nunca si está fijado).
      if (seen.has(e.slug)) continue;
      seen.add(e.slug);
      events.push(e);
      if (events.length >= PER_TOPIC) break;
    }
    topics.push({ id: t.id, label: t.label, events });
  }
  return { pinned, topics, pins };
}

/** Lo que se muestra (para todos): guardado 30 minutos, y de nuevo si cambiaron los fijados. */
export async function polymarket(d: Deps): Promise<Fresh<PmData>> {
  const pins = await readPins(d.kv);
  return cached<PmData>(d, KEY, PM_TTL_MS, () => load(d, pins), { valid: (x) => sameList(x.pins, pins) });
}

const bad = (message: string) => new ApiError('bad_request', 400, message);

/** El dueño fija un evento pegando su enlace (se prueba que exista y siga abierto). */
export async function pinEvent(d: Deps, body: unknown): Promise<Fresh<PmData>> {
  const raw = (body as { url?: unknown } | null)?.url;
  const slug = typeof raw === 'string' ? slugFromUrl(raw) : null;
  if (!slug) throw bad('Pega el enlace de un evento de Polymarket (polymarket.com/event/…).');
  const pins = await readPins(d.kv);
  if (pins.includes(slug)) throw bad('Ese ya está fijado.');
  if (pins.length >= PIN_MAX) throw bad(`Máximo ${PIN_MAX} fijados: quita uno antes.`);
  if (!(await eventBySlug(slug, d.fetch, d.now.getTime()))) throw bad('No encontré ese evento en Polymarket, o ya no tiene preguntas abiertas.');
  await d.kv.put(PINS, JSON.stringify([...pins, slug]));
  return polymarket(d);
}

export async function unpinEvent(d: Deps, body: unknown): Promise<Fresh<PmData>> {
  const slug = (body as { slug?: unknown } | null)?.slug;
  const pins = await readPins(d.kv);
  if (typeof slug !== 'string' || !pins.includes(slug)) throw bad('Ese evento no está fijado.');
  await d.kv.put(PINS, JSON.stringify(pins.filter((s) => s !== slug)));
  return polymarket(d);
}
