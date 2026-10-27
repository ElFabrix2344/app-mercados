import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import type { NewsItem } from '../src/services/news';
import { buildSummary, publishSummary, readSummaries, SUMMARY_DAYS, SUMMARY_KEY, type DailySummary } from '../src/services/summary';
import { memoryKV } from './helpers';

// Martes 27 oct 2026, 7:02 en Lima (12:02 UTC).
const NOW = new Date('2026-10-27T12:02:00Z');
const TZ = 'America/Lima';

const news: NewsItem[] = [
  { title: 'El cobre sube por la demanda china', url: 'https://gestion.pe/economia/cobre-sube-123', source: 'Gestión', group: 'latam', publishedAt: '2026-10-27T10:00:00.000Z', summary: null },
  { title: 'Stocks close mixed ahead of the Fed', url: 'https://www.wsj.com/finance/stocks/mixed-456', source: 'WSJ', group: 'eeuu', publishedAt: '2026-10-26T21:00:00.000Z', summary: null },
];

const TEXT = 'El cobre subió en Londres por la demanda china y en Lima el dólar terminó casi sin cambios. En Nueva York los índices cerraron mixtos.';

const draft = (over: Partial<Parameters<typeof buildSummary>[0]> = {}) => ({
  title: 'El cobre sube y el dólar cierra estable',
  text: TEXT,
  points: [],
  sources: [{ url: news[0]!.url }],
  ...over,
});

describe('buildSummary', () => {
  it('pone la fecha de Lima y toma el titular y el medio de la caché de noticias', () => {
    const s = buildSummary(draft({ sources: [{ url: news[0]!.url }, { url: news[1]!.url, title: 'otro título' }] }), news, NOW, TZ);
    expect(s.date).toBe('2026-10-27');
    expect(s.publishedAt).toBe(NOW.toISOString());
    expect(s.sources).toEqual([
      { title: news[0]!.title, url: news[0]!.url, source: 'Gestión' },
      { title: news[1]!.title, url: news[1]!.url, source: 'WSJ' },
    ]);
  });

  it('a las 11 p. m. de Lima ya es otro día en UTC, pero el resumen sigue siendo de ese día', () => {
    expect(buildSummary(draft(), news, new Date('2026-10-28T04:00:00Z'), TZ).date).toBe('2026-10-27');
  });

  it('limpia Markdown, espacios y viñetas', () => {
    const s = buildSummary(draft({ title: '  **El cobre**   sube\ny el dólar   ', points: ['- Perú: la BVL sube levemente.', '• EE. UU.: la Fed decide el miércoles.'] }), news, NOW, TZ);
    expect(s.title).toBe('El cobre sube y el dólar');
    expect(s.points).toEqual(['Perú: la BVL sube levemente.', 'EE. UU.: la Fed decide el miércoles.']);
  });

  it('acepta enlaces de medios conocidos y fuentes oficiales aunque no estén en la caché, y quita repetidos', () => {
    const s = buildSummary(
      draft({ sources: [{ url: 'https://www.bloomberg.com/news/articles/x', title: 'Copper rallies' }, { url: 'https://www.bcrp.gob.pe/docs/nota.pdf' }, { url: news[0]!.url }, { url: news[0]!.url }] }),
      news,
      NOW,
      TZ,
    );
    expect(s.sources.map((x) => x.source)).toEqual(['Bloomberg', 'BCRP', 'Gestión']);
    expect(s.sources[1]!.title).toBe('Nota de BCRP');
  });

  it('rechaza enlaces de otros dominios, que no son enlaces o que no son https', () => {
    expect(() => buildSummary(draft({ sources: [{ url: 'https://phishing.example/login' }] }), news, NOW, TZ)).toThrow(/phishing\.example/);
    expect(() => buildSummary(draft({ sources: [{ url: 'https://evilgestion.pe/x' }] }), news, NOW, TZ)).toThrow(/evilgestion/);
    expect(() => buildSummary(draft({ sources: [{ url: 'no es un enlace' }] }), news, NOW, TZ)).toThrow(/no es un enlace/);
    expect(() => buildSummary(draft({ sources: [{ url: 'javascript:alert(1)' }] }), news, NOW, TZ)).toThrow(/https/);
  });

  it('exige largos razonables y al menos una fuente', () => {
    expect(() => buildSummary(draft({ title: 'Corto' }), news, NOW, TZ)).toThrow(/El título debe tener entre 10 y 120/);
    expect(() => buildSummary(draft({ text: 'Muy corto.' }), news, NOW, TZ)).toThrow(/El texto/);
    expect(() => buildSummary(draft({ text: 'a'.repeat(1201) }), news, NOW, TZ)).toThrow(/El texto/);
    expect(() => buildSummary(draft({ points: ['uno', 'dos', 'tres', 'cuatro', 'cinco'].map((p) => `Punto número ${p}.`) }), news, NOW, TZ)).toThrow(/4 puntos/);
    expect(() => buildSummary(draft({ sources: [] }), news, NOW, TZ)).toThrow(/al menos una fuente/);
  });
});

describe('publishSummary', () => {
  const entry = (date: string, title = `Resumen del ${date} con su titular`): DailySummary => ({ date, title, text: TEXT, points: [], sources: [], publishedAt: `${date}T12:00:00.000Z` });

  it('reemplaza el del mismo día, ordena del más nuevo al más viejo y guarda en una sola escritura', async () => {
    const mem = memoryKV({ [SUMMARY_KEY]: { items: [entry('2026-10-26'), entry('2026-10-27', 'El primero de hoy, que se reemplaza')] } });
    const store = await publishSummary(mem.kv, entry('2026-10-27'));
    expect(store.items.map((x) => x.title)).toEqual(['Resumen del 2026-10-27 con su titular', 'Resumen del 2026-10-26 con su titular']);
    expect(mem.writes()).toBe(1);
    expect((await readSummaries(mem.kv)).items).toHaveLength(2);
  });

  it(`deja solo los últimos ${SUMMARY_DAYS} días`, async () => {
    const mem = memoryKV();
    for (let d = 10; d < 20; d++) await publishSummary(mem.kv, entry(`2026-10-${d}`));
    const { items } = await readSummaries(mem.kv);
    expect(items.map((x) => x.date)).toEqual(['2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13']);
  });

  it('sin nada guardado devuelve una lista vacía', async () => {
    expect(await readSummaries(memoryKV().kv)).toEqual({ items: [] });
  });
});

describe('/api/resumen', () => {
  it('devuelve lo guardado, también a los amigos', async () => {
    const mem = memoryKV({ [SUMMARY_KEY]: { items: [buildSummary(draft(), news, NOW, TZ)] } });
    const env = { CACHE: mem.kv, ASSETS: { fetch: async () => new Response('asset') }, TIMEZONE: TZ, DEV_MODE: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const res = await worker.fetch(new Request('http://localhost/api/resumen'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DailySummary[] };
    expect(body.items[0]!.title).toBe('El cobre sube y el dólar cierra estable');
  });
});
