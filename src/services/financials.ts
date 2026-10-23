// Historia financiera desde la SEC (dominio público: también la ven los amigos): ingresos, utilidad operativa y
// utilidad neta de los últimos años, de los informes anuales (10-K de las empresas de EE. UU.; 20-F y 40-F de las
// extranjeras, como Southern Copper, Buenaventura o Credicorp). Se guarda 7 días por símbolo (`sec:<símbolo>`),
// también cuando la SEC no tiene la empresa, para no buscarla de nuevo en cada visita.

import { addDays, isoDate } from '../lib/num';
import { companyConcept, findCik, type AnnualValue } from '../lib/sec';
import { cached, type Deps, type Fresh } from './market';

export const SEC_TTL_MS = 7 * 24 * 3_600_000;
/** Años que se muestran. */
export const SEC_YEARS = 12;

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
}

/** Los ejercicios de 52 o 53 semanas pueden cerrar en los primeros días de enero: cuentan para el año anterior. */
export const fiscalYear = (end: string) => Number(addDays(end, -7).slice(0, 4));

type Found = { currency: string; values: AnnualValue[] } | null;

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

/** Resultados anuales de un símbolo (acciones de EE. UU. y extranjeras que reportan a la SEC). */
export async function financials(d: Deps, symbol: string): Promise<Fresh<FinancialsData>> {
  return cached<FinancialsData>(d, `sec:${symbol}`, SEC_TTL_MS, async () => {
    const company = await findCik(symbol, d.fetch);
    if (!company) return { symbol, cik: null, name: null, standard: null, currency: null, years: [] };
    // Hasta 6 pedidos a la vez: la SEC pide no pasar de 10 por segundo.
    const read = async (standard: Standard) => {
      const lines = await Promise.all(LINES.map((l) => Promise.all(CONCEPTS[standard][l].map((c) => companyConcept(company.cik, standard, c, d.fetch)))));
      return mergeLines(Object.fromEntries(LINES.map((l, i) => [l, lines[i]!])) as Record<Line, Found[]>);
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
    return { symbol, cik: company.cik, name: company.name, standard: merged.years.length ? standard : null, currency: merged.currency, years: merged.years };
  });
}
