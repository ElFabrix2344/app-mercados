// Los juegos de la hoja «Juego» que no son de pronosticar: «Liga de acciones» (mensual), «Gráfico del día» (diario) y
// «2/3 del promedio» (semanal). Viven en el mismo Durable Object y usan los jugadores y nombres del juego de
// pronósticos. Cada pedido pone al día lo que corresponde y responde lo que ve quien pide.

import { ApiError } from '../lib/http';
import { isoDate } from '../lib/num';
import type { Acciones, StockView } from './acciones';
import { DosTercios, type K23View } from './dos-tercios';
import { Grafico, type ChartView } from './grafico';
import type { GameStorage, Jugadores, Who } from './juego';
import type { GamesInput } from './series';

export interface GamesView {
  /** null si todavía no eligió su nombre (sin nombre se ve, pero no se juega). */
  alias: string | null;
  owner: boolean;
  dosTercios: K23View;
  grafico: ChartView;
  liga: StockView;
}

export class Minijuegos {
  private readonly k23: DosTercios;
  private readonly chart: Grafico;

  constructor(
    store: GameStorage,
    private readonly juego: Jugadores,
    /** La liga de acciones, con Twelve Data o, en desarrollo local, con precios inventados. */
    private readonly stocks: (mock: boolean) => Acciones,
  ) {
    this.k23 = new DosTercios(store);
    this.chart = new Grafico(store);
  }

  /** Para jugar hace falta el nombre (el mismo de los pronósticos). */
  private async player(who: Who, now: Date): Promise<void> {
    if (!(await this.juego.join(who, now))) throw new ApiError('bad_request', 400, 'Para jugar, elige tu nombre arriba.');
  }

  async view(who: Who, now: Date, input: GamesInput): Promise<GamesView> {
    await this.k23.settle(now);
    await this.juego.join(who, now);
    const aliases = await this.juego.aliases();
    return {
      alias: who.alias,
      owner: who.owner,
      dosTercios: await this.k23.view(who.pid, now, aliases),
      grafico: await this.chart.view(who.pid, isoDate(now, 'America/Lima'), input.catalog, aliases),
      liga: await this.stocks(input.mock).view(who.pid, now, aliases),
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

  /** Liga de acciones: conectar o quitar la clave, entrar (el dueño, con la de Rueda), comprar, vender o cancelar. */
  async league(who: Who, body: unknown, now: Date, input: GamesInput): Promise<GamesView> {
    await this.player(who, now);
    const stocks = this.stocks(input.mock);
    const action = (body as { action?: unknown } | null)?.action;
    if (action === 'conectar') await stocks.connect(who.pid, body, now);
    else if (action === 'desconectar') await stocks.disconnect(who.pid);
    else if (action === 'entrar') {
      if (!who.owner) throw new ApiError('forbidden', 403, 'Para entrar, conecta tu clave gratis de Twelve Data.');
      await stocks.joinWithAppKey(who.pid, now);
    } else await stocks.order(who.pid, body, now);
    return this.view(who, now, input);
  }

  /** Después de cada cierre de Nueva York (tarea programada): valoriza las carteras de la liga. */
  tick(now: Date, mock: boolean): Promise<void> {
    return this.stocks(mock).tick(now);
  }
}
