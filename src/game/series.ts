// Series públicas que usa el «Gráfico del día». Salen de lo que Rueda ya guarda del BCRP y de FRED (datos que también
// ven los amigos); nunca de Twelve Data ni de Finnhub, cuyas licencias no permiten mostrarlos a otras personas. El
// Worker las arma y se las pasa al Durable Object del juego.

import type { FredPoint } from '../lib/fred';
import type { MarketSeries, PeruData, PeruMarkets, UsaData } from '../services/market';

/** Un punto con fecha (objeto y no tupla: así viaja tal cual por RPC). */
export interface SeriesPoint {
  d: string;
  v: number;
}

export interface ChartSeries {
  id: string;
  name: string;
  points: SeriesPoint[];
}

export interface GamesInput {
  catalog: ChartSeries[];
  /** Desarrollo local con datos de prueba: la liga de acciones usa precios inventados en vez de Twelve Data. */
  mock: boolean;
}

/** Puntos que se mandan de cada serie del catálogo: suficiente para la forma del gráfico. */
const MAX_POINTS = 120;

const fromMarket = (s: MarketSeries | undefined): SeriesPoint[] => (s?.points ?? []).map(([d, v]) => ({ d, v }));
const fromFred = (s: FredPoint[] | undefined): SeriesPoint[] => (s ?? []).map((p) => ({ d: p.date, v: p.value }));
const fromDated = (s: { date: string; value: number }[] | undefined): SeriesPoint[] => (s ?? []).map((p) => ({ d: p.date, v: p.value }));

/** Hasta `max` puntos, repartidos parejo y siempre con el último. */
export function thin(points: SeriesPoint[], max = MAX_POINTS): SeriesPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/** Arma el catálogo del «Gráfico del día» con lo guardado de Perú, sus mercados y EE. UU. */
export function gamesInput(pe: PeruData | null, pm: PeruMarkets | null, us: UsaData | null, mock = false): GamesInput {
  const catalog: ChartSeries[] = [
    { id: 'dolar', name: 'Dólar interbancario', points: (pe?.fx ?? []).map((p) => ({ d: p.date, v: p.sell })) },
    { id: 'tasa', name: 'Tasa de referencia del BCRP', points: fromDated(pe?.policyRates) },
    { id: 'inflacion', name: 'Inflación de Lima a 12 meses', points: fromDated(pe?.inflation) },
    { id: 'cobre', name: 'Cobre', points: fromMarket(pm?.copper) },
    { id: 'oro', name: 'Oro', points: fromMarket(pm?.gold) },
    { id: 'bvl', name: 'Bolsa de Lima (índice general)', points: fromMarket(pm?.bvl) },
    { id: 'reservas', name: 'Reservas internacionales del BCRP', points: fromMarket(pm?.reserves) },
    { id: 'bono10', name: 'Bono peruano a 10 años en soles', points: fromMarket(pm?.bond10pen) },
    { id: 'ust10', name: 'Bono del Tesoro de EE. UU. a 10 años', points: fromFred(us?.treasury10y) },
    { id: 'cpius', name: 'Inflación de EE. UU. a 12 meses', points: fromFred(us?.cpiYoY) },
  ].map((s) => ({ ...s, points: thin(s.points) }));
  return { catalog, mock };
}
