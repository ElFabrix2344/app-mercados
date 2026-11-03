// «Gráfico del día»: un gráfico sin nombre ni escala de una serie pública de Rueda (dólar, cobre, oro, BVL, tasas,
// inflación…) y cuatro opciones. Una respuesta por persona y por día (de Lima), y la racha de días seguidos acertados.
// La serie del día se elige con la fecha como semilla y queda guardada: si cambian los datos durante el día, la
// pregunta sigue siendo la misma. La respuesta no sale del servidor hasta que contestas.

import { ApiError } from '../lib/http';
import { addDays } from '../lib/num';
import type { GameStorage } from './juego';
import type { ChartSeries } from './series';

const DAY = 'gd:';
const ANSWER = 'ga:';
const STATS = 'gs:';
/** Puntos mínimos para que una serie entre al juego. */
const MIN_POINTS = 10;

interface DayPuzzle {
  answer: string;
  options: string[];
}

interface Answer {
  option: string;
  correct: boolean;
  at: string;
}

interface Stats {
  played: number;
  correct: number;
  streak: number;
  best: number;
  /** Último día acertado: la racha sigue si fue ayer. */
  lastWin: string | null;
}

export interface ChartView {
  date: string;
  /** false si hoy no hay datos para armar el gráfico. */
  available: boolean;
  /** La forma: de 0 (el mínimo) a 100 (el máximo), sin escala para no regalar la respuesta. */
  points: number[];
  from: string | null;
  to: string | null;
  options: { id: string; name: string }[];
  mine: { option: string; correct: boolean } | null;
  /** Solo después de responder. */
  answer: { id: string; name: string } | null;
  today: { played: number; correct: number | null };
  yesterday: { name: string; played: number; correct: number } | null;
  me: { played: number; correct: number; streak: number; best: number } | null;
  top: { alias: string; streak: number; best: number; mine: boolean }[];
}

/** FNV-1a: la fecha como semilla. */
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Las series que sirven: con suficientes puntos y que se muevan (una tasa quieta sería una raya). */
const playable = (catalog: ChartSeries[]) =>
  catalog.filter((s) => s.points.length >= MIN_POINTS && Math.max(...s.points.map((p) => p.v)) > Math.min(...s.points.map((p) => p.v)));

/** La serie del día y sus cuatro opciones, sin repetir la de ayer. Null si no hay al menos cuatro series. */
export function pickPuzzle(date: string, catalog: ChartSeries[], avoid: string | null): DayPuzzle | null {
  const ok = playable(catalog).map((s) => s.id);
  if (ok.length < 4) return null;
  const rand = seeded(hash(date));
  const pool = ok.filter((id) => id !== avoid);
  const answer = pool[Math.floor(rand() * pool.length)]!;
  const others = shuffle(ok.filter((id) => id !== answer), rand).slice(0, 3);
  return { answer, options: shuffle([answer, ...others], rand) };
}

/** La forma de la serie, de 0 a 100. */
export function shape(values: number[]): number[] {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  return values.map((v) => Math.round(((v - lo) / span) * 1000) / 10);
}

export class Grafico {
  constructor(private readonly store: GameStorage) {}

  /** El gráfico del día: se arma la primera vez y queda guardado hasta medianoche. */
  private async puzzle(date: string, catalog: ChartSeries[]): Promise<DayPuzzle | null> {
    const saved = await this.store.get<DayPuzzle>(`${DAY}${date}`);
    if (saved) return saved;
    const yesterday = await this.store.get<DayPuzzle>(`${DAY}${addDays(date, -1)}`);
    const p = pickPuzzle(date, catalog, yesterday?.answer ?? null);
    if (p) await this.store.put(`${DAY}${date}`, p);
    return p;
  }

  async answer(pid: string, body: unknown, date: string, now: Date, catalog: ChartSeries[]): Promise<void> {
    const p = await this.puzzle(date, catalog);
    if (!p) throw new ApiError('bad_request', 400, 'Hoy no hay gráfico.');
    const option = (body as { option?: unknown } | null)?.option;
    if (typeof option !== 'string' || !p.options.includes(option)) throw new ApiError('bad_request', 400, 'Elige una de las cuatro opciones.');
    const key = `${ANSWER}${date}:${pid}`;
    if (await this.store.get<Answer>(key)) throw new ApiError('bad_request', 400, 'Ya respondiste el de hoy: mañana hay otro.');
    const correct = option === p.answer;
    await this.store.put(key, { option, correct, at: now.toISOString() } satisfies Answer);
    const s = (await this.store.get<Stats>(`${STATS}${pid}`)) ?? { played: 0, correct: 0, streak: 0, best: 0, lastWin: null };
    s.played++;
    if (correct) {
      s.correct++;
      s.streak = s.lastWin === addDays(date, -1) ? s.streak + 1 : 1;
      s.best = Math.max(s.best, s.streak);
      s.lastWin = date;
    } else s.streak = 0;
    await this.store.put(`${STATS}${pid}`, s);
  }

  async view(pid: string, date: string, catalog: ChartSeries[], aliases: Map<string, string>): Promise<ChartView> {
    const names = new Map(catalog.map((s) => [s.id, s.name]));
    const p = await this.puzzle(date, catalog);
    const series = p ? catalog.find((s) => s.id === p.answer) : undefined;
    const answers = [...(await this.store.list<Answer>({ prefix: `${ANSWER}${date}:` })).entries()];
    const mine = answers.find(([key]) => key.endsWith(`:${pid}`))?.[1] ?? null;
    const prevDate = addDays(date, -1);
    const prev = await this.store.get<DayPuzzle>(`${DAY}${prevDate}`);
    const prevAnswers = prev ? [...(await this.store.list<Answer>({ prefix: `${ANSWER}${prevDate}:` })).values()] : [];
    const stats = [...(await this.store.list<Stats>({ prefix: STATS })).entries()].map(([key, s]) => ({ pid: key.slice(STATS.length), ...s }));
    // Una racha que no siguió ayer ni hoy ya se cortó.
    const live = (s: Stats) => (s.lastWin === date || s.lastWin === prevDate ? s.streak : 0);
    const me = stats.find((s) => s.pid === pid);
    return {
      date,
      available: !!(p && series),
      points: series ? shape(series.points.map((x) => x.v)) : [],
      from: series?.points[0]?.d ?? null,
      to: series?.points.at(-1)?.d ?? null,
      options: p && series ? p.options.map((id) => ({ id, name: names.get(id) ?? id })) : [],
      mine: mine && { option: mine.option, correct: mine.correct },
      answer: mine && p ? { id: p.answer, name: names.get(p.answer) ?? p.answer } : null,
      today: { played: answers.length, correct: mine ? answers.filter(([, a]) => a.correct).length : null },
      yesterday: prev ? { name: names.get(prev.answer) ?? prev.answer, played: prevAnswers.length, correct: prevAnswers.filter((a) => a.correct).length } : null,
      me: me ? { played: me.played, correct: me.correct, streak: live(me), best: me.best } : null,
      top: stats
        .map((s) => ({ alias: aliases.get(s.pid) ?? 'Sin nombre', streak: live(s), best: s.best, mine: s.pid === pid }))
        .filter((s) => s.best > 0)
        .sort((a, b) => b.streak - a.streak || b.best - a.best || a.alias.localeCompare(b.alias))
        .slice(0, 5),
    };
  }
}
