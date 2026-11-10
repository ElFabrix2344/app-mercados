// Para los ratios y el DCF de la ficha (pedido del usuario el 4 nov, «añade las estrellas»): flujo de caja operativo,
// inversión en activo fijo, depreciación, caja, deuda, patrimonio y activos de cada año fiscal, de la SEC (dominio
// público). Va aparte de los resultados (`sec:`), que también usan el P/S y valorar_ps con varias empresas a la vez:
// así cada pedido queda lejos del límite de 50 consultas del plan gratis. Se piden al abrir el bloque (unas 16
// consultas, de a 6) y se guardan 7 días (`secx:`). Desde el 9 nov trae también lo más nuevo (`latest`): los flujos de
// los últimos 12 meses y el balance del último trimestre, con las mismas consultas.

import { quarterValues, trailingSum } from '../lib/quarters';
import { companyConcept, type AnnualValue, type PeriodValue } from '../lib/sec';
import { financials, fiscalYear, SEC_TTL_MS, type Standard } from './financials';
import { cached, type Deps, type Fresh } from './market';

type Line = 'ocf' | 'capex' | 'da' | 'cash' | 'equity' | 'assets';
const INSTANT = new Set<Line>(['cash', 'equity', 'assets']);
/** Años que se guardan (los de los resultados más nuevos). */
const YEARS = 6;

/** Conceptos de cada línea, en orden de preferencia: manda el primero que tenga el año. */
const CONCEPTS: Record<Standard, Record<Line, string[]>> = {
  'us-gaap': {
    ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    da: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization'],
    cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    assets: ['Assets'],
  },
  'ifrs-full': {
    ocf: ['CashFlowsFromUsedInOperatingActivities'],
    capex: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'PurchaseOfPropertyPlantAndEquipment'],
    da: ['DepreciationAndAmortisationExpense', 'DepreciationExpense'],
    cash: ['CashAndCashEquivalents'],
    equity: ['EquityAttributableToOwnersOfParent', 'Equity'],
    assets: ['Assets'],
  },
};

/**
 * Deuda financiera: la total de largo plazo (con su parte corriente) o, si no la informa, sus dos partes; más los
 * préstamos y papeles comerciales de corto plazo.
 */
const DEBT: Record<Standard, { total: string[]; parts: string[]; short: string[] }> = {
  'us-gaap': { total: ['LongTermDebt'], parts: ['LongTermDebtNoncurrent', 'LongTermDebtCurrent'], short: ['ShortTermBorrowings', 'CommercialPaper'] },
  'ifrs-full': { total: ['Borrowings'], parts: ['NoncurrentBorrowings', 'CurrentBorrowings'], short: [] },
};

export interface FundYear {
  year: number;
  end: string;
  /** Flujo de caja de las operaciones. */
  ocf: number | null;
  /** Inversión en activo fijo (positiva: lo que se pagó). */
  capex: number | null;
  /** Depreciación y amortización. */
  da: number | null;
  cash: number | null;
  debt: number | null;
  equity: number | null;
  assets: number | null;
}

export interface FundamentalsData {
  symbol: string;
  cik: number | null;
  standard: Standard | null;
  currency: string | null;
  /** Los años fiscales de los resultados (hasta 6), del más viejo al más nuevo. */
  years: FundYear[];
  /**
   * Lo más nuevo, con la forma de un año: los flujos de los últimos 12 meses y el balance al cierre del último
   * trimestre (`end`, el mismo de los resultados). null si la empresa no presenta trimestres (20-F).
   */
  latest: FundYear | null;
}

type Found = { currency: string; values: AnnualValue[]; periods?: PeriodValue[]; balances?: AnnualValue[] } | null;

/** De a 6 a la vez: la SEC pide no pasar de 10 por segundo. */
export async function inBatches<T>(tasks: (() => Promise<T>)[], size = 6): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += size) out.push(...(await Promise.all(tasks.slice(i, i + size).map((t) => t()))));
  return out;
}

/** El valor de una lista de conceptos en esa fecha (el primero que lo tenga, en la moneda del informe). */
function pick(found: Found[], end: string, currency: string | null): number | null {
  for (const c of found) {
    if (!c || c.currency !== currency) continue;
    const v = c.values.find((x) => x.end === end);
    if (v) return v.value;
  }
  return null;
}

/** Arma los años con lo que trajo cada concepto (exportada para las pruebas). */
export function mergeFundamentals(
  ends: { year: number; end: string }[],
  currency: string | null,
  lines: Record<Line, Found[]>,
  debt: { total: Found[]; parts: Found[]; short: Found[] },
): FundYear[] {
  return ends.map(({ year, end }) => {
    const total = pick(debt.total, end, currency);
    const parts = debt.parts.map((c) => pick([c], end, currency));
    const long = total ?? (parts.some((p) => p !== null) ? parts.reduce<number>((s, p) => s + (p ?? 0), 0) : null);
    const short = debt.short.map((c) => pick([c], end, currency)).filter((v): v is number => v !== null);
    const capex = pick(lines.capex, end, currency);
    return {
      year,
      end,
      ocf: pick(lines.ocf, end, currency),
      capex: capex === null ? null : Math.abs(capex),
      da: pick(lines.da, end, currency),
      cash: pick(lines.cash, end, currency),
      debt: long === null && !short.length ? null : (long ?? 0) + short.reduce((s, v) => s + v, 0),
      equity: pick(lines.equity, end, currency),
      assets: pick(lines.assets, end, currency),
    };
  });
}

export async function fundamentals(d: Deps, symbol: string): Promise<Fresh<FundamentalsData>> {
  return cached<FundamentalsData>(d, `secx:${symbol}`, SEC_TTL_MS, async () => {
    const fin = (await financials(d, symbol)).data;
    const empty: FundamentalsData = { symbol, cik: fin.cik, standard: fin.standard, currency: fin.currency, years: [], latest: null };
    if (!fin.cik || !fin.standard) return empty;
    const cik = fin.cik;
    const std = fin.standard;
    const ends = fin.years.slice(-YEARS).map(({ year, end }) => ({ year, end }));
    if (!ends.length) return empty;
    const lineNames = Object.keys(CONCEPTS[std]) as Line[];
    const debtNames = [...DEBT[std].total, ...DEBT[std].parts, ...DEBT[std].short];
    const tasks = [
      ...lineNames.flatMap((l) => CONCEPTS[std][l].map((c) => () => companyConcept(cik, std, c, d.fetch, INSTANT.has(l) ? 'instant' : 'duration'))),
      ...debtNames.map((c) => () => companyConcept(cik, std, c, d.fetch, 'instant')),
    ];
    const results = await inBatches(tasks);
    let i = 0;
    const lines = {} as Record<Line, Found[]>;
    for (const l of lineNames) lines[l] = CONCEPTS[std][l].map(() => results[i++]!);
    const take = (n: number) => results.slice(i, (i += n));
    const debt = { total: take(DEBT[std].total.length), parts: take(DEBT[std].parts.length), short: take(DEBT[std].short.length) };
    return { ...empty, years: mergeFundamentals(ends, fin.currency, lines, debt), latest: latestRow(fin.ttm?.end ?? null, fin.currency, lines, debt) };
  }, { valid: (x) => 'latest' in x });
}

/**
 * La fila de lo más nuevo: en cada flujo, la suma de los cuatro trimestres que terminan en `end`; en cada saldo, el
 * del balance de ese día (también de un 10-Q). Se arma igual que un año (exportada para las pruebas).
 */
export function latestRow(
  end: string | null,
  currency: string | null,
  lines: Record<Line, Found[]>,
  debt: { total: Found[]; parts: Found[]; short: Found[] },
): FundYear | null {
  if (!end) return null;
  const flow = (c: Found): Found => {
    const sum = c ? trailingSum(quarterValues(c.periods ?? []), end) : null;
    return c && sum !== null ? { currency: c.currency, values: [{ end, value: sum }] } : null;
  };
  const balance = (c: Found): Found => (c ? { currency: c.currency, values: c.balances ?? [] } : null);
  const now = {} as Record<Line, Found[]>;
  for (const l of Object.keys(lines) as Line[]) now[l] = lines[l].map(INSTANT.has(l) ? balance : flow);
  const debtNow = { total: debt.total.map(balance), parts: debt.parts.map(balance), short: debt.short.map(balance) };
  return mergeFundamentals([{ year: fiscalYear(end), end }], currency, now, debtNow)[0] ?? null;
}
