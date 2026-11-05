import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { getCoinDaily, getCoinMarkets } from '../src/lib/coingecko';
import { crypto } from '../src/services/crypto';
import { memoryKV } from './helpers';

const DAY = 86_400_000;

/** CoinGecko de mentira: /coins/markets y /coins/{id}/market_chart, con la clave que se usó en cada pedido. */
function gecko(now: Date) {
  const calls: { path: string; key: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, key: (init?.headers as Record<string, string>)['x-cg-demo-api-key'] ?? null });
    if (url.pathname.endsWith('/coins/markets')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return Response.json(ids.map((id, i) => ({ id, symbol: id.slice(0, 3), name: id, current_price: 100 * (i + 1), price_change_percentage_24h: -1.5, market_cap: 1e9, market_cap_rank: i + 1, last_updated: now.toISOString() })));
    }
    // Un punto por día durante 365 días, y el último «ahora» (el mismo día que el anterior).
    const prices = Array.from({ length: 366 }, (_, i) => [now.getTime() - (365 - i) * DAY, 50 + i]);
    prices.push([now.getTime() - 60_000, 999]);
    return Response.json({ prices });
  }) as typeof fetch;
  return { f, calls };
}

describe('cripto (CoinGecko)', () => {
  const now = new Date('2026-11-04T15:00:00Z');

  it('la clave va en el encabezado y la variación de 24 horas como fracción', async () => {
    const { f, calls } = gecko(now);
    const q = await getCoinMarkets(['bitcoin'], 'CG-prueba0123456789', f);
    expect(q[0]).toMatchObject({ id: 'bitcoin', price: 100, change24h: -0.015, rank: 1 });
    expect(calls[0]).toEqual({ path: '/api/v3/coins/markets', key: 'CG-prueba0123456789' });
  });

  it('la serie diaria queda con un punto por día', async () => {
    const { f } = gecko(now);
    const pts = await getCoinDaily('bitcoin', 365, 'k', f);
    expect(new Set(pts.map(([d]) => d)).size).toBe(pts.length);
    expect(pts.at(-1)).toEqual(['2026-11-04', 999]);
  });

  it('sin clave la sección queda apagada; con clave se guarda una hora en KV (5 consultas)', async () => {
    const { kv } = memoryKV();
    expect(await crypto({ kv, now })).toEqual({ enabled: false });
    const { f, calls } = gecko(now);
    const r = await crypto({ kv, now, fetch: f, coingeckoKey: 'CG-prueba0123456789' });
    if (!r.enabled) throw new Error('debía estar prendida');
    expect(Object.keys(r.data.coins)).toEqual(['bitcoin', 'ethereum', 'solana', 'ripple']);
    const btc = r.data.coins.bitcoin!;
    // El último punto es el precio de /coins/markets (el mismo momento que la variación de 24 horas).
    expect(btc.points.at(-1)).toEqual(['2026-11-04', 100]);
    expect(btc.summary.last).toEqual({ date: '2026-11-04', value: 100 });
    expect(btc.summary.m1).not.toBeNull();
    expect(btc.change24h).toBe(-0.015);
    expect(calls).toHaveLength(5);
    await crypto({ kv, now: new Date(now.getTime() + 30 * 60_000), fetch: f, coingeckoKey: 'CG-prueba0123456789' });
    expect(calls).toHaveLength(5); // dentro de la hora, de lo guardado
  });

  it('la ruta es pública: también para los amigos', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const r = (await (await worker.fetch(new Request('http://localhost/api/crypto'), env, {} as ExecutionContext)).json()) as any;
    expect(r.enabled).toBe(true);
    expect(r.data.coins.bitcoin.points.length).toBeGreaterThan(300);
  });
});
