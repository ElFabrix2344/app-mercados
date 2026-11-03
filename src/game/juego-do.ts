// El mercado de predicciones vive en un Durable Object con SQLite (está en el plan gratis): una sola instancia,
// «grupo», que atiende los pedidos de a uno, así dos compras al mismo tiempo no se pisan. El Worker lo llama por RPC
// con quién pide (ya validado por Access) y los resultados del juego de pronósticos; la lógica está en juego.ts.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { seedDemoGame } from '../mock';
import type { Results } from '../services/forecasts';
import { Juego, reply, type Reply, type Who } from './juego';

export class JuegoDO extends DurableObject<Env> {
  private readonly game = new Juego(this.ctx.storage);

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

  /** Solo en desarrollo local con datos de prueba: preguntas y jugadores de ejemplo si el mercado está vacío. */
  seedDemo(at: string): Promise<void> {
    return seedDemoGame(this.game, new Date(at));
  }
}
