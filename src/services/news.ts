// Noticias: titulares de RSS públicos (gratis y sin claves). Se muestran titular, medio, hora y enlace; nunca
// la nota completa (Bloomberg y WSJ tienen muro de pago). Las generales se guardan en un solo registro de KV
// cada 30 minutos (~48 escrituras al día); las de cada acción se piden al abrir su ficha y no se guardan.

import { ApiError } from '../lib/http';
import { fetchRss, type RssItem } from '../lib/rss';
import { cached, type Deps, type Fresh, type QuotesData, type Stored } from './market';

/** Nombre de la empresa según los precios guardados (para buscarla en Google News). */
export async function quoteName(kv: KVNamespace, symbol: string): Promise<string | null> {
  const q = await kv.get<Stored<QuotesData>>('quotes', 'json');
  return q?.data.quotes.find((x) => x.symbol === symbol)?.name ?? null;
}

export type NewsGroup = 'latam' | 'eeuu' | 'global';

export const NEWS_GROUPS: Record<NewsGroup, string> = { latam: 'Perú y Latinoamérica', eeuu: 'EE. UU.', global: 'Global' };

interface Feed {
  id: string;
  name: string;
  group: NewsGroup;
  url: string;
}

/** Fuentes probadas el 22 oct 2026 (ver ROADMAP.md). Gestión y Bloomberg Línea, solo sus secciones económicas. */
export const NEWS_FEEDS: Feed[] = [
  { id: 'gestion', name: 'Gestión', group: 'latam', url: 'https://gestion.pe/arc/outboundfeeds/rss/category/economia/?outputType=xml' },
  { id: 'blinea', name: 'Bloomberg Línea', group: 'latam', url: 'https://www.bloomberglinea.com/arc/outboundfeeds/rss/category/mercados/?outputType=xml' },
  { id: 'wsj', name: 'WSJ', group: 'eeuu', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
  { id: 'marketwatch', name: 'MarketWatch', group: 'eeuu', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { id: 'cnbc', name: 'CNBC', group: 'eeuu', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'bloomberg', name: 'Bloomberg', group: 'global', url: 'https://feeds.bloomberg.com/markets/news.rss' },
];

export const NEWS_TTL_MS = 30 * 60_000;
const PER_FEED = 12;

export interface NewsItem {
  title: string;
  url: string;
  /** Medio que publicó la nota. */
  source: string;
  group: NewsGroup | null;
  publishedAt: string | null;
  summary: string | null;
}

export interface NewsData {
  items: NewsItem[];
  /** Fuentes que fallaron en la última lectura (las demás se muestran igual). */
  errors: Record<string, string>;
}

const newest = (a: NewsItem, b: NewsItem) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');

/** Sin repetidos (mismo enlace o mismo titular) y de la más nueva a la más vieja. */
export function mergeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items
    .filter((it) => {
      const key = it.title.toLowerCase();
      if (seen.has(it.url) || seen.has(key)) return false;
      seen.add(it.url);
      seen.add(key);
      return true;
    })
    .sort(newest);
}

const fromRss = (r: RssItem, source: string, group: NewsGroup | null): NewsItem => ({
  title: r.title,
  url: r.url,
  source: r.source ?? source,
  group,
  publishedAt: r.publishedAt,
  summary: r.summary,
});

/** Noticias generales del mercado: todas las fuentes, guardadas 30 minutos. Datos públicos: también para los amigos. */
export async function marketNews(d: Deps): Promise<Fresh<NewsData>> {
  return cached<NewsData>(d, 'news', NEWS_TTL_MS, async () => {
    const results = await Promise.allSettled(NEWS_FEEDS.map((feed) => fetchRss(feed.url, PER_FEED, d.fetch)));
    const items: NewsItem[] = [];
    const errors: Record<string, string> = {};
    results.forEach((r, i) => {
      const feed = NEWS_FEEDS[i]!;
      if (r.status === 'fulfilled') items.push(...r.value.map((it) => fromRss(it, feed.name, feed.group)));
      else errors[feed.name] = r.reason instanceof Error ? r.reason.message : 'no respondió';
    });
    if (!items.length) throw new ApiError('upstream_error', 502, 'No respondió ninguna fuente de noticias.');
    return { items: mergeNews(items), errors };
  });
}

// ---------- por acción ----------

const CRYPTO_NAMES: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano' };

/** Qué buscar en Google News: el nombre de la empresa sin «Ltd.», «Inc.», etc.; para cripto, el nombre de la moneda. */
export function newsQuery(symbol: string, name: string | null): string {
  if (symbol.includes('/')) {
    const base = symbol.split('/')[0]!;
    return CRYPTO_NAMES[base] ?? base;
  }
  const clean = (name ?? '')
    .replace(/[.,]/g, ' ')
    .replace(/\b(ltd|limited|inc|corp|corporation|co|plc|s ?a ?a|s ?a|holdings?|group|the|class [a-z])\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || symbol;
}

/** Símbolo como lo entiende Yahoo Finance (BTC/USD → BTC-USD). Las divisas no tienen noticias por acción. */
export const yahooSymbol = (symbol: string) => (symbol.includes('/') ? symbol.replace('/', '-') : symbol);

/**
 * Titulares de una acción: Yahoo Finance (en inglés, por símbolo) y Google News (en español, por nombre). Se
 * piden al momento, sin guardar nada en KV.
 */
export async function symbolNews(d: Deps, symbol: string, name: string | null, max = 8): Promise<NewsItem[]> {
  const q = newsQuery(symbol, name);
  const feeds: { url: string; source: string }[] = [
    { url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSymbol(symbol))}&region=US&lang=en-US`, source: 'Yahoo Finance' },
    { url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es-419&gl=PE&ceid=PE:es-419`, source: 'Google News' },
  ];
  const results = await Promise.allSettled(feeds.map((f) => fetchRss(f.url, max, d.fetch)));
  const items: NewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const it of r.value) {
      // Google News pone « - Medio» al final del titular: el medio ya va aparte.
      const title = it.source && it.title.endsWith(` - ${it.source}`) ? it.title.slice(0, -(it.source.length + 3)) : it.title;
      items.push(fromRss({ ...it, title }, feeds[i]!.source, null));
    }
  });
  if (!items.length && results.every((r) => r.status === 'rejected')) {
    throw new ApiError('upstream_error', 502, 'No respondieron las fuentes de noticias.');
  }
  return mergeNews(items).slice(0, max);
}
