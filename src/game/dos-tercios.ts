// «2/3 del promedio» (inspirado en el «concurso de belleza» de Keynes): cada semana cada uno elige un número del 0 al
// 100 y gana quien quede más cerca de 2/3 del promedio del grupo. Lo que eligió cada uno se ve recién al cierre, el
// lunes a la medianoche de Lima. No usa datos de afuera: el juego es adivinar cómo piensan los demás.

import { zonedToUtc } from '../lib/calendar';
import { ApiError } from '../lib/http';
import { addDays } from '../lib/num';
import { weekOf, type GameStorage } from './juego';

const PICK = 'k23:';
const RESULT = 'k23r:';
const pad = (week: number) => String(week).padStart(6, '0');

export interface K23Result {
  week: number;
  /** Con menos de dos jugadores no hay ganador: queda registrada igual. */
  avg: number | null;
  target: number | null;
  picks: { pid: string; value: number }[];
  winners: string[];
}

export interface K23View {
  week: number;
  closesAt: string;
  /** Cuántos ya eligieron esta semana (lo que eligió cada uno se ve al cierre). */
  count: number;
  mine: number | null;
  last: { week: number; avg: number | null; target: number | null; winners: string[]; picks: { alias: string; value: number; mine: boolean }[] } | null;
  wins: { alias: string; wins: number; mine: boolean }[];
}

/** Lunes (fecha de Lima) en que empieza esa semana. */
export const weekStart = (week: number) => addDays('1970-01-05', week * 7);
/** Cierre: el lunes siguiente a la medianoche de Lima. */
export const weekClose = (week: number) => zonedToUtc(weekStart(week + 1), '00:00', 'America/Lima');

const round2 = (v: number) => Math.round(v * 100) / 100;

/** El resultado de una semana: promedio, 2/3 del promedio y quiénes quedaron más cerca (pueden empatar). */
export function scoreWeek(week: number, picks: { pid: string; value: number }[]): K23Result {
  if (picks.length < 2) return { week, avg: null, target: null, picks, winners: [] };
  const avg = picks.reduce((s, p) => s + p.value, 0) / picks.length;
  const target = (2 / 3) * avg;
  const best = Math.min(...picks.map((p) => Math.abs(p.value - target)));
  const winners = picks.filter((p) => Math.abs(p.value - target) - best < 1e-9).map((p) => p.pid);
  return { week, avg: round2(avg), target: round2(target), picks, winners };
}

export class DosTercios {
  constructor(private readonly store: GameStorage) {}

  /** Cierra las semanas que ya terminaron: guarda su resultado y borra los números sueltos. */
  async settle(now: Date): Promise<void> {
    const current = weekOf(now);
    const byWeek = new Map<number, { key: string; pid: string; value: number }[]>();
    for (const [key, p] of await this.store.list<{ value: number }>({ prefix: PICK })) {
      const [, w, pid] = key.split(':');
      const week = Number(w);
      if (week >= current || !pid) continue;
      byWeek.set(week, [...(byWeek.get(week) ?? []), { key, pid, value: p.value }]);
    }
    for (const [week, picks] of byWeek) {
      await this.store.put(`${RESULT}${pad(week)}`, scoreWeek(week, picks.map(({ pid, value }) => ({ pid, value }))));
      for (const p of picks) await this.store.delete(p.key);
    }
  }

  /** Elige (o cambia) el número de esta semana: un entero del 0 al 100. */
  async pick(pid: string, body: unknown, now: Date): Promise<void> {
    const raw = (body as { value?: unknown } | null)?.value;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new ApiError('bad_request', 400, 'Elige un número entero del 0 al 100.');
    await this.store.put(`${PICK}${pad(weekOf(now))}:${pid}`, { value, at: now.toISOString() });
  }

  async view(pid: string, now: Date, aliases: Map<string, string>): Promise<K23View> {
    const week = weekOf(now);
    const picks = await this.store.list<{ value: number }>({ prefix: `${PICK}${pad(week)}:` });
    const results = [...(await this.store.list<K23Result>({ prefix: RESULT })).values()];
    const last = results.at(-1) ?? null;
    const name = (id: string) => aliases.get(id) ?? 'Sin nombre';
    const wins = new Map<string, number>();
    for (const r of results) for (const w of r.winners) wins.set(w, (wins.get(w) ?? 0) + 1);
    return {
      week,
      closesAt: weekClose(week),
      count: picks.size,
      mine: picks.get(`${PICK}${pad(week)}:${pid}`)?.value ?? null,
      last: last && {
        week: last.week,
        avg: last.avg,
        target: last.target,
        winners: last.winners.map(name),
        picks: last.picks
          .map((p) => ({ alias: name(p.pid), value: p.value, mine: p.pid === pid }))
          .sort((a, b) => a.value - b.value || a.alias.localeCompare(b.alias)),
      },
      wins: [...wins.entries()]
        .map(([id, n]) => ({ alias: name(id), wins: n, mine: id === pid }))
        .sort((a, b) => b.wins - a.wins || a.alias.localeCompare(b.alias)),
    };
  }
}
