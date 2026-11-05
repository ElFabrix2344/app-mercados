import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { shapeEvent, slugFromUrl } from '../src/lib/polymarket';
import { pinEvent, polymarket, unpinEvent } from '../src/services/polymarket';
import { memoryKV } from './helpers';

/** Un mercado como los de Gamma (los precios y las opciones vienen como texto con JSON). */
const mk = (title: string, yes: number, o: Record<string, unknown> = {}) => ({
  question: title,
  groupItemTitle: title,
  slug: title.toLowerCase().replace(/\W+/g, '-'),
  outcomes: '["Yes", "No"]',
  outcomePrices: JSON.stringify([String(yes), String(1 - yes)]),
  oneDayPriceChange: 0.02,
  active: true,
  closed: false,
  ...o,
});
const ev = (slug: string, o: Record<string, unknown> = {}) => ({ slug, title: `Evento ${slug}`, endDate: '2027-01-01T00:00:00Z', volume: '1000', volume1wk: 500, negRisk: false, markets: [mk('Yes', 0.3)], ...o });

describe('Polymarket', () => {
  it('sí o no: la probabilidad de «sí» y su cambio de 24 horas; el widget con el mercado', () => {
    const e = shapeEvent(ev('iran', { markets: [mk('Will it happen?', 0.87, { oneDayPriceChange: -0.01, slug: 'will-it-happen' })] }))!;
    expect(e).toMatchObject({ kind: 'si-no', total: 1, outcomes: [{ label: 'Sí', p: 0.87, d1: -0.01 }], embed: { market: 'will-it-happen' } });
  });

  it('varias opciones que se excluyen: las 4 más probables; sin las cerradas', () => {
    const markets = [mk('A', 0.05), mk('B', 0.6), mk('C', 0.2), mk('D', 0.1), mk('E', 0.04), mk('F', 0.5, { closed: true })];
    const e = shapeEvent(ev('quien-gana', { negRisk: true, markets }))!;
    expect(e.kind).toBe('varias');
    expect(e.outcomes.map((o) => o.label)).toEqual(['B', 'C', 'D', 'A']);
    expect(e.total).toBe(5);
    expect(e.embed).toEqual({ event: 'quien-gana' });
  });

  it('escalera: las 4 más cerca del 50 %, en su orden de umbral', () => {
    const markets = [800, 790, 780, 770, 760, 750].map((v, i) => mk(`↑ ${v}`, [0.03, 0.15, 0.33, 0.57, 0.8, 0.95][i]!, { groupItemThreshold: String(i) }));
    const e = shapeEvent(ev('spy', { markets }))!;
    expect(e.kind).toBe('escalera');
    expect(e.outcomes.map((o) => o.label)).toEqual(['↑ 790', '↑ 780', '↑ 770', '↑ 760']);
  });

  it('sin opciones abiertas no hay evento; el enlace se lee con o sin la dirección completa', () => {
    expect(shapeEvent(ev('x', { markets: [mk('A', 0.5, { closed: true })] }))).toBeNull();
    // Las preguntas cuyo plazo ya pasó (esperan resolución) no cuentan.
    const now = Date.parse('2026-11-04T15:00:00Z');
    const dates = shapeEvent(ev('tregua', { markets: [mk('October 31', 0.99, { endDate: '2026-10-31T23:59:00Z' }), mk('December 31', 0.6, { endDate: '2026-12-31T23:59:00Z' })] }), now)!;
    expect(dates.outcomes.map((o) => o.label)).toEqual(['Sí']);
    expect(dates.total).toBe(1);
    expect(shapeEvent(ev('vencido', { markets: [mk('October 31', 0.99, { endDate: '2026-10-31T23:59:00Z' })] }), now)).toBeNull();
    expect(shapeEvent({})).toBeNull();
    expect(slugFromUrl('https://polymarket.com/event/fed-decision-in-december?tid=123')).toBe('fed-decision-in-december');
    expect(slugFromUrl('polymarket.com/es/event/Largest-Company-End-Of-December-2026/nvidia')).toBe('largest-company-end-of-december-2026');
    expect(slugFromUrl('fed-decision-in-december')).toBe('fed-decision-in-december');
    expect(slugFromUrl('https://kalshi.com/markets/fed')).toBeNull();
  });

  describe('lo que se muestra y los fijados', () => {
    const now = new Date('2026-11-04T15:00:00Z');
    /** Gamma de mentira: eventos por etiqueta y por slug; anota cada pedido. */
    function gamma(byTag: Record<string, unknown[]>, bySlug: Record<string, unknown> = {}) {
      const calls: string[] = [];
      const f = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        if (url.pathname.startsWith('/events/slug/')) {
          const s = decodeURIComponent(url.pathname.slice('/events/slug/'.length));
          return bySlug[s] ? Response.json(bySlug[s]) : new Response('not found', { status: 404 });
        }
        return Response.json(byTag[url.searchParams.get('tag_slug') ?? ''] ?? []);
      }) as typeof fetch;
      return { f, calls };
    }

    it('cada tema con los de más dinero en la semana, sin repetir, sin los vencidos y guardado 30 minutos', async () => {
      const { kv } = memoryKV();
      const { f, calls } = gamma({
        business: [ev('ipo', { volume1wk: 900 }), ev('rates', { volume1wk: 1200 }), ev('vencido', { volume1wk: 5000, endDate: '2026-11-01T00:00:00Z' })],
        stocks: [ev('ipo', { volume1wk: 900 }), ev('spy', { volume1wk: 100 })],
        geopolitics: [ev('iran', { volume1wk: 7000 })],
        politics: [ev('rates', { volume1wk: 1200 }), ev('francia', { volume1wk: 6000 })],
        world: [],
      });
      const r = await polymarket({ kv, now, fetch: f });
      expect(r.data.topics.map((t) => [t.id, t.events.map((e) => e.slug)])).toEqual([
        ['bolsa', ['rates', 'ipo', 'spy']],
        ['mundo', ['iran', 'francia']],
      ]);
      const n = calls.length;
      await polymarket({ kv, now: new Date(now.getTime() + 10 * 60_000), fetch: f });
      expect(calls.length).toBe(n);
    });

    it('el dueño fija eventos con su enlace (si existen), y al quitarlos se arma de nuevo', async () => {
      const { kv } = memoryKV();
      const { f } = gamma({}, { 'fed-decision-in-december': ev('fed-decision-in-december', { negRisk: true, markets: [mk('No change', 0.7), mk('25 bps decrease', 0.3)] }) });
      const d = { kv, now, fetch: f };
      await expect(pinEvent(d, { url: 'https://kalshi.com/x' })).rejects.toThrow(/enlace/);
      await expect(pinEvent(d, { url: 'https://polymarket.com/event/no-existe' })).rejects.toThrow(/No encontré/);
      const r = await pinEvent(d, { url: 'https://polymarket.com/event/fed-decision-in-december' });
      expect(r.data.pinned.map((e) => e.slug)).toEqual(['fed-decision-in-december']);
      expect(r.data.pinned[0]!.outcomes.map((o) => o.label)).toEqual(['No change', '25 bps decrease']);
      await expect(pinEvent(d, { url: 'fed-decision-in-december' })).rejects.toThrow(/ya está fijado/);
      expect((await unpinEvent(d, { slug: 'fed-decision-in-december' })).data.pinned).toEqual([]);
      await expect(unpinEvent(d, { slug: 'otro' })).rejects.toThrow(/no está fijado/);
    });
  });

  it('la ruta es pública; fijar es solo del dueño; el widget está permitido en la política de seguridad', async () => {
    const env = (role?: string) => ({ CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: role }) as unknown as Env;
    const call = (e: Env, method: string, path: string, body?: unknown) =>
      worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e, {} as ExecutionContext);
    const friend = env('friend');
    const res = await call(friend, 'GET', '/api/polymarket');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain('frame-src https://embed.polymarket.com');
    const data = (await res.json()) as any;
    expect(data.data.topics.map((t: { id: string }) => t.id)).toEqual(['bolsa', 'mundo']);
    expect((await call(friend, 'POST', '/api/polymarket/pins', { url: 'https://polymarket.com/event/abc-def' })).status).toBe(403);
    const owner = env();
    const pinned = (await (await call(owner, 'POST', '/api/polymarket/pins', { url: 'https://polymarket.com/event/abc-def' })).json()) as any;
    expect(pinned.data.pinned.map((e: { slug: string }) => e.slug)).toEqual(['abc-def']);
  });
});
