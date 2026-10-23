import { describe, expect, it } from 'vitest';
import { annualValues, companyConcept, findCik, secTicker } from '../src/lib/sec';
import { financials, fiscalYear, mergeLines, SEC_TTL_MS, SEC_YEARS } from '../src/services/financials';
import type { Deps } from '../src/services/market';
import { memoryKV } from './helpers';

const NOW = new Date('2026-10-23T15:00:00Z');

/** Respuestas de la SEC según la URL (lo que no está, 404 en XML como la de verdad); guarda pedidos y User-Agent. */
function secFetch(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; ua: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
    if (status !== 200) return new Response('', { status });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

const SEARCH_SCCO = {
  hits: {
    hits: [
      { _id: '1001838', _source: { entity: 'SOUTHERN COPPER CORP/ (SCCO)', tickers: 'SCCO' } },
      { _id: '870348', _source: { entity: 'SCCOT FINANCIAL GROUP INCORPORATED' } },
    ],
  },
};

/** Un dato de un informe: anual (10-K) salvo que se diga otro formulario. */
const fact = (start: string, end: string, val: number, filed: string, form = '10-K') => ({ start, end, val, filed, form });
const concept = (unit: string, facts: object[]) => ({ units: { [unit]: facts } });

describe('annualValues', () => {
  it('solo informes anuales de ~1 año; si un año sale en varios informes, queda el más nuevo', () => {
    const v = annualValues([
      fact('2024-01-01', '2024-12-31', 100, '2025-02-01'),
      fact('2024-01-01', '2024-12-31', 105, '2026-02-01'), // corregido en el informe del año siguiente
      fact('2025-01-01', '2025-12-31', 120, '2026-02-01'),
      fact('2025-07-01', '2025-09-30', 30, '2025-10-30', '10-Q'),
      fact('2025-10-01', '2025-12-31', 33, '2026-02-01'), // el 4.º trimestre dentro del 10-K
      fact('2023-01-01', '2023-12-31', 90, '2024-03-01', '8-K'),
    ]);
    expect(v).toEqual([
      { end: '2024-12-31', value: 105 },
      { end: '2025-12-31', value: 120 },
    ]);
  });
});

describe('findCik', () => {
  it('busca el ticker exacto, limpia el nombre y se identifica sin correo', async () => {
    const { f, calls } = secFetch({ 'search-index?keysTyped=SCCO': SEARCH_SCCO });
    expect(await findCik('scco', f)).toEqual({ cik: 1001838, name: 'SOUTHERN COPPER CORP' });
    expect(calls[0]!.url).toBe('https://efts.sec.gov/LATEST/search-index?keysTyped=SCCO');
    expect(calls[0]!.ua).toContain('Rueda');
    expect(calls[0]!.ua).not.toContain('@');
  });

  it('las clases de acciones van con guion en la SEC (BRK.B → BRK-B)', async () => {
    const hit = { _id: '1067983', _source: { entity: 'BERKSHIRE HATHAWAY INC (BRK-B, BRK-A)', tickers: 'BRK-B, BRK-A' } };
    const { f } = secFetch({ 'keysTyped=BRK-B': { hits: { hits: [hit] } } });
    expect(secTicker(' brk.b ')).toBe('BRK-B');
    expect(await findCik('BRK.B', f)).toEqual({ cik: 1067983, name: 'BERKSHIRE HATHAWAY INC' });
  });

  it('sin coincidencia exacta (un ETF) no hay empresa; los errores de la SEC se traducen', async () => {
    const { f } = secFetch({ 'keysTyped=VTI': { hits: { hits: [{ _id: '1', _source: { entity: 'VTIQ CORP (VTIQ)', tickers: 'VTIQ' } }] } } });
    expect(await findCik('VTI', f)).toBeNull();
    await expect(findCik('SCCO', secFetch({}, 429).f)).rejects.toMatchObject({ code: 'rate_limited', provider: 'sec' });
    await expect(findCik('SCCO', secFetch({}, 503).f)).rejects.toMatchObject({ code: 'upstream_error', provider: 'sec' });
  });
});

describe('companyConcept', () => {
  it('toma la unidad de moneda (no la de por acción) y responde null si la empresa no reporta ese concepto', async () => {
    const { f, calls } = secFetch({
      'CIK0001001290/ifrs-full/ProfitLoss.json': {
        units: { 'PEN/shares': [fact('2024-01-01', '2024-12-31', 60, '2025-04-30', '20-F')], PEN: [fact('2024-01-01', '2024-12-31', 5e9, '2025-04-30', '20-F')] },
      },
    });
    expect(await companyConcept(1001290, 'ifrs-full', 'ProfitLoss', f)).toEqual({ currency: 'PEN', values: [{ end: '2024-12-31', value: 5e9 }] });
    expect(calls[0]!.url).toBe('https://data.sec.gov/api/xbrl/companyconcept/CIK0001001290/ifrs-full/ProfitLoss.json');
    expect(await companyConcept(1001290, 'ifrs-full', 'Revenue', f)).toBeNull();
  });
});

describe('mergeLines', () => {
  it('junta los conceptos año por año (manda el primero que tenga el año) y deja una sola moneda', () => {
    const r = mergeLines({
      revenue: [
        { currency: 'USD', values: [{ end: '2018-09-29', value: 265 }] },
        { currency: 'USD', values: [{ end: '2018-09-29', value: 999 }, { end: '2019-09-28', value: 260 }] },
        { currency: 'USD', values: [{ end: '2017-09-30', value: 229 }] },
      ],
      operatingIncome: [null],
      netIncome: [{ currency: 'USD', values: [{ end: '2019-09-28', value: 55 }] }, { currency: 'EUR', values: [{ end: '2017-09-30', value: 1 }] }],
    });
    expect(r.currency).toBe('USD');
    expect(r.years).toEqual([
      { year: 2017, end: '2017-09-30', revenue: 229, operatingIncome: null, netIncome: null },
      { year: 2018, end: '2018-09-29', revenue: 265, operatingIncome: null, netIncome: null },
      { year: 2019, end: '2019-09-28', revenue: 260, operatingIncome: null, netIncome: 55 },
    ]);
  });

  it('el año fiscal: un cierre en los primeros días de enero cuenta para el año anterior; quedan los últimos 12', () => {
    expect([fiscalYear('2025-01-03'), fiscalYear('2026-01-25'), fiscalYear('2025-12-31')]).toEqual([2024, 2026, 2025]);
    const values = Array.from({ length: 15 }, (_, i) => ({ end: `${2011 + i}-12-31`, value: i }));
    const r = mergeLines({ revenue: [{ currency: 'USD', values }], operatingIncome: [], netIncome: [] });
    expect(r.years).toHaveLength(SEC_YEARS);
    expect(r.years[0]!.year).toBe(2014);
  });
});

describe('financials', () => {
  const sccoRoutes = {
    'keysTyped=SCCO': SEARCH_SCCO,
    'CIK0001001838/us-gaap/Revenues.json': concept('USD', [fact('2024-01-01', '2024-12-31', 11_433e6, '2025-02-28'), fact('2025-01-01', '2025-12-31', 12_100e6, '2026-02-27')]),
    'CIK0001001838/us-gaap/OperatingIncomeLoss.json': concept('USD', [fact('2025-01-01', '2025-12-31', 6_000e6, '2026-02-27')]),
    'CIK0001001838/us-gaap/NetIncomeLoss.json': concept('USD', [fact('2024-01-01', '2024-12-31', 3_383e6, '2025-02-28'), fact('2025-01-01', '2025-12-31', 4_000e6, '2026-02-27')]),
  };

  it('busca la empresa, lee los conceptos de US GAAP y guarda todo 7 días', async () => {
    const { f, calls } = secFetch(sccoRoutes);
    const d: Deps = { kv: memoryKV().kv, now: NOW, fetch: f };
    const r = await financials(d, 'SCCO');
    expect(r.data).toMatchObject({ symbol: 'SCCO', cik: 1001838, name: 'SOUTHERN COPPER CORP', standard: 'us-gaap', currency: 'USD' });
    expect(r.data.years).toEqual([
      { year: 2024, end: '2024-12-31', revenue: 11_433e6, operatingIncome: null, netIncome: 3_383e6 },
      { year: 2025, end: '2025-12-31', revenue: 12_100e6, operatingIncome: 6_000e6, netIncome: 4_000e6 },
    ]);
    // La búsqueda y los 6 conceptos de US GAAP; con datos recientes no hacen falta los de NIIF.
    expect(calls).toHaveLength(7);
    expect(calls.some((c) => c.url.includes('ifrs-full'))).toBe(false);
    await financials(d, 'SCCO');
    expect(calls).toHaveLength(7);
    await financials({ ...d, now: new Date(NOW.getTime() + SEC_TTL_MS + 60_000) }, 'SCCO');
    expect(calls).toHaveLength(14);
  });

  it('las extranjeras con NIIF: sin US GAAP se lee la otra taxonomía (Credicorp, en soles y sin «ingresos»)', async () => {
    const { f, calls } = secFetch({
      'keysTyped=BAP': { hits: { hits: [{ _id: '1001290', _source: { entity: 'CREDICORP LTD (BAP)', tickers: 'BAP' } }] } },
      'CIK0001001290/ifrs-full/ProfitLossAttributableToOwnersOfParent.json': concept('PEN', [fact('2025-01-01', '2025-12-31', 6_000e6, '2026-04-29', '20-F')]),
    });
    const r = await financials({ kv: memoryKV().kv, now: NOW, fetch: f }, 'BAP');
    expect(r.data).toMatchObject({ standard: 'ifrs-full', currency: 'PEN', years: [{ year: 2025, revenue: null, operatingIncome: null, netIncome: 6_000e6 }] });
    expect(calls).toHaveLength(11); // búsqueda + 6 de US GAAP + 4 de NIIF
  });

  it('un ETF no está en la SEC: se guarda igual, para no buscarlo en cada visita', async () => {
    const { f, calls } = secFetch({ 'keysTyped=VTI': { hits: { hits: [] } } });
    const d: Deps = { kv: memoryKV().kv, now: NOW, fetch: f };
    expect((await financials(d, 'VTI')).data).toMatchObject({ cik: null, standard: null, years: [] });
    await financials(d, 'VTI');
    expect(calls).toHaveLength(1);
  });

  it('si la SEC falla al renovar, se muestra lo guardado y se avisa', async () => {
    const kv = memoryKV().kv;
    await financials({ kv, now: NOW, fetch: secFetch(sccoRoutes).f }, 'SCCO');
    const r = await financials({ kv, now: new Date(NOW.getTime() + SEC_TTL_MS + 60_000), fetch: secFetch({}, 503).f }, 'SCCO');
    expect(r.stale).toBe(true);
    expect(r.note).toContain('SEC');
    expect(r.data.years).toHaveLength(2);
  });
});
