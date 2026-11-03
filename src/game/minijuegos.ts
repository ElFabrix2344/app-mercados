// Los otros juegos de la hoja «Juego», que no son de pronosticar: «2/3 del promedio» (semanal), «Gráfico del día»
// (diario) y «Liga de carteras» (mensual). Viven en el mismo Durable Object que el mercado de predicciones y usan los
// mismos jugadores y nombres. Cada pedido pone al día los tres y responde lo que ve quien pide.

import { ApiError } from '../lib/http';
import { isoDate } from '../lib/num';
import { DosTercios, type K23View } from './dos-tercios';
import { Grafico, type ChartView } from './grafico';
import type { GameStorage, Juego, Who } from './juego';
import { Liga, type LeagueView } from './liga';
import type { GamesInput } from './series';

export interface GamesView {
  /** null si todavía no eligió su nombre (sin nombre se ve, pero no se juega). */
  alias: string | null;
  dosTercios: K23View;
  grafico: ChartView;
  liga: LeagueView;
}

export class Minijuegos {
  private readonly k23: DosTercios;
  private readonly chart: Grafico;
  private readonly league: Liga;

  constructor(
    store: GameStorage,
    private readonly juego: Juego,
  ) {
    this.k23 = new DosTercios(store);
    this.chart = new Grafico(store);
    this.league = new Liga(store);
  }

  /** Para jugar hace falta el nombre (el mismo de los pronósticos y el mercado). */
  private async player(who: Who, now: Date): Promise<void> {
    if (!(await this.juego.join(who, now))) throw new ApiError('bad_request', 400, 'Para jugar, elige tu nombre arriba.');
  }

  async view(who: Who, now: Date, input: GamesInput): Promise<GamesView> {
    await this.k23.settle(now);
    await this.league.settle(now, input.prices);
    await this.juego.join(who, now);
    const aliases = await this.juego.aliases();
    const today = isoDate(now, 'America/Lima');
    return {
      alias: who.alias,
      dosTercios: await this.k23.view(who.pid, now, aliases),
      grafico: await this.chart.view(who.pid, today, input.catalog, aliases),
      liga: await this.league.view(who.pid, now, input.prices, aliases),
    };
  }

  async pick(who: Who, body: unknown, now: Date, input: GamesInput): Promise<GamesView> {
    await this.player(who, now);
    await this.k23.settle(now);
    await this.k23.pick(who.pid, body, now);
    return this.view(who, now, input);
  }

  async answer(who: Who, body: unknown, now: Date, input: GamesInput): Promise<GamesView> {
    await this.player(who, now);
    await this.chart.answer(who.pid, body, isoDate(now, 'America/Lima'), now, input.catalog);
    return this.view(who, now, input);
  }

  /** Liga de carteras: comprar, vender o cancelar una orden que todavía no se cumplió. */
  async order(who: Who, body: unknown, now: Date, input: GamesInput): Promise<GamesView> {
    await this.player(who, now);
    await this.league.settle(now, input.prices);
    await this.league.order(who.pid, body, now);
    return this.view(who, now, input);
  }
}
