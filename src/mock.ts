// Datos ficticios para desarrollo local (MOCK_DATA=true y DEV_MODE=true en localhost).
// Son caminatas aleatorias con semilla fija: sirven para ver el diseño, no son precios reales.

import type { EarningsRelease } from './lib/finnhub';
import { usMarketOpen } from './lib/market-hours';
import { addDays, isoDate } from './lib/num';
import type { DailyPoint, Quote } from './lib/twelvedata';
import type { CompanyResult } from './services/company';
import { getEodList, shapeEod, summarizeHistory, type EodRow, type EodView } from './services/eod';
import { EARNINGS_AHEAD_DAYS, shapeCompanies, type CompanyCalendar } from './services/earnings';
import type { NewsData, NewsGroup, NewsItem } from './services/news';
import type { PriceSource } from './services/portfolio';
import {
  DEFAULT_RANGE,
  getWatchlist,
  shapeCompare,
  shapeHistory,
  summarize,
  type Bar,
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
  // Tasas (%): bono peruano a 10 años en soles y en dólares, y Tesoro de EE. UU. a 10 años.
  'BCRP:BONO10PEN': { name: 'Bono 10 años S/', exchange: 'BCRP', currency: 'PEN', start: 6.6, vol: 0.004, beta: 0.2 },
  'BCRP:BONO10USD': { name: 'Bono 10 años US$', exchange: 'BCRP', currency: 'USD', start: 6.0, vol: 0.004, beta: 0.2 },
  'BCRP:UST10': { name: 'Tesoro 10 años', exchange: 'BCRP', currency: 'USD', start: 4.8, vol: 0.004, beta: 0.1 },
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

/** Volumen diario típico de prueba; las divisas y las series del BCRP no tienen. */
const MOCK_VOLUME: Record<string, number> = { BAP: 300_000, SCCO: 1_200_000, BVN: 900_000, SPY: 60_000_000, 'BTC/USD': 25_000 };

function walk(symbol: string, now: Date): DailyPoint[] {
  const meta = info(symbol);
  const rand = rng(seedOf(symbol));
  // Apertura, máximo, mínimo y volumen salen de otra semilla: los cierres no cambian.
  const extra = rng(seedOf(`${symbol}:velas`));
  const traded = meta.exchange !== 'Forex' && meta.exchange !== 'BCRP';
  const baseVolume = MOCK_VOLUME[symbol] ?? 1_000_000;
  const idio = Math.sqrt(1 - meta.beta ** 2);
  const today = isoDate(now);
  const pts: DailyPoint[] = [];
  let price = meta.start;
  let prevClose = meta.start;
  // 5 años, como el historial real.
  for (let d = addDays(today, -1840); d < today; d = addDays(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (!meta.crypto && (dow === 0 || dow === 6)) continue;
    const market = noise(rng(seedOf(`mercado${d}`)));
    const shock = (meta.beta * market + idio * noise(rand)) * meta.vol + meta.vol * 0.06;
    price = Math.max(price * (1 + shock), meta.start * 0.2);
    const close = Number(price.toPrecision(6));
    const open = Number((prevClose * (1 + noise(extra) * meta.vol * 0.3)).toPrecision(6));
    const wick = () => Math.abs(noise(extra)) * meta.vol * 0.4;
    const high = Number((Math.max(open, close) * (1 + wick())).toPrecision(6));
    const low = Number((Math.min(open, close) * (1 - wick())).toPrecision(6));
    // Más volumen los días de movimientos grandes.
    const volume = traded ? Math.round(baseVolume * (1 + Math.abs(shock) * 25) * (0.6 + extra() * 0.8)) : null;
    pts.push({ date: d, close, open, high, low, volume });
    prevClose = close;
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
  const pts = walk(symbol, now);
  const points = pts.map((p) => [p.date, p.close] as [string, number]);
  const bars = pts.map((p): Bar => [p.open ?? null, p.high ?? null, p.low ?? null, p.volume ?? null]);
  return shapeHistory(fresh({ symbol, points, bars }, now), range, isoDate(now));
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
  const usd = new Map(mockPoints('BCRP:BONO10USD', now));
  const spread = mockPoints('BCRP:UST10', now)
    .slice(-280)
    .filter(([d]) => usd.has(d))
    .map(([d, ust]) => [d, Math.round((usd.get(d)! - ust) * 1000) / 10] as [string, number]);
  return fresh(
    {
      copper: series('BCRP:COBRE'),
      gold: series('BCRP:ORO'),
      reserves: series('BCRP:RIN'),
      bvl: series('BCRP:BVL'),
      bond10pen: series('BCRP:BONO10PEN'),
      bond10usd: series('BCRP:BONO10USD'),
      spread10: { points: spread, summary: summarize(spread) },
    },
    now,
  );
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

/** ETF conocidos: no presentan resultados (en la API real simplemente no traen fechas). */
const MOCK_ETFS = new Set(['SPY', 'VOO', 'IVV', 'VTI', 'QQQ', 'IWM', 'EEM', 'EPU', 'GLD']);

/** Resultados de prueba (no son fechas reales): el primero ya presentó hace unos días; el segundo presenta en 2 días; los demás, después. */
export function mockCompanyCalendar(list: string[], now: Date, today: string): CompanyCalendar {
  const symbols = list.filter((s) => !s.includes('/') && !MOCK_ETFS.has(s));
  // Trimestre ya cerrado: en octubre se presenta el 3T; en enero, el 4T del año anterior.
  const y = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const period = { year: q === 0 ? y - 1 : y, quarter: q === 0 ? 4 : q };
  const hours = ['amc', 'bmo', 'dmh'] as const;
  const releases: EarningsRelease[] = symbols.map((symbol, i) => {
    const rand = rng(seedOf(`resultados${symbol}`));
    const eps = Number((0.5 + rand() * 4).toFixed(2));
    const revenue = Math.round((0.5 + rand() * 3) * 1e9);
    const done = i === 0;
    return {
      symbol,
      date: addDays(today, done ? -6 : 2 + (i - 1) * 9),
      hour: hours[i % hours.length]!,
      ...period,
      epsEstimate: eps,
      epsActual: done ? Number((eps * 1.08).toFixed(2)) : null,
      revenueEstimate: revenue,
      revenueActual: done ? Math.round(revenue * 1.03) : null,
    };
  });
  releases.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return shapeCompanies(fresh({ releases, errors: {}, from: addDays(today, -30), to: addDays(today, EARNINGS_AHEAD_DAYS) }, now), today);
}

/** Datos de empresa de prueba (inventados): múltiplos, analistas, sorpresas del BPA y comparables. */
export function mockCompany(symbol: string, now: Date): CompanyResult {
  if (symbol.includes('/')) return { enabled: true, applicable: false, note: 'Las divisas y las criptomonedas no tienen datos de empresa.' };
  const etf = MOCK_ETFS.has(symbol);
  const rand = rng(seedOf(`empresa${symbol}`));
  const between = (lo: number, hi: number, dec = 2) => Number((lo + rand() * (hi - lo)).toFixed(dec));
  const today = isoDate(now);
  const pts = walk(symbol, now).slice(-252).map((p) => p.close);
  const months = [0, 1, 2, 3].map((i) => `${addDays(today, -31 * i).slice(0, 7)}-01`);
  // Los últimos 4 trimestres ya cerrados, del más nuevo al más viejo.
  let year = Number(today.slice(0, 4));
  let quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const surprises = [0, 1, 2, 3].map(() => {
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
    const estimate = between(1, 5);
    const actual = Number((estimate * between(0.9, 1.15, 3)).toFixed(2));
    const period = `${year}-${String(quarter * 3).padStart(2, '0')}-${quarter === 1 || quarter === 4 ? 31 : 30}`;
    const item = { period, year, quarter, actual, estimate, surprisePct: Number(((actual / estimate - 1) * 100).toFixed(2)) };
    quarter -= 1;
    return item;
  });
  return {
    enabled: true,
    applicable: true,
    ...fresh(
      {
        symbol,
        profile: etf
          ? null
          : { name: info(symbol).name, country: symbol === 'SCCO' ? 'US' : 'PE', currency: 'USD', exchange: 'NEW YORK STOCK EXCHANGE, INC.', industry: symbol === 'BAP' ? 'Banking' : 'Metals & Mining', ipo: '1995-10-25', weburl: 'https://example.com/', marketCap: between(2000, 90000, 0), sharesOutstanding: between(70, 800, 1) },
        metrics: etf
          ? null
          : {
              pe: between(8, 30, 1),
              pb: between(1, 6, 2),
              ps: between(1, 8, 2),
              beta: between(0.6, 1.6),
              dividendYield: between(0, 6),
              eps: between(1, 25),
              netMargin: between(5, 40, 1),
              operatingMargin: between(10, 50, 1),
              roe: between(5, 30, 1),
              revenueGrowth: between(-10, 25, 1),
              epsGrowth: between(-20, 40, 1),
              high52: Math.max(...pts),
              high52Date: addDays(today, -120),
              low52: Math.min(...pts),
              low52Date: addDays(today, -260),
            },
        recommendations: etf ? [] : months.map((period) => ({ period, strongBuy: between(2, 6, 0), buy: between(3, 9, 0), hold: between(1, 6, 0), sell: between(0, 2, 0), strongSell: 0 })),
        surprises: etf ? [] : surprises,
        peers: etf ? [] : ['FCX', 'TECK', 'RIO', 'BHP'].filter((s) => s !== symbol),
        errors: {},
      },
      now,
    ),
  };
}

/** Lista diaria de prueba: los cierres salen de las mismas caminatas aleatorias. */
export async function mockEodView(kv: KVNamespace, now: Date): Promise<EodView> {
  const main = await getWatchlist(kv);
  const symbols = (await getEodList(kv)).filter((s) => !main.includes(s));
  const today = isoDate(now);
  const rows: Record<string, EodRow> = {};
  for (const symbol of symbols) {
    const name = BASE[symbol]?.name ?? null;
    const row = summarizeHistory({ symbol, points: mockPoints(symbol, now) }, name, today, now.toISOString(), today);
    if (row) rows[symbol] = row;
  }
  return shapeEod(symbols, { rows });
}