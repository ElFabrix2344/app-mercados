import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { FILINGS_KEPT, parseSubmissions } from '../src/lib/sec';
import { filings, FILINGS_TTL_MS } from '../src/services/filings';
import { memoryKV } from './helpers';

const NOW = new Date('2026-11-09T15:00:00Z');

/** La lista de EDGAR viene en columnas: aquí se escribe por filas (formulario, presentado, periodo, temas, número, documento). */
type Row = [form: string, date: string, period: string, items: string, accn: string, doc: string];
const recent = (rows: Row[]) => ({
  form: rows.map((r) => r[0]),
  filingDate: rows.map((r) => r[1]),
  reportDate: rows.map((r) => r[2]),
  items: rows.map((r) => r[3]),
  accessionNumber: rows.map((r) => r[4]),
  primaryDocument: rows.map((r) => r[5]),
});

const SCCO = {
  name: 'SOUTHERN COPPER CORP/',
  sicDescription: 'Metal Mining',
  fiscalYearEnd: '1231',
  website: 'https://www.southerncoppercorp.com',
  exchanges: ['NYSE'],
  filings: {
    recent: recent([
      ['4/A', '2026-10-30', '2026-09-24', '', '0001284489-26-000042', 'xslF345X06/form4a.xml'],
      ['10-Q', '2026-10-30', '2026-09-30', '', '0001104659-26-120639', 'scco-20260930x10q.htm'],
      ['8-K', '2026-10-21', '2026-10-20', '2.02,9.01', '0001104659-26-117588', 'scco-20261020x8k.htm'],
      ['4', '2026-10-01', '2026-09-29', '', '0001284489-26-000040', 'xslF345X06/form4.xml'],
      ['SD', '2026-09-16', '', '', '0001104659-26-108308', 'scco-20251231xsd.htm'],
      ['4', '2026-06-15', '2026-06-12', '', '0001284489-26-000030', 'xslF345X06/form4.xml'],
      ['8-K', '2026-07-17', '2026-05-29', '5.07', '0001104659-26-084713', 'scco-20260529x8k.htm'],
      ['DEF 14A', '2026-04-17', '2026-05-29', '', '0001104659-26-044444', 'scco-def14a.htm'],
      ['NT 10-K', '2026-03-02', '2025-12-31', '', '0001104659-26-022222', 'nt10k.htm'],
      ['10-K/A', '2026-03-20', '2025-12-31', '', '0001104659-26-033333', '../../etc/passwd'],
      ['10-K', '2026-02-27', '2025-12-31', '', 'no-es-un-numero', 'scco-10k.htm'],
      ['4', '2025-10-01', '2025-09-29', '', '0001284489-25-000011', 'xslF345X06/form4.xml'],
    ]),
  },
};

describe('reportes de la SEC', () => {
  it('quedan los que importan, con su tipo, sus temas y el enlace al documento; los formularios 4 solo se cuentan', () => {
    const s = parseSubmissions(SCCO, 1001838, NOW);
    expect(s.company).toEqual({ name: 'SOUTHERN COPPER CORP/', industry: 'Metal Mining', fiscalYearEnd: '1231', website: 'https://www.southerncoppercorp.com', exchanges: ['NYSE'] });
    expect(s.filings.map((f) => [f.form, f.kind, f.date])).toEqual([
      ['10-Q', 'trimestral', '2026-10-30'],
      ['8-K', 'evento', '2026-10-21'],
      ['8-K', 'evento', '2026-07-17'],
      ['DEF 14A', 'junta', '2026-04-17'],
      ['10-K/A', 'anual', '2026-03-20'],
      ['NT 10-K', 'tarde', '2026-03-02'],
    ]);
    // El 9.01 (anexos) no es un tema; el periodo, solo si viene.
    expect(s.filings[1]).toEqual({ form: '8-K', kind: 'evento', date: '2026-10-21', period: '2026-10-20', items: ['2.02'], url: 'https://www.sec.gov/Archives/edgar/data/1001838/000110465926117588/scco-20261020x8k.htm' });
    // Un nombre de archivo raro no entra en el enlace (va a la carpeta del reporte); un número de reporte raro, fuera.
    expect(s.filings[4]!.url).toBe('https://www.sec.gov/Archives/edgar/data/1001838/000110465926033333/');
    expect(s.filings.some((f) => f.form === '10-K')).toBe(false);
    // Avisos de directivos: 1 en 90 días (el 4/A es una corrección y no cuenta) y 2 en un año; el de hace 13 meses, no.
    expect(s.insiders).toEqual({ d90: 1, d365: 2, last: '2026-10-01' });
    // Resultados: los 8-K con el tema 2.02 (el de votación, 5.07, no).
    expect(s.earnings).toEqual(['2026-10-21']);
  });

  it('con muchos hechos, quedan los últimos y, aunque sean más viejos, los dos informes anuales más nuevos', () => {
    const many: Row[] = Array.from({ length: 40 }, (_, i) => ['6-K', `2026-${String(10 - Math.floor(i / 5)).padStart(2, '0')}-${String(28 - (i % 5)).padStart(2, '0')}`, '', '', '0001104659-26-100000', 'a.htm']);
    const rows: Row[] = [...many, ['20-F', '2026-01-30', '2025-12-31', '', '0001104659-26-000001', 'f.htm'], ['20-F', '2025-04-30', '2024-12-31', '', '0001104659-25-000001', 'f.htm'], ['20-F', '2024-04-30', '2023-12-31', '', '0001104659-24-000001', 'f.htm']];
    const s = parseSubmissions({ name: 'X', filings: { recent: recent(rows) } }, 1, NOW);
    expect(s.filings).toHaveLength(FILINGS_KEPT + 2);
    expect(s.filings.filter((f) => f.kind === 'anual').map((f) => f.period)).toEqual(['2025-12-31', '2024-12-31']);
    // Las fechas de resultados salen de toda la lista, del más viejo al más nuevo, sin repetir y sin las correcciones.
    const q: Row[] = [
      ['8-K', '2026-07-22', '', '2.02,9.01', '0001104659-26-000007', 'a.htm'],
      ['8-K/A', '2026-07-25', '', '2.02', '0001104659-26-000008', 'a.htm'],
      ['8-K', '2026-04-22', '', '7.01, 2.02', '0001104659-26-000004', 'a.htm'],
      ['8-K', '2026-04-22', '', '2.02', '0001104659-26-000005', 'a.htm'],
      ['8-K', '2026-03-02', '', '12.02', '0001104659-26-000003', 'a.htm'],
    ];
    expect(parseSubmissions({ filings: { recent: recent([...many, ...q]) } }, 1, NOW).earnings).toEqual(['2026-04-22', '2026-07-22']);
    expect(s.company).toMatchObject({ industry: null, fiscalYearEnd: null, website: null, exchanges: [] });
  });

  it('una lista vacía o rota no rompe nada; un sitio web que no es una dirección simple no pasa', () => {
    expect(parseSubmissions({}, 1, NOW)).toMatchObject({ filings: [], insiders: { d90: 0, d365: 0, last: null }, earnings: [] });
    expect(parseSubmissions({ website: 'javascript:alert(1)' }, 1, NOW).company.website).toBeNull();
  });

  it('el servicio: busca la empresa, lee su lista y la guarda 12 horas; un ETF queda guardado como «sin empresa»', async () => {
    const calls: string[] = [];
    const routes: Record<string, unknown> = {
      'keysTyped=SCCO': { hits: { hits: [{ _id: '1001838', _source: { entity: 'SOUTHERN COPPER CORP/ (SCCO)', tickers: 'SCCO' } }] } },
      'submissions/CIK0001001838.json': SCCO,
      'keysTyped=VTI': { hits: { hits: [] } },
    };
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? Response.json(routes[key]) : new Response('no', { status: 404 });
    }) as typeof fetch;
    const kv = memoryKV().kv;
    const r = await filings({ kv, now: NOW, fetch: f }, 'SCCO');
    expect(r.data).toMatchObject({ symbol: 'SCCO', cik: 1001838, company: { name: 'SOUTHERN COPPER CORP', industry: 'Metal Mining' }, insiders: { d90: 1 } });
    expect(r.data.filings).toHaveLength(6);
    expect(calls).toEqual(['https://efts.sec.gov/LATEST/search-index?keysTyped=SCCO', 'https://data.sec.gov/submissions/CIK0001001838.json']);
    await filings({ kv, now: NOW, fetch: f }, 'SCCO');
    expect(calls).toHaveLength(2);
    await filings({ kv, now: new Date(NOW.getTime() + FILINGS_TTL_MS + 60_000), fetch: f }, 'SCCO');
    expect(calls).toHaveLength(4);
    expect((await filings({ kv, now: NOW, fetch: f }, 'VTI')).data).toEqual({ symbol: 'VTI', cik: null, company: null, filings: [], insiders: null, earnings: [] });
    await filings({ kv, now: NOW, fetch: f }, 'VTI');
    expect(calls).toHaveLength(5);
    // Si los resultados ya encontraron la empresa (o que no existe), no se vuelve a buscar.
    const known = memoryKV({ 'sec:SCCO': { fetchedAt: NOW.toISOString(), data: { cik: 1001838, name: 'SOUTHERN COPPER CORP' } }, 'sec:SPY': { fetchedAt: NOW.toISOString(), data: { cik: null, name: null } } }).kv;
    expect((await filings({ kv: known, now: NOW, fetch: f }, 'SCCO')).data.filings).toHaveLength(6);
    expect(calls.at(-1)).toBe('https://data.sec.gov/submissions/CIK0001001838.json');
    expect(calls).toHaveLength(6);
    expect((await filings({ kv: known, now: NOW, fetch: f }, 'SPY')).data.cik).toBeNull();
    expect(calls).toHaveLength(6);
  });

  it('la ruta es pública (la lista de EDGAR lo es) y solo para acciones', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const get = (path: string) => worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext);
    const res = await get('/api/filings?symbol=scco');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.filings[0]).toMatchObject({ form: expect.any(String), kind: expect.any(String), url: expect.stringMatching(/^https:\/\/www\.sec\.gov\//) });
    expect((await get('/api/filings?symbol=BTC/USD')).status).toBe(400);
  });
});
