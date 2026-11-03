// Los juegos de la hoja «Juego» viven en un Durable Object con SQLite (está en el plan gratis): una sola instancia,
// «grupo», que atiende los pedidos de a uno, así dos compras al mismo tiempo no se pisan. El Worker lo llama por RPC
// con quién pide (ya validado por Access) y los datos públicos que hacen falta. La lógica está en juego.ts (mercado de
// predicciones) y en minijuegos.ts (2/3 del promedio, gráfico del día y liga de carteras).

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { seedDemoGame, seedDemoMinigames } from '../mock';
import type { Results } from '../services/forecasts';
import { Juego, reply, type Reply, type Who } from './juego';
import { Minijuegos, type GamesView } from './minijuegos';
import type { GamesInput } from './series';

export class JuegoDO extends DurableObject<Env> {
  private readonly game = new Juego(this.ctx.storage);
  private readonly minis = new Minijuegos(this.ctx.storage, this.game);

  // ---------- mercado de predicciones ----------

  view(who: Who, at: string, results: Results): Promise<Reply> {
    return reply(() => this.game.view(who, new Date(at), results));
  }

  propose(who: Who, body: unknown, at: string, results: Results): Promise<Reply> {
    return reply(() => this.game.propose(who, body, new Date(at), results));
  }

  review(who: Who, body: unknown, at: string, results: Results): Promise<Reply> {
    return reply(() => this.game.review(who, body, new Date(at), results));
  }

  trade(who: Who, body: unknown, at: string, results: Results): Promise<Reply> {
    return reply(() => this.game.trade(who, body, new Date(at), results));
  }

  resolve(who: Who, body: unknown, at: string, results: Results): Promise<Reply> {
    return reply(() => this.game.resolve(who, body, new Date(at), results));
  }

  // ---------- 2/3 del promedio, gráfico del día y liga de carteras ----------

  games(who: Who, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.view(who, new Date(at), input));
  }

  pick(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.pick(who, body, new Date(at), input));
  }

  answer(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.answer(who, body, new Date(at), input));
  }

  order(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.order(who, body, new Date(at), input));
  }

  /** Solo en desarrollo local con datos de prueba: preguntas y jugadores de ejemplo si el mercado está vacío. */
  seedDemo(at: string): Promise<void> {
    return seedDemoGame(this.game, new Date(at));
  }

  /** Solo en desarrollo local: números, respuestas y carteras de ejemplo si los otros juegos están vacíos. */
  seedDemoGames(at: string, input: GamesInput): Promise<void> {
    return seedDemoMinigames(this.ctx.storage, this.minis, new Date(at), input);
  }
}
