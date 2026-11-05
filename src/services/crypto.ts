// Cripto para todos (elegida por el usuario el 4 nov entre las fuentes nuevas): bitcoin, ether, solana y XRP de
// CoinGecko (lib/coingecko.ts). Su plan Demo deja mostrar los datos citando la fuente, así que los ven también los
// amigos. Un solo registro en KV (`crypto`), renovado como mucho una vez por hora (≤ 24 escrituras al día), con
// 5 consultas cada vez: unas 3.600 al mes como mucho.

import { getCoinDaily, getCoinMarkets } from '../lib/coingecko';
import { cached, summarize, type CacheDeps, type Fresh, type MarketSeries } from './market';

export const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'ripple'] as const;
export const CRYPTO_TTL_MS = 60 * 60_000;
/** Un año de precios diarios (el plan Demo da hasta 365 días de historia). */
const DAYS = 365;

export interface CryptoSeries extends MarketSeries {
  symbol: string;
  name: string;
  /** Variación de las últimas 24 horas (fracción). */
  change24h: number | null;
  marketCap: number | null;
  updated: string | null;
}

export interface CryptoData {
  coins: Record<string, CryptoSeries>;
}

export type CryptoReply = { enabled: false } | ({ enabled: true } & Fresh<CryptoData>);

/** Sin COINGECKO_API_KEY la sección queda apagada (sin error). */
export async function crypto(d: CacheDeps & { coingeckoKey?: string }): Promise<CryptoReply> {
  const key = d.coingeckoKey;
  if (!key) return { enabled: false };
  const r = await cached<CryptoData>(d, 'crypto', CRYPTO_TTL_MS, async () => {
    const quotes = await getCoinMarkets([...CRYPTO_IDS], key, d.fetch);
    const coins: Record<string, CryptoSeries> = {};
    // De a una: son pocas y así no se juntan en el mismo segundo.
    for (const id of CRYPTO_IDS) {
      const q = quotes.find((x) => x.id === id);
      if (!q) continue;
      const pts = await getCoinDaily(id, DAYS, key, d.fetch);
      // El último punto es «ahora»: se usa el precio de /coins/markets, el mismo momento que la variación de 24 horas.
      const today = d.now.toISOString().slice(0, 10);
      const points: [string, number][] = [...pts.filter(([date]) => date < today), [today, q.price]];
      coins[id] = { points, summary: summarize(points), symbol: q.symbol, name: q.name, change24h: q.change24h, marketCap: q.marketCap, updated: q.updated };
    }
    return { coins };
  });
  return { enabled: true, ...r };
}
