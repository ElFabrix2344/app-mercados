// Pronósticos del grupo en KV. Cada pronóstico es una clave propia (`pron:f:<pregunta>:<jugador>`, con el valor en la
// metadata), así dos amigos que pronostican a la vez no se pisan; el nombre de cada jugador, igual (`pron:p:<jugador>`).
// Un solo `list` por prefijo trae todo (el plan gratis da 1.000 al día). Los resultados los escribe solo la tarea
// programada (`pron-results`). El jugador es el hash del correo de Access: el correo no se guarda ni se muestra.

import { ApiError } from '../lib/http';
import {
  CHOICES,
  SPECS,
  consensus,
  kindOf,
  parseForecast,
  questionById,
  questionsAt,
  readyToResolve,
  resolve,
  score,
  type Choice,
  type ForecastValue,
  type Question,
} from '../lib/forecasts';
import { peru, usa, type Deps } from './market';

const PREFIX = 'pron:';
export const RESULTS_KEY = 'pron-results';

export type Results = Record<string, { value: ForecastValue; at: string }>;

export interface Entry {
  qid: string;
  pid: string;
  value: ForecastValue;
  at: string;
}

export interface Store {
  entries: Entry[];
  /** Jugador → nombre en el ranking. */
  aliases: Record<string, string>;
}

/** Id del jugador: los primeros 16 caracteres del SHA-256 del correo. */
export async function playerId(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type Meta = { v?: ForecastValue; t?: string; a?: string };

export async function readStore(kv: KVNamespace): Promise<Store> {
  const store: Store = { entries: [], aliases: {} };
  let cursor: string | undefined;
  do {
    const page = await kv.list<Meta>({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      const [, type, a, b] = k.name.split(':');
      if (type === 'f' && a && b && k.metadata?.v !== undefined) store.entries.push({ qid: a, pid: b, value: k.metadata.v, at: k.metadata.t ?? '' });
      else if (type === 'p' && a && k.metadata?.a) store.aliases[a] = k.metadata.a;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return store;
}

// ---------- jugar ----------

/** De 2 a 20 caracteres: letras, números, espacios, punto, guion y guion bajo. */
const ALIAS_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,19}$/u;

export async function setAlias(kv: KVNamespace, email: string, raw: unknown): Promise<{ pid: string; alias: string }> {
  const alias = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!ALIAS_RE.test(alias)) throw new ApiError('bad_request', 400, 'El nombre debe tener de 2 a 20 letras o números.');
  const pid = await playerId(email);
  const { aliases } = await readStore(kv);
  if (Object.entries(aliases).some(([id, a]) => id !== pid && a.toLowerCase() === alias.toLowerCase())) {
    throw new ApiError('bad_request', 400, 'Ese nombre ya lo usa otro del grupo.');
  }
  await kv.put(`${PREFIX}p:${pid}`, '', { metadata: { a: alias } satisfies Meta });
  return { pid, alias };
}

/** Guarda (o cambia) el pronóstico del jugador mientras la pregunta está abierta. */
export async function submitForecast(kv: KVNamespace, email: string, now: Date, body: unknown): Promise<Entry> {
  const b = (body ?? {}) as { questionId?: unknown; value?: unknown };
  const q = typeof b.questionId === 'string' ? questionById(b.questionId) : null;
  if (!q) throw new ApiError('bad_request', 400, 'Esa pregunta no existe.');
  if (now.getTime() < Date.parse(q.opensAt)) throw new ApiError('bad_request', 400, 'Esa pregunta todavía no abre.');
  if (now.getTime() >= Date.parse(q.closesAt)) throw new ApiError('bad_request', 400, 'Esa pregunta ya cerró.');
  const parsed = parseForecast(q, b.value);
  if ('error' in parsed) throw new ApiError('bad_request', 400, parsed.error);
  const pid = await playerId(email);
  const { metadata } = await kv.getWithMetadata<Meta>(`${PREFIX}p:${pid}`);
  if (!metadata?.a) throw new ApiError('bad_request', 400, 'Primero elige tu nombre para el ranking.');
  const at = now.toISOString();
  await kv.put(`${PREFIX}f:${q.id}:${pid}`, '', { metadata: { v: parsed.value, t: at } satisfies Meta });
  return { qid: q.id, pid, value: parsed.value, at };
}

// ---------- lo que ve cada jugador ----------

export interface EntryView {
  alias: string;
  value: ForecastValue;
  points: number | null;
  mine: boolean;
}

export interface QuestionView extends Question {
  status: 'open' | 'closed' | 'resolved';
  /** Cuántos del grupo ya pronosticaron. */
  count: number;
  mine: ForecastValue | null;
  minePoints: number | null;
  /** Lo que puso cada uno: null mientras está abierta (se ven recién al cierre, así nadie copia). */
  entries: EntryView[] | null;
  /** Cuántos eligieron cada opción, o la mediana del grupo (también desde el cierre). */
  consensus: Record<Choice, number> | number | null;
  result: ForecastValue | null;
}

export interface RankRow {
  alias: string;
  points: number;
  /** Pronósticos ya resueltos. */
  count: number;
  mine: boolean;
}

export interface ForecastView {
  me: { alias: string | null };
  questions: QuestionView[];
  ranking: RankRow[];
}

const sortValues = (a: ForecastValue, b: ForecastValue) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : CHOICES.indexOf(a as Choice) - CHOICES.indexOf(b as Choice);

/**
 * Las preguntas (abiertas, cerradas y resueltas en los últimos 60 días) y el ranking de todo lo resuelto. `extra` suma
 * lo que se acaba de guardar (el `list` de KV puede tardar en mostrarlo); `results`, resultados que no vienen de KV.
 */
export async function forecastView(
  kv: KVNamespace,
  email: string,
  now: Date,
  opts: { extra?: Partial<Store>; results?: Results } = {},
): Promise<ForecastView> {
  const [store, stored] = await Promise.all([readStore(kv), kv.get<Results>(RESULTS_KEY, 'json')]);
  const results: Results = { ...(stored ?? {}), ...(opts.results ?? {}) };
  for (const e of opts.extra?.entries ?? []) {
    store.entries = store.entries.filter((x) => !(x.qid === e.qid && x.pid === e.pid));
    store.entries.push(e);
  }
  Object.assign(store.aliases, opts.extra?.aliases ?? {});
  const me = await playerId(email);
  const aliasOf = (pid: string) => store.aliases[pid] ?? 'Sin nombre';
  const byQuestion = new Map<string, Entry[]>();
  for (const e of store.entries) byQuestion.set(e.qid, [...(byQuestion.get(e.qid) ?? []), e]);

  const questions = questionsAt(now)
    // Las cerradas sin pronósticos no se muestran (por ejemplo, las de antes de que existiera el juego).
    .filter((q) => now.getTime() < Date.parse(q.closesAt) || byQuestion.has(q.id))
    .map((q): QuestionView => {
    const entries = byQuestion.get(q.id) ?? [];
    const result = results[q.id]?.value ?? null;
    const status = result !== null ? 'resolved' : now.getTime() >= Date.parse(q.closesAt) ? 'closed' : 'open';
    const mine = entries.find((e) => e.pid === me)?.value ?? null;
    const shown = status !== 'open';
    return {
      ...q,
      status,
      count: entries.length,
      mine,
      minePoints: mine !== null && result !== null ? score(q, mine, result) : null,
      entries: shown
        ? entries
            .map((e) => ({ alias: aliasOf(e.pid), value: e.value, points: result !== null ? score(q, e.value, result) : null, mine: e.pid === me }))
            .sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || sortValues(a.value, b.value))
        : null,
      consensus: shown ? consensus(q, entries.map((e) => e.value)) : null,
      result,
    };
  });

  // Ranking: todo lo resuelto, también lo que ya salió de la ventana de preguntas.
  const totals = new Map<string, { points: number; count: number }>();
  for (const e of store.entries) {
    const r = results[e.qid];
    const kind = kindOf(e.qid);
    if (!r || !kind) continue;
    const t = totals.get(e.pid) ?? { points: 0, count: 0 };
    t.points = Math.round((t.points + score(SPECS[kind], e.value, r.value)) * 10) / 10;
    t.count++;
    totals.set(e.pid, t);
  }
  const ranking = [...totals.entries()]
    .map(([pid, t]) => ({ alias: aliasOf(pid), points: t.points, count: t.count, mine: pid === me }))
    .sort((a, b) => b.points - a.points || a.count - b.count || a.alias.localeCompare(b.alias));

  return { me: { alias: store.aliases[me] ?? null }, questions, ranking };
}

// ---------- tarea programada ----------

/**
 * Resuelve las preguntas cuyo dato ya salió (con las cachés de Perú y EE. UU., que se renuevan cada 6 h) y guarda los
 * resultados en un solo registro. Si no hay nada por resolver, no pide ni escribe nada.
 */
export async function resolveForecasts(d: Deps): Promise<string[]> {
  const results = (await d.kv.get<Results>(RESULTS_KEY, 'json')) ?? {};
  const due = questionsAt(d.now).filter((q) => !results[q.id] && readyToResolve(q, d.now));
  if (!due.length) return [];
  const needPeru = due.some((q) => q.kind === 'bcrp' || q.kind === 'inei' || q.kind === 'dolar');
  const needUsa = due.some((q) => q.kind === 'fed' || q.kind === 'bls');
  const [pe, us] = await Promise.all([needPeru ? peru(d).catch(() => null) : null, needUsa ? usa(d).catch(() => null) : null]);
  const data = {
    policyRates: pe?.data.policyRates,
    inflationLima: pe?.data.inflation,
    fx: pe?.data.fx,
    fedTarget: us?.data.fedTarget,
    cpiYoY: us?.data.cpiYoY,
  };
  const done: string[] = [];
  for (const q of due) {
    const value = resolve(q, data, d.now);
    if (value === null) continue;
    results[q.id] = { value, at: d.now.toISOString() };
    done.push(q.id);
  }
  if (done.length) await d.kv.put(RESULTS_KEY, JSON.stringify(results));
  return done;
}
