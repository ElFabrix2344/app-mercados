// Historia financiera desde la SEC (dominio público: también la ven los amigos): ingresos, utilidad operativa y
// utilidad neta de los últimos años, de los informes anuales (10-K de las empresas de EE. UU.; 20-F y 40-F de las
// extranjeras, como Buenaventura o Credicorp). Desde el 9 nov, también los trimestres de los 10-Q y los últimos 12
// meses, para que la ficha no dependa de un informe anual de hace hasta un año (las de 20-F siguen anuales: no
// presentan trimestres con datos). Se guarda 7 días por símbolo (`sec:<símbolo>`), también cuando la SEC no tiene la
// empresa, para no buscarla de nuevo en cada visita.

import { addDays, isoDate } from '../lib/num';
import { contiguous, quarterValues } from '../lib/quarters';
import { companyConcept, findCik, sharesOutstanding, type AnnualValue, type PeriodValue } from '../lib/sec';
import { cached, type Deps, type Fresh } from './market';

export const SEC_TTL_MS = 7 * 24 * 3_600_000;
/** Años que se muestran. */
export const SEC_YEARS = 12;
/** Trimestres que se guardan: 3 años, para el gráfico y para comparar con el mismo trimestre del año anterior. */
export const SEC_QUARTERS = 12;
/** Portadas que se guardan (para el P/S de cada año fiscal). */
const SHARES_KEPT = 24;

/**
 * Acciones comunes por ADR de los emisores extranjeros que cotizan con ADR, cuando no es 1 (la portada del 20-F cuenta
 * acciones ordinarias). Cementos Pacasmayo: 1 ADS = 5 acciones comunes (prospecto F-1 de 2012 y avisos de dividendos).
 */
export const ADR_RATIO: Record<string, number> = { CPAC: 5 };

export type Standard = 'us-gaap' | 'ifrs-full';
type Line = 'revenue' | 'operatingIncome' | 'netIncome';
const LINES: Line[] = ['revenue', 'operatingIncome', 'netIncome'];

/**
 * Conceptos XBRL de cada línea, en orden de preferencia. Cada empresa (y cada época) usa nombres distintos, así que
 * se juntan año por año: Apple reportó sus ventas como SalesRevenueNet hasta 2017 y después con otro nombre.
 */
const CONCEPTS: Record<Standard, Record<Line, string[]>> = {
  'us-gaap': {
    revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
    operatingIncome: ['OperatingIncomeLoss'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  },
  'ifrs-full': {
    revenue: ['Revenue'],
    operatingIncome: ['ProfitLossFromOperatingActivities'],
    netIncome: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
  },
};

export interface FinancialYear {
  /** Año fiscal: el del cierre del ejercicio (un cierre en los primeros días de enero cuenta para el año anterior). */
  year: number;
  /** Último día del ejercicio. */
  end: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
}

/** Un trimestre suelto o los últimos 12 meses: las mismas tres líneas que un año. */
export interface FinancialPeriod {
  start: string;
  end: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
}

export interface FinancialsData {
  symbol: string;
  /** null si la SEC no tiene la empresa (ETF, fondos, empresas que no cotizan en EE. UU.). */
  cik: number | null;
  name: string | null;
  standard: Standard | null;
  /** Moneda de los informes (USD, PEN…). */
  currency: string | null;
  /** Del más viejo al más nuevo, hasta SEC_YEARS. */
  years: FinancialYear[];
  /** Acciones en circulación de la portada de cada informe (para el P/S), de la más vieja a la más nueva. */
  shares: { date: string; value: number }[];
  /** Emisor extranjero (20-F o 40-F): sus acciones son ordinarias, y un ADR puede valer varias. */
  foreign: boolean;
  /** Acciones por ADR, si se sabe (1 si cotiza directo). */
  adrRatio: number;
  /**
   * Trimestres sueltos de los 10-Q (el cuarto sale del informe anual), del más viejo al más nuevo, hasta SEC_QUARTERS.
   * Vacío si la empresa solo presenta informes anuales (20-F, 40-F) o si sus trimestres son más viejos que su último año.
   */
  quarters: FinancialPeriod[];
  /** Los últimos 12 meses (los cuatro trimestres más nuevos); null si no hay cuatro seguidos. */
  ttm: FinancialPeriod | null;
  /** Los 12 meses anteriores a esos, para comparar. */
  ttmPrev: FinancialPeriod | null;
}

const empty = (symbol: string): FinancialsData => ({
  symbol,
  cik: null,
  name: null,
  standard: null,
  currency: null,
  years: [],
  shares: [],
  foreign: false,
  adrRatio: 1,
  quarters: [],
  ttm: null,
  ttmPrev: null,
});

/** Los ejercicios de 52 o 53 semanas pueden cerrar en los primeros días de enero: cuentan para el año anterior. */
export const fiscalYear = (end: string) => Number(addDays(end, -7).slice(0, 4));

type Found = { currency: string; values: AnnualValue[]; periods?: PeriodValue[] } | null;

/** Junta los conceptos de cada línea año por año (manda el primero de la lista que tenga el año), en una sola moneda. */
export function mergeLines(found: Record<Line, Found[]>): { currency: string | null; years: FinancialYear[] } {
  const currency = LINES.flatMap((l) => found[l]).find((c) => c !== null)?.currency ?? null;
  const rows = new Map<string, FinancialYear>();
  for (const line of LINES) {
    for (const c of found[line]) {
      if (!c || c.currency !== currency) continue;
      for (const v of c.values) {
        const row = rows.get(v.end) ?? { year: fiscalYear(v.end), end: v.end, revenue: null, operatingIncome: null, netIncome: null };
        if (row[line] === null) row[line] = v.value;
        rows.set(v.end, row);
      }
    }
  }
  // Un ejercicio por año (si la empresa cambió su fecha de cierre, queda el más nuevo).
  const byYear = new Map<number, FinancialYear>();
  for (const r of [...rows.values()].sort((a, b) => (a.end < b.end ? -1 : 1))) byYear.set(r.year, r);
  return { currency, years: [...byYear.values()].slice(-SEC_YEARS) };
}

/**
 * Junta los trimestres sueltos de cada línea (manda el primer concepto que tenga ese trimestre), en la moneda de los
 * años. Quedan los últimos SEC_QUARTERS.
 */
export function mergeQuarters(found: Record<Line, Found[]>, currency: string | null): FinancialPeriod[] {
  const rows = new Map<string, FinancialPeriod>();
  for (const line of LINES) {
    for (const c of found[line]) {
      if (!c || c.currency !== currency || !c.periods?.length) continue;
      for (const q of quarterValues(c.periods)) {
        const row = rows.get(q.end) ?? { start: q.start, end: q.end, revenue: null, operatingIncome: null, netIncome: null };
        if (row[line] === null) row[line] = q.value;
        rows.set(q.end, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => (a.end < b.end ? -1 : 1)).slice(-SEC_QUARTERS);
}

/** Suma de cuatro trimestres seguidos (12 meses); una línea queda en null si le falta en alguno. null si no son seguidos. */
export function sumQuarters(four: FinancialPeriod[]): FinancialPeriod | null {
  if (!contiguous(four)) return null;
  const sum = (line: Line) => (four.every((q) => q[line] !== null) ? four.reduce((s, q) => s + q[line]!, 0) : null);
  return { start: four[0]!.start, end: four[3]!.end, revenue: sum('revenue'), operatingIncome: sum('operatingIncome'), netIncome: sum('netIncome') };
}

/**
 * Resultados anuales y trimestrales de un símbolo (acciones de EE. UU. y extranjeras que reportan a la SEC) y sus
 * acciones en circulación. Lo guardado antes del 9 nov no traía los trimestres: se renueva una vez.
 */
export async function financials(d: Deps, symbol: string): Promise<Fresh<FinancialsData>> {
  return cached<FinancialsData>(d, `sec:${symbol}`, SEC_TTL_MS, async () => {
    const company = await findCik(symbol, d.fetch);
    if (!company) return empty(symbol);
    // Hasta 6 pedidos a la vez: la SEC pide no pasar de 10 por segundo.
    const read = async (standard: Standard) => {
      const lines = await Promise.all(LINES.map((l) => Promise.all(CONCEPTS[standard][l].map((c) => companyConcept(company.cik, standard, c, d.fetch)))));
      const found = Object.fromEntries(LINES.map((l, i) => [l, lines[i]!])) as Record<Line, Found[]>;
      return { ...mergeLines(found), found };
    };
    let standard: Standard = 'us-gaap';
    let merged = await read(standard);
    // Las extranjeras con NIIF (o las que dejaron los US GAAP hace más de dos años) reportan con la otra taxonomía.
    const last = merged.years.at(-1)?.end;
    if (!last || last < addDays(isoDate(d.now), -730)) {
      const ifrs = await read('ifrs-full');
      const lastIfrs = ifrs.years.at(-1)?.end;
      if (lastIfrs && (!last || lastIfrs > last)) {
        merged = ifrs;
        standard = 'ifrs-full';
      }
    }
    const shares = (await sharesOutstanding(company.cik, d.fetch)).slice(-SHARES_KEPT);
    const lastForm = shares.at(-1)?.form ?? '';
    // Trimestres más viejos que el último año (una empresa que dejó de presentar 10-Q) no sirven para «al día».
    const all = mergeQuarters(merged.found, merged.currency);
    const lastYearEnd = merged.years.at(-1)?.end ?? '';
    const quarters = all.length && all.at(-1)!.end >= lastYearEnd ? all : [];
    return {
      symbol,
      cik: company.cik,
      name: company.name,
      standard: merged.years.length ? standard : null,
      currency: merged.currency,
      years: merged.years,
      shares: shares.map(({ date, value }) => ({ date, value })),
      foreign: standard === 'ifrs-full' || /^(20|40)-F/.test(lastForm),
      adrRatio: ADR_RATIO[symbol] ?? 1,
      quarters,
      ttm: sumQuarters(quarters.slice(-4)),
      ttmPrev: sumQuarters(quarters.slice(-8, -4)),
    };
  }, { valid: (x) => Array.isArray(x.shares) && Array.isArray(x.quarters) });
}
