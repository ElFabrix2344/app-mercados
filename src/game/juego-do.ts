// Los juegos de la hoja «Juego» viven en un Durable Object con SQLite (está en el plan gratis): una sola instancia,
// «grupo», que atiende los pedidos de a uno, así dos órdenes al mismo tiempo no se pisan. El Worker lo llama por RPC
// con quién pide (ya validado por Access) y los datos públicos que hacen falta. La lógica está en minijuegos.ts
// (gráfico del día y 2/3 del promedio) y en acciones.ts (liga de acciones).

import { DurableObject } from 'cloudflare:workers';
import { trimSecrets, type Env } from '../env';
import { fakeTwelve, seedDemoMinigames } from '../mock';
import { Acciones } from './acciones';
import { Jugadores, reply, type Reply, type Who } from './juego';
import { Minijuegos, type GamesView } from './minijuegos';
import type { GamesInput } from './series';

export class JuegoDO extends DurableObject<Env> {
  private readonly players = new Jugadores(this.ctx.storage);
  /** Liga de acciones: con la clave de cada uno (cifrada con LOGIN_LINK_SECRET) o, en local, con precios inventados. */
  private readonly stocks = (mock: boolean) => {
    const env = trimSecrets(this.env);
    return new Acciones(
      this.ctx.storage,
      mock
        ? { secret: 'rueda-local-solo-para-pruebas-0123456789', appKey: 'demo0rueda0local0', fetch: fakeTwelve }
        : { secret: env.LOGIN_LINK_SECRET ?? '', appKey: env.TWELVE_DATA_API_KEY },
    );
  };
  private readonly minis = new Minijuegos(this.ctx.storage, this.players, this.stocks);

  games(who: Who, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.view(who, new Date(at), input));
  }

  pick(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.pick(who, body, new Date(at), input));
  }

  answer(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.answer(who, body, new Date(at), input));
  }

  league(who: Who, body: unknown, at: string, input: GamesInput): Promise<Reply<GamesView>> {
    return reply(() => this.minis.league(who, body, new Date(at), input));
  }

  /** Lo llama la tarea programada cada 10 minutos: después de cada cierre, valoriza las carteras de la liga. */
  stockTick(at: string, mock = false): Promise<void> {
    return this.minis.tick(new Date(at), mock);
  }

  /** Solo en desarrollo local: números, respuestas y carteras de ejemplo si los juegos están vacíos. */
  seedDemoGames(at: string, input: GamesInput): Promise<void> {
    return seedDemoMinigames(this.ctx.storage, this.minis, new Date(at), input);
  }
}
