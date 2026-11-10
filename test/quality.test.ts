import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { DEFAULT_TAX, mergeQuality, piotroski, quality, qualityYears, type YearInputs } from '../src/services/quality';
import { memoryKV } from './helpers';

const NOW = new Date('2026-11-09T15:00:00Z');

/** Un año con todo: se cambia lo que cada prueba necesita. */
const year = (o: Partial<YearInputs> = {}): YearInputs => ({
  year: 2025,
  end: '2025-12-31',
  revenue: 1000,
  operatingIncome: 200,
  netIncome: 120,
  ocf: 180,
  capex: 50,
  cash: 100,
  debt: 300,
  equity: 600,
  assets: 1500,
  assetsCurrent: 400,
  liabilitiesCurrent: 200,
  grossProfit: 420,
  tax: 40,
  pretax: 160,
  buybacks: -30,
  dividends: 48,
  sbc: 10,
  shares: 100,
  ...o,
});

describe('calidad del negocio (SEC)', () => {
  it('ROIC: utilidad operativa después de impuestos sobre el capital promedio (deuda + patrimonio − caja)', () => {
    const before = year({ year: 2024, end: '2024-12-31', debt: 250, equity: 550, cash: 100, operatingIncome: 150 });
    const [a, b] = qualityYears([before, year()]);
    // 2024 (sin año anterior): capital 700; impuestos 40/160 = 25 %.
    expect(a!.roic).toBeCloseTo((150 * 0.75) / 700, 6);
    // 2025: capital 800, promedio con 700 = 750.
    expect(b).toMatchObject({ year: 2025, taxRate: 0.25, taxAssumed: false, grossMargin: 0.42, fcf: 130, dividends: 48, buybacks: 30, shares: 100 });
    expect(b!.roic).toBeCloseTo((200 * 0.75) / 750, 6);
  });

  it('si el informe no deja calcular los impuestos (pérdidas, tasa rara), se asume la de EE. UU. y se dice', () => {
    const [loss, odd, none] = qualityYears([year({ pretax: -10 }), year({ tax: 150 }), year({ tax: null })]);
    for (const y of [loss, odd, none]) expect(y).toMatchObject({ taxRate: DEFAULT_TAX, taxAssumed: true });
    // Sin patrimonio, o con más caja que capital, no hay ROIC que medir.
    expect(qualityYears([year({ equity: null })])[0]!.roic).toBeNull();
    expect(qualityYears([year({ cash: 2000 })])[0]!.roic).toBeNull();
    expect(qualityYears([year({ operatingIncome: null })])[0]!.roic).toBeNull();
  });

  it('Piotroski: 9 señales frente al año anterior', () => {
    const prev = year({ year: 2024, end: '2024-12-31', revenue: 900, netIncome: 90, ocf: 100, debt: 350, assets: 1450, assetsCurrent: 350, liabilitiesCurrent: 200, grossProfit: 360, shares: 102 });
    const r = piotroski(year(), prev)!;
    expect(r).toMatchObject({ year: 2025, prevYear: 2024, score: 9, of: 9 });
    expect(r.checks.map((c) => c.key)).toEqual(['utilidad', 'flujo', 'roa', 'caja', 'deuda', 'liquidez', 'acciones', 'margen', 'rotacion']);
    expect(r.checks.find((c) => c.key === 'deuda')).toMatchObject({ ok: true, now: 0.2, prev: 350 / 1450 });
    // Lo contrario: pierde plata, quema caja, más deuda, más acciones, peor margen.
    const bad = piotroski(year({ netIncome: -10, ocf: -20, debt: 400, shares: 110, grossProfit: 300, assetsCurrent: 300, revenue: 800 }), prev)!;
    expect(bad.score).toBe(0);
    expect(bad.of).toBe(9);
  });

  it('una señal sin datos no cuenta; con menos de 5 (un banco) no hay puntaje', () => {
    const prev = year({ year: 2024, end: '2024-12-31' });
    const r = piotroski(year({ assetsCurrent: null, grossProfit: null, shares: null }), prev)!;
    expect(r.of).toBe(6);
    expect(r.checks.filter((c) => c.ok === null).map((c) => c.key)).toEqual(['liquidez', 'acciones', 'margen']);
    const bank = year({ revenue: null, ocf: null, debt: null, assetsCurrent: null, liabilitiesCurrent: null, grossProfit: null });
    expect(piotroski(bank, { ...bank, year: 2024 })).toBeNull();
    // Sin deuda los dos años: la señal de deuda se cumple.
    expect(piotroski(year({ debt: 0 }), year({ year: 2024, debt: 0 }))!.checks.find((c) => c.key === 'deuda')!.ok).toBe(true);
  });

  it('junta resultados, fundamentales y sus propias líneas por año; la utilidad bruta sale de ventas menos costo si hace falta', () => {
    const f = (end: string, value: number, currency = 'USD') => ({ currency, values: [{ end, value }] });
    const fin = [{ year: 2025, end: '2025-12-31', revenue: 1000, operatingIncome: 200, netIncome: 120 }];
    const fund = [{ year: 2025, end: '2025-12-31', ocf: 180, capex: 50, da: 40, cash: 100, debt: 300, equity: 600, assets: 1500 }];
    const lines = {
      assetsCurrent: [f('2025-12-31', 400)],
      liabilitiesCurrent: [f('2025-12-31', 200)],
      grossProfit: [null],
      costOfRevenue: [null, f('2025-12-31', 580)],
      tax: [f('2025-12-31', 40)],
      pretax: [f('2025-12-31', 160, 'PEN')], // otra moneda: no se mezcla
      buybacks: [f('2025-12-31', 30)],
      dividends: [null, f('2025-12-31', 48)],
      sbc: [],
      shares: [f('2025-12-31', 100, 'shares')],
    };
    expect(mergeQuality(fin, fund, 'USD', lines)[0]).toEqual(year({ pretax: null, buybacks: 30, sbc: null }));
  });

  it('el servicio pide sus conceptos (las acciones, en su unidad) y guarda el resultado', async () => {
    const calls: string[] = [];
    const dur = (end: string, val: number, form = '10-K') => ({ start: `${end.slice(0, 4)}-01-01`, end, val, filed: `${Number(end.slice(0, 4)) + 1}-02-27`, form });
    const inst = (end: string, val: number) => ({ end, val, filed: `${Number(end.slice(0, 4)) + 1}-02-27`, form: '10-K' });
    const usd = (facts: object[]) => ({ units: { USD: facts } });
    const both = (a: number, b: number, kind: 'd' | 'i' = 'd') => usd(kind === 'd' ? [dur('2024-12-31', a), dur('2025-12-31', b)] : [inst('2024-12-31', a), inst('2025-12-31', b)]);
    const routes: Record<string, unknown> = {
      'keysTyped=XYZ': { hits: { hits: [{ _id: '42', _source: { entity: 'XYZ CORP (XYZ)', tickers: 'XYZ' } }] } },
      'us-gaap/Revenues.json': both(900, 1000),
      'us-gaap/OperatingIncomeLoss.json': both(150, 200),
      'us-gaap/NetIncomeLoss.json': both(90, 120),
      'dei/EntityCommonStockSharesOutstanding.json': { units: { shares: [{ end: '2026-02-15', val: 100, filed: '2026-02-27', form: '10-K', accn: 'k' }] } },
      'us-gaap/NetCashProvidedByUsedInOperatingActivities.json': both(100, 180),
      'us-gaap/PaymentsToAcquirePropertyPlantAndEquipment.json': both(40, 50),
      'us-gaap/CashAndCashEquivalentsAtCarryingValue.json': both(100, 100, 'i'),
      'us-gaap/StockholdersEquity.json': both(550, 600, 'i'),
      'us-gaap/Assets.json': both(1450, 1500, 'i'),
      'us-gaap/LongTermDebt.json': both(350, 300, 'i'),
      'us-gaap/AssetsCurrent.json': both(350, 400, 'i'),
      'us-gaap/LiabilitiesCurrent.json': both(200, 200, 'i'),
      'us-gaap/GrossProfit.json': both(360, 420),
      'us-gaap/IncomeTaxExpenseBenefit.json': both(30, 40),
      'us-gaap/IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest.json': both(120, 160),
      'us-gaap/PaymentsOfDividends.json': both(40, 48),
      'us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding.json': { units: { shares: [dur('2024-12-31', 102), dur('2025-12-31', 100)] } },
    };
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? Response.json(routes[key]) : new Response('no', { status: 404 });
    }) as typeof fetch;
    const kv = memoryKV().kv;
    const r = await quality({ kv, now: NOW, fetch: f }, 'XYZ');
    expect(r.data).toMatchObject({ symbol: 'XYZ', cik: 42, name: 'XYZ CORP', currency: 'USD', piotroski: { year: 2025, prevYear: 2024, score: 9, of: 9 } });
    expect(r.data.years.at(-1)).toMatchObject({ year: 2025, taxRate: 0.25, grossMargin: 0.42, fcf: 130, dividends: 48, buybacks: null, shares: 100 });
    // Lejos del límite de 50 consultas por pedido del plan gratis, incluso sin nada guardado.
    expect(calls.length).toBeLessThan(45);
    const before = calls.length;
    await quality({ kv, now: NOW, fetch: f }, 'XYZ');
    expect(calls).toHaveLength(before);
  });

  it('la ruta es pública (datos de la SEC) y solo para acciones', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const get = (path: string) => worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext);
    const res = await get('/api/quality?symbol=scco');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.years.at(-1)).toMatchObject({ roic: expect.any(Number), shares: expect.any(Number) });
    expect(body.data.piotroski).toMatchObject({ score: expect.any(Number), of: 9 });
    // El banco de prueba (20-F, sin ventas ni activo corriente): sin puntaje.
    expect(((await (await get('/api/quality?symbol=BAP')).json()) as any).data.piotroski).toBeNull();
    expect((await get('/api/quality?symbol=USD/PEN')).status).toBe(400);
  });
});
