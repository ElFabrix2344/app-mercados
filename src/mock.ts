// Datos ficticios para desarrollo local (MOCK_DATA=true y DEV_MODE=true en localhost).
// Son caminatas aleatorias con semilla fija: sirven para ver el diseño, no son precios reales.

import { usMarketOpen } from './lib/market-hours';
import { addDays, isoDate } from './lib/num';
import type { DailyPoint, Quote } from './lib/twelvedata';
import type { NewsData, NewsGroup, NewsItem } from './services/news';
import type { PriceSource } from './services/portfolio';
import {
  DEFAULT_RANGE,
  shapeCompare,
  shapeHistory,
  summarize,
  type CompareResult,
  type Fresh,
  type HistoryResult,
  type MarketSeries,
  type PeruData,
  type PeruMarkets,
  type QuotesData,
  type Range,
  type UsaData,
} from './services/market';

// beta: cuánto sigue cada símbolo a un «mercado» común, para que las correlaciones de prueba sean creíbles.
const BASE: Record<string, { name: string; exchange: string; currency: string; start: number; vol: number; beta: number; crypto?: boolean }> = {
  BAP: { name: 'Credicorp Ltd.', exchange: 'NYSE', currency: 'USD', start: 250, vol: 0.018, beta: 0.6 },
  SCCO: { name: 'Southern Copper Corp.', exchange: 'NYSE', currency: 'USD', start: 100, vol: 0.022, beta: 0.65 },
  BVN: { name: 'Buenaventura', exchange: 'NYSE', currency: 'USD', start: 15, vol: 0.028, beta: 0.45 },
  SPY: { name: 'SPDR S&P 500 ETF', exchange: 'NYSE', currency: 'USD', start: 560, vol: 0.01, beta: 0.95 },
  'USD/PEN': { name: 'Dólar / Sol', exchange: 'Forex', currency: 'PEN', start: 3.7, vol: 0.003, beta: -0.35 },
  'BTC/USD': { name: 'Bitcoin / Dólar', exchange: 'Binance', currency: 'USD', start: 65000, vol: 0.03, beta: 0.35, crypto: true },
  // Series del BCRP (cobre en US$/lb, oro en US$/oz, reservas en millones de US$, índice BVL).
  'BCRP:COBRE': { name: 'Cobre', exchange: 'BCRP', currency: 'USD', start: 4.4, vol: 0.014, beta: 0.4 },
  'BCRP:ORO': { name: 'Oro', exchange: 'BCRP', currency: 'USD', start: 2900, vol: 0.009, beta: -0.1 },
  'BCRP:RIN': { name: 'Reservas', exchange: 'BCRP', currency: 'USD', start: 80000, vol: 0.002, beta: 0.1 },
  'BCRP:BVL': { name: 'BVL', exchange: 'BCRP', currency: 'PEN', start: 30000, vol: 0.011, beta: 0.5 },
};

function seedOf(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function info(symbol: string) {
  return BASE[symbol] ?? { name: symbol, exchange: 'NYSE', currency: 'USD', start: 50, vol: 0.02, beta: 0.5 };
}

/** Ruido con media 0 y desviación ~1. */
const noise = (rand: () => number) => (rand() + rand() + rand() - 1.5) * 2;

function walk(symbol: string, now: Date): DailyPoint[] {
  const meta = info(symbol);
  const rand = rng(seedOf(symbol));
  const idio = Math.sqrt(1 - meta.beta ** 2);
  const today = isoDate(now);
  const pts: DailyPoint[] = [];
  let price = meta.start;
  // 5 años, como el historial real.
  for (let d = addDays(today, -1840); d < today; d = addDays(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (!meta.crypto && (dow === 0 || dow === 6)) continue;
    const market = noise(rng(seedOf(`mercado${d}`)));
    const shock = (meta.beta * market + idio * noise(rand)) * meta.vol + meta.vol * 0.06;
    price = Math.max(price * (1 + shock), meta.start * 0.2);
    pts.push({ date: d, close: Number(price.toPrecision(6)) });
  }
  return pts;
}

const mockPoints = (symbol: string, now: Date) => walk(symbol, now).map((p) => [p.date, p.close] as [string, number]);

function fresh<T>(data: T, now: Date): Fresh<T> {
  return { data, fetchedAt: now.toISOString(), stale: false, note: 'Datos de prueba' };
}

export function mockQuotes(symbols: string[], now: Date): Fresh<QuotesData> & { market: { open: boolean } } {
  const quotes: Quote[] = symbols.map((symbol) => {
    const pts = walk(symbol, now);
    const meta = info(symbol);
    const prev = pts.at(-1)!.close;
    const price = Number((prev * (1 + (rng(seedOf(symbol + isoDate(now)))() - 0.5) * meta.vol * 2)).toPrecision(6));
    const closes = pts.slice(-252).map((p) => p.close);
    return {
      symbol,
      name: meta.name,
      exchange: meta.exchange,
      currency: meta.currency,
      price,
      prevClose: prev,
      change: price - prev,
      changePct: (price / prev - 1) * 100,
      asOf: new Date(now.getTime() - 60_000).toISOString(),
      isMarketOpen: true,
      low52: Math.min(...closes),
      high52: Math.max(...closes),
    };
  });
  const fetched = Object.fromEntries(symbols.map((s) => [s, now.toISOString()]));
  return { ...fresh({ quotes, errors: {}, symbols, fetched }, now), market: { open: usMarketOpen(now) } };
}

export function mockHistory(symbol: string, now: Date, range: Range = DEFAULT_RANGE): HistoryResult {
  return shapeHistory(fresh({ symbol, points: mockPoints(symbol, now) }, now), range, isoDate(now));
}

export function mockCompare(symbols: string[], now: Date, range: Range = DEFAULT_RANGE): CompareResult {
  const data = shapeCompare(
    symbols.map((symbol) => ({ symbol, points: mockPoints(symbol, now) })),
    range,
    isoDate(now),
  );
  return { ...data, fetchedAt: now.toISOString(), stale: false, notes: ['Datos de prueba'], errors: {} };
}

export function mockPeru(now: Date): Fresh<PeruData> {
  const fx = walk('USD/PEN', now)
    .slice(-30)
    .map((p) => ({ date: p.date, buy: p.close, sell: Number((p.close + 0.002).toFixed(4)) }));
  const today = isoDate(now);
  const inflation = Array.from({ length: 13 }, (_, i) => ({
    date: `${addDays(today, -31 * (13 - i)).slice(0, 7)}-01`,
    value: Number((2 + Math.sin(i / 2)).toFixed(2)),
  }));
  return fresh({ fx, policyRate: { date: addDays(today, -1), value: 4.5 }, inflation }, now);
}

/** Titulares de prueba (no son noticias reales; los enlaces van a example.com). */
export function mockNews(now: Date): Fresh<NewsData> {
  const groups: [NewsGroup, string][] = [['latam', 'Gestión'], ['eeuu', 'WSJ'], ['global', 'Bloomberg'], ['latam', 'Bloomberg Línea'], ['eeuu', 'CNBC']];
  const items: NewsItem[] = Array.from({ length: 14 }, (_, i) => {
    const [group, source] = groups[i % groups.length]!;
    return {
      title: `Titular de prueba ${i + 1}: así se movieron los mercados en la sesión de hoy`,
      url: `https://example.com/noticia-${i + 1}`,
      source,
      group,
      publishedAt: new Date(now.getTime() - (i * 47 + 5) * 60_000).toISOString(),
      summary: 'Resumen de prueba de la noticia.',
    };
  });
  return fresh({ items, errors: {} }, now);
}

export function mockSymbolNews(symbol: string, now: Date): NewsItem[] {
  return Array.from({ length: 4 }, (_, i) => ({
    title: `${info(symbol).name}: titular de prueba ${i + 1}`,
    url: `https://example.com/${encodeURIComponent(symbol)}-${i + 1}`,
    source: i % 2 ? 'Google News' : 'Yahoo Finance',
    group: null,
    publishedAt: new Date(now.getTime() - (i * 190 + 30) * 60_000).toISOString(),
    summary: null,
  }));
}

/** Precios de prueba para la cartera simulada (sin KV ni APIs). */
export function mockPriceSource(symbols: string[], now: Date): PriceSource {
  const q = mockQuotes(symbols, now).data;
  return {
    quotes: async () => q,
    closes: async (symbol) => mockPoints(symbol, now),
    usdPen: async (quotes) => {
      const live = quotes?.quotes.find((x) => x.symbol === 'USD/PEN')?.price;
      return { rate: live ?? 3.7, source: live ? 'USD/PEN de tu lista' : 'tipo de cambio de prueba' };
    },
  };
}

export function mockPeruMarkets(now: Date): Fresh<PeruMarkets> {
  const series = (symbol: string): MarketSeries => {
    const points = mockPoints(symbol, now).slice(-280);
    return { points, summary: summarize(points) };
  };
  return fresh({ copper: series('BCRP:COBRE'), gold: series('BCRP:ORO'), reserves: series('BCRP:RIN'), bvl: series('BCRP:BVL') }, now);
}

export function mockUsa(now: Date): Fresh<UsaData> {
  const today = isoDate(now);
  const treasury10y = walk('UST10', now)
    .slice(-60)
    .map((p) => ({ date: p.date, value: Number((3.5 + (p.close - 50) / 40).toFixed(2)) }));
  const cpiYoY = Array.from({ length: 13 }, (_, i) => ({
    date: `${addDays(today, -31 * (14 - i)).slice(0, 7)}-01`,
    value: Number((2.5 + Math.cos(i / 3) * 0.5).toFixed(2)),
  }));
  return fresh({ treasury10y, fedFunds: { date: addDays(today, -1), value: 4 }, cpiYoY }, now);
}
