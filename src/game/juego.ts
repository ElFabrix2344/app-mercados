// Lo que comparten los juegos de la hoja «Juego», que viven en un Durable Object (game/juego-do.ts): el almacenamiento,
// quién pide, cómo vuelven los errores por RPC, las semanas (desde el lunes, en Lima) y los jugadores con su nombre,
// que es el mismo del juego de pronósticos.

import { ApiError } from '../lib/http';
import { isoDate } from '../lib/num';

const LIMA = 'America/Lima';

export interface Player {
  pid: string;
  alias: string;
  joinedAt: string;
}

/** Quién pide: el jugador (hash del correo, como en los pronósticos), su nombre y si es el dueño de la app. */
export interface Who {
  pid: string;
  alias: string | null;
  owner: boolean;
}

/** Lo que usan los juegos del almacenamiento del Durable Object. */
export interface GameStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

export type Reply<T> = { view: T } | { error: { status: number; message: string } };

/** Respuesta para el Worker: los errores del juego viajan como datos (los de RPC no conservan su clase). */
export async function reply<T>(fn: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { view: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { error: { status: e.status, message: e.message } };
    throw e;
  }
}

/** Semanas enteras desde el lunes 5 ene 1970, en la fecha de Lima: cambia cada lunes a la medianoche. */
export function weekOf(now: Date): number {
  const days = (Date.parse(`${isoDate(now, LIMA)}T00:00:00Z`) - Date.UTC(1970, 0, 5)) / 86_400_000;
  return Math.floor(days / 7);
}

/** Los jugadores y sus nombres (sin nombre se puede mirar, pero no jugar). */
export class Jugadores {
  constructor(private readonly store: GameStorage) {}

  /** El jugador de quien pide: se crea la primera vez y se le actualiza el nombre si lo cambió. */
  async join(who: Who, now: Date): Promise<Player | null> {
    if (!who.alias) return null;
    const p = await this.store.get<Player>(`player:${who.pid}`);
    if (p && p.alias === who.alias) return p;
    const next: Player = p ? { ...p, alias: who.alias } : { pid: who.pid, alias: who.alias, joinedAt: now.toISOString() };
    await this.store.put(`player:${who.pid}`, next);
    return next;
  }

  /** Nombre de cada jugador. */
  async aliases(): Promise<Map<string, string>> {
    return new Map([...(await this.store.list<Player>({ prefix: 'player:' })).values()].map((p) => [p.pid, p.alias]));
  }
}
