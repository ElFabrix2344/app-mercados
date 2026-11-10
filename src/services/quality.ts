// Calidad del negocio (9 nov, «la ficha al día»): cuánto rinde el capital (ROIC), el puntaje de Piotroski (9 señales
// de salud financiera, año contra año) y lo que la empresa devuelve o diluye (dividendos, recompras, acciones). Todo
// sale de los informes anuales de la SEC (dominio público: también lo ven los amigos) y son cuentas, no una opinión.
// Unas 13 consultas más, aparte de las de los resultados (`sec:`) y los fundamentales (`secx:`), para que cada pedido
// quede lejos del límite de 50 del plan gratis. Se guarda 7 días (`secq:<símbolo>`).

import { companyConcept, type AnnualValue } from '../lib/sec';
import { financials, SEC_TTL_MS, type FinancialYear, type Standard } from './financials';
import { fundamentals, inBatches, type FundYear } from './fundamentals';
import { cached, type Deps, type Fresh } from './market';

type Line = 'assetsCurrent' | 'liabilitiesCurrent' | 'grossProfit' | 'costOfRevenue' | 'tax' | 'pretax' | 'buybacks' | 'dividends' | 'sbc' | 'shares';
const INSTANT = new Set<Line>(['assetsCurrent', 'liabilitiesCurrent']);
/** Años que se guardan (los de los fundamentales). */
const YEARS = 6;
/** Tasa de impuestos que se asume si el informe no deja calcular la efectiva (la federal de EE. UU.). */
export const DEFAULT_TAX = 0.21;

/** Conceptos de cada línea, en orden de preferencia: manda el primero que tenga el año. */
const CONCEPTS: Record<Standard, Record<Line, string[]>> = {
  'us-gaap': {
    assetsCurrent: ['AssetsCurrent'],
    liabilitiesCurrent: ['LiabilitiesCurrent'],
    grossProfit: ['GrossProfit'],
    costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
    tax: ['IncomeTaxExpenseBenefit'],
    pretax: [
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    ],
    buybacks: ['PaymentsForRepurchaseOfCommonStock'],
    dividends: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    sbc: ['ShareBasedCompensation'],
    shares: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  },
  'ifrs-full': {
    assetsCurrent: ['CurrentAssets'],
    liabilitiesCurrent: ['CurrentLiabilities'],
    grossProfit: ['GrossProfit'],
    costOfRevenue: ['CostOfSales'],
    tax: ['IncomeTaxExpenseContinuingOperations'],
    pretax: ['ProfitLossBeforeTax'],
    buybacks: ['PaymentsToAcquireOrRedeemEntitysShares'],
    dividends: ['DividendsPaidClassifiedAsFinancingActivities', 'DividendsPaid'],
    sbc: [],
    shares: ['AdjustedWeightedAverageShares', 'WeightedAverageShares'],
  },
};

export interface QualityYear {
  year: number;
  end: string;
  /** Rendimiento del capital invertido: utilidad operativa después de impuestos ÷ (deuda + patrimonio − caja). */
  roic: number | null;
  /** Tasa de impuestos usada en el ROIC: la efectiva del año o, si no se puede calcular, DEFAULT_TAX. */
  taxRate: number;
  taxAssumed: boolean;
  grossMargin: number | null;
  /** Flujo de caja libre: flujo operativo menos inversión en activo fijo. */
  fcf: number | null;
  revenue: number | null;
  netIncome: number | null;
  /** Dividendos pagados en el año (positivo). */
  dividends: number | null;
  /** Recompras de acciones propias (positivo). */
  buybacks: number | null;
  /** Pago a empleados en acciones. */
  sbc: number | null;
  /** Promedio diluido de acciones del año. */
  shares: number | null;
}

export type PiotroskiKey = 'utilidad' | 'flujo' | 'roa' | 'caja' | 'deuda' | 'liquidez' | 'acciones' | 'margen' | 'rotacion';

export interface PiotroskiCheck {
  key: PiotroskiKey;
  /** null si la SEC no trae los datos para calcularla. */
  ok: boolean | null;
  /** El indicador del año y el del anterior (los que tienen sentido en cada señal). */
  now: number | null;
  prev: number | null;
}

export interface Piotroski {
  year: number;
  prevYear: number;
  /** Señales cumplidas, de las `of` que se pudieron calcular. */
  score: number;
  of: number;
  checks: PiotroskiCheck[];
}

export interface QualityData {
  symbol: string;
  cik: number | null;
  name: string | null;
  standard: Standard | null;
  currency: string | null;
  /** Hasta 6 años fiscales, del más viejo al más nuevo. */
  years: QualityYear[];
  /** null si no hay dos años seguidos o se pueden calcular menos de 5 señales (pasa con bancos y aseguradoras). */
  piotroski: Piotroski | null;
}

/** Lo que se sabe de un año, con todo junto: resultados, fundamentales y las líneas propias de este bloque. */
export interface YearInputs {
  year: number;
  end: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ocf: number | null;
  capex: number | null;
  cash: number | null;
  debt: number | null;
  equity: number | null;
  assets: number | null;
  assetsCurrent: number | null;
  liabilitiesCurrent: number | null;
  grossProfit: number | null;
  tax: number | null;
  pretax: number | null;
  buybacks: number | null;
  dividends: number | null;
  sbc: number | null;
  shares: number | null;
}

const div = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null);
/** Deuda + patrimonio − caja; null sin patrimonio o si no queda capital que medir. */
const invested = (y: YearInputs) => {
  if (y.equity === null) return null;
  const v = (y.debt ?? 0) + y.equity - (y.cash ?? 0);
  return v > 0 ? v : null;
};

/** ROIC de cada año: con el capital promedio del año y del anterior, si hay los dos. */
export function qualityYears(ys: YearInputs[]): QualityYear[] {
  return ys.map((y, i) => {
    const effective = y.tax !== null && y.pretax !== null && y.pretax > 0 ? y.tax / y.pretax : null;
    const usable = effective !== null && effective >= 0 && effective <= 0.5;
    const taxRate = usable ? effective : DEFAULT_TAX;
    const cap = invested(y);
    const before = i > 0 ? invested(ys[i - 1]!) : null;
    const capital = cap !== null && before !== null ? (cap + before) / 2 : cap;
    return {
      year: y.year,
      end: y.end,
      roic: y.operatingIncome !== null && capital !== null ? (y.operatingIncome * (1 - taxRate)) / capital : null,
      taxRate,
      taxAssumed: !usable,
      grossMargin: div(y.grossProfit, y.revenue),
      fcf: y.ocf !== null && y.capex !== null ? y.ocf - y.capex : null,
      revenue: y.revenue,
      netIncome: y.netIncome,
      dividends: y.dividends === null ? null : Math.abs(y.dividends),
      buybacks: y.buybacks === null ? null : Math.abs(y.buybacks),
      sbc: y.sbc,
      shares: y.shares,
    };
  });
}

/**
 * Puntaje de Piotroski del año `t` frente al anterior `p`: 9 señales de rentabilidad, solvencia y eficiencia. La
 * versión usual con datos de fin de año: ROA y rotación sobre los activos del cierre, y la deuda financiera en vez de
 * solo la de largo plazo. Una señal sin datos queda en null y no cuenta.
 */
export function piotroski(t: YearInputs, p: YearInputs): Piotroski | null {
  const roa = (y: YearInputs) => div(y.netIncome, y.assets);
  const leverage = (y: YearInputs) => (y.assets !== null && y.assets > 0 && y.debt !== null ? y.debt / y.assets : null);
  const current = (y: YearInputs) => div(y.assetsCurrent, y.liabilitiesCurrent);
  const margin = (y: YearInputs) => div(y.grossProfit, y.revenue);
  const turnover = (y: YearInputs) => div(y.revenue, y.assets);
  const up = (a: number | null, b: number | null) => (a === null || b === null ? null : a > b);
  const check = (key: PiotroskiKey, ok: boolean | null, now: number | null, prev: number | null): PiotroskiCheck => ({ key, ok, now, prev });
  const checks: PiotroskiCheck[] = [
    check('utilidad', t.netIncome === null ? null : t.netIncome > 0, roa(t), null),
    check('flujo', t.ocf === null ? null : t.ocf > 0, t.ocf, null),
    check('roa', up(roa(t), roa(p)), roa(t), roa(p)),
    check('caja', t.ocf === null || t.netIncome === null ? null : t.ocf > t.netIncome, t.ocf, t.netIncome),
    check('deuda', leverage(t) === null || leverage(p) === null ? null : leverage(t)! < leverage(p)! || leverage(t) === 0, leverage(t), leverage(p)),
    check('liquidez', up(current(t), current(p)), current(t), current(p)),
    check('acciones', t.shares === null || p.shares === null ? null : t.shares <= p.shares, t.shares, p.shares),
    check('margen', up(margin(t), margin(p)), margin(t), margin(p)),
    check('rotacion', up(turnover(t), turnover(p)), turnover(t), turnover(p)),
  ];
  const known = checks.filter((c) => c.ok !== null);
  if (known.length < 5) return null;
  return { year: t.year, prevYear: p.year, score: known.filter((c) => c.ok).length, of: known.length, checks };
}

type Found = { currency: string; values: AnnualValue[] } | null;

/** El valor de una lista de conceptos en esa fecha (el primero que lo tenga, en esa unidad). */
function pick(found: Found[], end: string, unit: string | null): number | null {
  for (const c of found) {
    if (!c || c.currency !== unit) continue;
    const v = c.values.find((x) => x.end === end);
    if (v) return v.value;
  }
  return null;
}

/** Junta, año por año, los resultados, los fundamentales y las líneas de este bloque (exportada para las pruebas). */
export function mergeQuality(fin: FinancialYear[], fund: FundYear[], currency: string | null, lines: Record<Line, Found[]>): YearInputs[] {
  return fin.slice(-YEARS).map((y) => {
    const f = fund.find((x) => x.end === y.end);
    const money = (l: Line) => pick(lines[l], y.end, currency);
    const cost = money('costOfRevenue');
    return {
      year: y.year,
      end: y.end,
      revenue: y.revenue,
      operatingIncome: y.operatingIncome,
      netIncome: y.netIncome,
      ocf: f?.ocf ?? null,
      capex: f?.capex ?? null,
      cash: f?.cash ?? null,
      debt: f?.debt ?? null,
      equity: f?.equity ?? null,
      assets: f?.assets ?? null,
      assetsCurrent: money('assetsCurrent'),
      liabilitiesCurrent: money('liabilitiesCurrent'),
      // La utilidad bruta, o las ventas menos su costo si la empresa no la informa como tal.
      grossProfit: money('grossProfit') ?? (y.revenue !== null && cost !== null ? y.revenue - cost : null),
      tax: money('tax'),
      pretax: money('pretax'),
      buybacks: money('buybacks'),
      dividends: money('dividends'),
      sbc: money('sbc'),
      shares: pick(lines.shares, y.end, 'shares'),
    };
  });
}

export async function quality(d: Deps, symbol: string): Promise<Fresh<QualityData>> {
  return cached<QualityData>(d, `secq:${symbol}`, SEC_TTL_MS, async () => {
    const fund = (await fundamentals(d, symbol)).data;
    const fin = (await financials(d, symbol)).data;
    const empty: QualityData = { symbol, cik: fin.cik, name: fin.name, standard: fin.standard, currency: fin.currency, years: [], piotroski: null };
    if (!fin.cik || !fin.standard || !fin.years.length) return empty;
    const cik = fin.cik;
    const std = fin.standard;
    const names = Object.keys(CONCEPTS[std]) as Line[];
    const tasks = names.flatMap((l) =>
      CONCEPTS[std][l].map((c) => () => companyConcept(cik, std, c, d.fetch, INSTANT.has(l) ? 'instant' : 'duration', l === 'shares' ? 'shares' : 'money')),
    );
    const results = await inBatches(tasks);
    let i = 0;
    const lines = {} as Record<Line, Found[]>;
    for (const l of names) lines[l] = CONCEPTS[std][l].map(() => results[i++]!);
    const inputs = mergeQuality(fin.years, fund.years, fin.currency, lines);
    const [p, t] = [inputs.at(-2), inputs.at(-1)];
    return { ...empty, years: qualityYears(inputs), piotroski: t && p && t.year - p.year === 1 ? piotroski(t, p) : null };
  });
}
