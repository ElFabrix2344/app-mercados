import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { instantValues } from '../src/lib/sec';
import { fundamentals, mergeFundamentals } from '../src/services/fundamentals';
import { memoryKV } from './helpers';

const NOW = new Date('2026-11-04T15:00:00Z');
const dur = (end: string, val: number, filed = '2026-02-27', form = '10-K') => ({ start: `${Number(end.slice(0, 4))}-01-01`, end, val, filed, form });
const inst = (end: string, val: number, filed = '2026-02-27', form = '10-K') => ({ end, val, filed, form });
const concept = (facts: object[], unit = 'USD') => ({ units: { [unit]: facts } });

describe('fundamentales de la SEC (ratios y DCF)', () => {
  it('los saldos del balance: sin fecha de inicio, de informes anuales; la corrección más nueva manda', () => {
    expect(
      instantValues([
        inst('2025-12-31', 100, '2026-02-01'),
        inst('2025-12-31', 120, '2026-03-01', '10-K/A'),
        inst('2024-12-31', 90),
        { start: '2025-01-01', end: '2025-12-31', val: 999, filed: '2026-02-01', form: '10-K' }, // un flujo, no un saldo
        inst('2026-06-30', 130, '2026-08-01', '10-Q'), // trimestral: no cuenta
      ]),
    ).toEqual([
      { end: '2024-12-31', value: 90 },
      { end: '2025-12-31', value: 120 },
    ]);
  });

  it('la deuda: la total de largo plazo o sus partes, más la de corto plazo; la inversión, siempre positiva', () => {
    const f = (end: string, value: number) => ({ currency: 'USD', values: [{ end, value }] });
    const none = { ocf: [], capex: [f('2025-12-31', -300)], da: [], cash: [], equity: [], assets: [] };
    const ends = [{ year: 2025, end: '2025-12-31' }];
    expect(mergeFundamentals(ends, 'USD', none, { total: [f('2025-12-31', 1000)], parts: [], short: [f('2025-12-31', 50)] })[0]).toMatchObject({ debt: 1050, capex: 300 });
    expect(mergeFundamentals(ends, 'USD', none, { total: [null], parts: [f('2025-12-31', 700), f('2025-12-31', 100)], short: [] })[0]!.debt).toBe(800);
    expect(mergeFundamentals(ends, 'USD', none, { total: [null], parts: [null, null], short: [] })[0]!.debt).toBeNull();
    // Otra moneda que la de los resultados no se mezcla.
    expect(mergeFundamentals(ends, 'PEN', none, { total: [f('2025-12-31', 1000)], parts: [], short: [] })[0]!.debt).toBeNull();
  });

  it('pide los conceptos de la taxonomía de la empresa y los alinea con sus años fiscales', async () => {
    const calls: string[] = [];
    const routes: Record<string, unknown> = {
      'keysTyped=XYZ': { hits: { hits: [{ _id: '42', _source: { entity: 'XYZ CORP (XYZ)', tickers: 'XYZ' } }] } },
      'us-gaap/Revenues.json': concept([dur('2024-12-31', 900), dur('2025-12-31', 1000)]),
      'us-gaap/NetIncomeLoss.json': concept([dur('2025-12-31', 120)]),
      'dei/EntityCommonStockSharesOutstanding.json': { units: { shares: [{ end: '2026-02-15', val: 10, filed: '2026-02-27', form: '10-K', accn: 'k' }] } },
      'us-gaap/NetCashProvidedByUsedInOperatingActivities.json': concept([dur('2025-12-31', 200)]),
      'us-gaap/PaymentsToAcquirePropertyPlantAndEquipment.json': concept([dur('2025-12-31', 50)]),
      'us-gaap/DepreciationDepletionAndAmortization.json': concept([dur('2025-12-31', 30)]),
      'us-gaap/CashAndCashEquivalentsAtCarryingValue.json': concept([inst('2025-12-31', 80), inst('2024-12-31', 60)]),
      'us-gaap/StockholdersEquity.json': concept([inst('2025-12-31', 500)]),
      'us-gaap/Assets.json': concept([inst('2025-12-31', 1500)]),
      'us-gaap/LongTermDebt.json': concept([inst('2025-12-31', 400)]),
    };
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? Response.json(routes[key]) : new Response('no', { status: 404 });
    }) as typeof fetch;
    const r = await fundamentals({ kv: memoryKV().kv, now: NOW, fetch: f }, 'XYZ');
    expect(r.data).toMatchObject({ cik: 42, standard: 'us-gaap', currency: 'USD' });
    expect(r.data.years.at(-1)).toEqual({ year: 2025, end: '2025-12-31', ocf: 200, capex: 50, da: 30, cash: 80, debt: 400, equity: 500, assets: 1500 });
    expect(r.data.years[0]).toMatchObject({ year: 2024, cash: 60, ocf: null });
    expect(calls.some((u) => u.includes('ifrs-full/CashAndCashEquivalents.json'))).toBe(false);
  });

  it('la ruta es pública (datos de la SEC) y solo para acciones', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const get = (path: string) => worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext);
    const res = await get('/api/fundamentals?symbol=scco');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.years.at(-1)).toMatchObject({ ocf: expect.any(Number), equity: expect.any(Number) });
    expect((await get('/api/fundamentals?symbol=USD/PEN')).status).toBe(400);
  });
});
