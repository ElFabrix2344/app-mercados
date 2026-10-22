import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { cleanText, fetchRss, parseItem } from '../src/lib/rss';
import { NEWS_FEEDS, marketNews, mergeNews, newsQuery, symbolNews, yahooSymbol } from '../src/services/news';
import { memoryKV } from './helpers';

interface Rss {
  title: string;
  link: string;
  date?: string;
  desc?: string;
  source?: string;
}

const rss = (items: Rss[]) =>
  `<?xml version="1.0"?><rss><channel><title>Canal</title><link>https://example.com</link>${items
    .map(
      (i) =>
        `<item><titles>no es el título</titles><title><![CDATA[${i.title}]]></title><link>${i.link}</link>` +
        `${i.date ? `<pubDate>${i.date}</pubDate>` : ''}${i.desc ? `<description><![CDATA[${i.desc}]]></description>` : ''}` +
        `${i.source ? `<source url="https://medio.example">${i.source}</source>` : ''}<media:title>tampoco</media:title></item>`,
    )
    .join('')}</channel></rss>`;

/** fetch falso que responde RSS según la URL (o un error si no la conoce). */
function rssFetch(byUrl: (url: string) => string | null) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = byUrl(url);
    return body === null ? new Response('caído', { status: 503 }) : new Response(body, { headers: { 'Content-Type': 'application/rss+xml' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('lector de RSS', () => {
  it('limpia CDATA, HTML y entidades, y no confunde <title> con <titles> ni <media:title>', () => {
    const it0 = parseItem(
      rss([{ title: 'Cobre &amp; oro suben', link: 'https://example.com/a', date: 'Thu, 22 Oct 2026 11:29:09 GMT', desc: '<p>El <b>cobre</b>&#160;subió</p>' }]).split('<item>')[1]!,
    )!;
    expect(it0).toEqual({ title: 'Cobre & oro suben', url: 'https://example.com/a', publishedAt: '2026-10-22T11:29:09.000Z', summary: 'El cobre subió', source: null });
    expect(cleanText('&lt;b&gt;doble&lt;/b&gt; escape')).toBe('doble escape');
  });

  it('descarta ítems sin título o sin enlace válido y recorta los resúmenes largos', () => {
    expect(parseItem('<item><title>x</title><link>javascript:alert(1)</link></item>')).toBeNull();
    const long = parseItem(`<item><title>t</title><link>https://e.com</link><description>${'palabra '.repeat(60)}</description></item>`)!;
    expect(long.summary!.length).toBeLessThanOrEqual(240);
    expect(long.summary!.endsWith('…')).toBe(true);
  });

  it('lee solo lo necesario: corta el stream apenas tiene los ítems pedidos', async () => {
    let pulls = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulls++;
        if (pulls > 1000) return ctrl.close();
        ctrl.enqueue(enc.encode(`<item><title>N${pulls}</title><link>https://example.com/${pulls}</link></item>`));
      },
    });
    const items = await fetchRss('https://example.com/rss', 3, (async () => new Response(stream)) as typeof fetch);
    expect(items.map((i) => i.title)).toEqual(['N1', 'N2', 'N3']);
    expect(pulls).toBeLessThan(10);
  });
});

describe('noticias generales', () => {
  const now = new Date('2026-10-22T15:00:00Z');

  it('junta las fuentes, ordena de la más nueva a la más vieja, sigue si una falla y guarda 30 minutos', async () => {
    const { kv } = memoryKV();
    const { f, calls } = rssFetch((url) => {
      if (url.includes('bloomberg.com')) return null; // Bloomberg caído
      const feed = NEWS_FEEDS.find((x) => x.url === url)!;
      return rss([{ title: `${feed.name}: titular`, link: `https://example.com/${feed.id}`, date: `Thu, 22 Oct 2026 1${NEWS_FEEDS.indexOf(feed)}:00:00 GMT` }]);
    });
    const r = await marketNews({ kv, now, fetch: f });
    expect(calls).toHaveLength(NEWS_FEEDS.length);
    expect(r.data.items.map((i) => i.source)).toEqual(['CNBC', 'MarketWatch', 'WSJ', 'Bloomberg Línea', 'Gestión']);
    expect(r.data.items[0]!.group).toBe('eeuu');
    expect(Object.keys(r.data.errors)).toEqual(['Bloomberg']);
    await marketNews({ kv, now: new Date(now.getTime() + 10 * 60_000), fetch: f });
    expect(calls).toHaveLength(NEWS_FEEDS.length); // sale de la caché
  });

  it('sin repetidos por enlace o por titular', () => {
    const base = { source: 'X', group: null, publishedAt: null, summary: null };
    const merged = mergeNews([
      { ...base, title: 'A', url: 'https://e.com/1' },
      { ...base, title: 'a', url: 'https://e.com/2' },
      { ...base, title: 'B', url: 'https://e.com/1' },
      { ...base, title: 'C', url: 'https://e.com/3' },
    ]);
    expect(merged.map((m) => m.title)).toEqual(['A', 'C']);
  });
});

describe('noticias por acción', () => {
  it('busca por el nombre de la empresa y el símbolo de Yahoo', () => {
    expect(newsQuery('BAP', 'Credicorp Ltd.')).toBe('Credicorp');
    expect(newsQuery('SCCO', 'Southern Copper Corporation')).toBe('Southern Copper');
    expect(newsQuery('BTC/USD', 'Bitcoin US Dollar')).toBe('Bitcoin');
    expect(newsQuery('XYZ', null)).toBe('XYZ');
    expect(yahooSymbol('BTC/USD')).toBe('BTC-USD');
  });

  it('junta Yahoo y Google News y quita el medio repetido al final del titular', async () => {
    const { f, calls } = rssFetch((url) =>
      url.includes('yahoo')
        ? rss([{ title: 'Credicorp beats estimates', link: 'https://finance.yahoo.com/a', date: 'Wed, 21 Oct 2026 20:00:00 GMT' }])
        : rss([{ title: 'Credicorp sube en la BVL - Gestión', link: 'https://news.google.com/a', date: 'Thu, 22 Oct 2026 12:00:00 GMT', source: 'Gestión' }]),
    );
    const items = await symbolNews({ kv: memoryKV().kv, now: new Date(), fetch: f }, 'BAP', 'Credicorp Ltd.');
    expect(calls.some((u) => u.includes('s=BAP'))).toBe(true);
    expect(calls.some((u) => u.includes('q=Credicorp&'))).toBe(true);
    expect(items.map((i) => [i.title, i.source])).toEqual([
      ['Credicorp sube en la BVL', 'Gestión'],
      ['Credicorp beats estimates', 'Yahoo Finance'],
    ]);
  });
});

describe('rutas de noticias', () => {
  const env = (role?: string) =>
    ({ CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('asset') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: role }) as unknown as Env;
  const get = (path: string, role?: string) => worker.fetch(new Request(`http://localhost${path}`), env(role), {} as ExecutionContext);

  it('las generales son públicas; las de cada acción, solo del dueño y de su lista', async () => {
    expect((await get('/api/news', 'friend')).status).toBe(200);
    expect((await get('/api/news/symbol?symbol=BAP', 'friend')).status).toBe(403);
    expect((await get('/api/news/symbol?symbol=NVDA')).status).toBe(400);
    const r = (await (await get('/api/news/symbol?symbol=BAP')).json()) as { items: unknown[] };
    expect(r.items.length).toBeGreaterThan(0);
  });
});
