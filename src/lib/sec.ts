// SEC EDGAR (gratis y de dominio público): resultados anuales de las empresas que reportan en EE. UU. (10-K) o como
// emisores extranjeros (20-F, 40-F). La empresa se busca por su ticker con el buscador de EDGAR y se leen pocos
// conceptos XBRL con `companyconcept` (respuestas chicas): `companyfacts` pesa varios MB y no entra en los 10 ms de
// procesador del plan gratis. www.sec.gov rechaza a quien no se identifica con un correo: estos dos servicios no.

import { ApiError } from './http';

const HEADERS = { 'User-Agent': 'Rueda (proyecto personal de estudio)', Accept: 'application/json' };

async function secJson(url: string, f: typeof fetch): Promise<unknown | null> {
  let res: Response;
  try {
    res = await f(url, { headers: HEADERS });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `La SEC no respondió: ${(e as Error).message}`, 'sec');
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'La SEC pidió esperar: demasiados pedidos.', 'sec');
  if (!res.ok) throw new ApiError('upstream_error', 502, `La SEC respondió HTTP ${res.status}.`, 'sec');
  return res.json().catch(() => {
    throw new ApiError('bad_response', 502, 'La SEC respondió algo que no es JSON.', 'sec');
  });
}

/** La SEC escribe las clases de acciones con guion (BRK-B); Twelve Data, con punto (BRK.B). */
export const secTicker = (symbol: string) => symbol.trim().toUpperCase().replace(/\./g, '-');

/** Código CIK y nombre de la empresa con ese ticker exacto; null si no reporta a la SEC (ETF, fondos, cripto…). */
export async function findCik(symbol: string, f: typeof fetch = fetch): Promise<{ cik: number; name: string } | null> {
  const ticker = secTicker(symbol);
  const body = (await secJson(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(ticker)}`, f)) as {
    hits?: { hits?: { _id?: string; _source?: { tickers?: string; entity?: string } }[] };
  } | null;
  for (const hit of body?.hits?.hits ?? []) {
    const tickers = (hit._source?.tickers ?? '').toUpperCase().split(/[\s,]+/);
    const cik = Number(hit._id);
    if (tickers.includes(ticker) && Number.isInteger(cik) && cik > 0) {
      // «SOUTHERN COPPER CORP/ (SCCO)» → «SOUTHERN COPPER CORP»
      const name = (hit._source?.entity ?? ticker).replace(/\s*\([^)]*\)\s*$/, '').replace(/\/$/, '').trim();
      return { cik, name };
    }
  }
  return null;
}

export interface AnnualValue {
  /** Último día del ejercicio. */
  end: string;
  value: number;
}

interface Fact {
  start?: string;
  end?: string;
  val?: number;
  form?: string;
  filed?: string;
  /** Número del informe: dos valores con la misma fecha en el mismo informe son dos clases de acciones. */
  accn?: string;
}

const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);

/**
 * Valores anuales de un concepto: solo informes anuales y periodos de ~1 año. Un mismo año aparece en varios informes
 * (como comparación o corregido): queda el del informe más nuevo.
 */
export function annualValues(facts: Fact[]): AnnualValue[] {
  const byEnd = new Map<string, { value: number; filed: string }>();
  for (const x of facts) {
    if (!x.form || !ANNUAL_FORMS.has(x.form) || !x.start || !x.end || typeof x.val !== 'number') continue;
    const days = (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000;
    if (days < 350 || days > 380) continue;
    const prev = byEnd.get(x.end);
    if (!prev || (x.filed ?? '') >= prev.filed) byEnd.set(x.end, { value: x.val, filed: x.filed ?? '' });
  }
  return [...byEnd.entries()].map(([end, v]) => ({ end, value: v.value })).sort((a, b) => (a.end < b.end ? -1 : 1));
}

export interface ShareCount {
  /** Fecha a la que la portada cuenta las acciones. */
  date: string;
  value: number;
  /** Formulario del informe (10-K, 10-Q, 20-F…). */
  form: string;
}

/**
 * Acciones en circulación de la portada de cada informe (dei:EntityCommonStockSharesOutstanding), de la más vieja a la
 * más nueva. Si un mismo informe trae varias para la misma fecha, son clases distintas (A, B, C) y se suman. En los
 * emisores extranjeros (20-F) son acciones ordinarias: un ADR puede valer varias.
 */
export function shareCounts(facts: Fact[]): ShareCount[] {
  // Por informe y fecha, la suma de sus clases.
  const byFiling = new Map<string, { date: string; value: number; filed: string; form: string; seen: Set<number> }>();
  for (const x of facts) {
    if (!x.end || typeof x.val !== 'number' || x.val <= 0) continue;
    const k = `${x.accn ?? x.filed ?? ''}|${x.end}`;
    const prev = byFiling.get(k);
    if (!prev) byFiling.set(k, { date: x.end, value: x.val, filed: x.filed ?? '', form: x.form ?? '', seen: new Set([x.val]) });
    else if (!prev.seen.has(x.val)) {
      prev.seen.add(x.val);
      prev.value += x.val;
    }
  }
  // Por fecha, la del informe más nuevo (una corrección reemplaza a la original).
  const byDate = new Map<string, { value: number; filed: string; form: string }>();
  for (const v of byFiling.values()) {
    const prev = byDate.get(v.date);
    if (!prev || v.filed >= prev.filed) byDate.set(v.date, { value: v.value, filed: v.filed, form: v.form });
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, value: v.value, form: v.form })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function sharesOutstanding(cik: number, f: typeof fetch = fetch): Promise<ShareCount[]> {
  const id = String(cik).padStart(10, '0');
  const body = (await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/dei/EntityCommonStockSharesOutstanding.json`, f)) as {
    units?: Record<string, Fact[]>;
  } | null;
  return shareCounts(body?.units?.shares ?? []);
}

/**
 * Saldos a una fecha (caja, deuda, patrimonio, activos) de los informes anuales: no tienen inicio, solo la fecha del
 * balance. El balance trae también el del año anterior: queda el del informe más nuevo para cada fecha.
 */
export function instantValues(facts: Fact[]): AnnualValue[] {
  const byEnd = new Map<string, { value: number; filed: string }>();
  for (const x of facts) {
    if (!x.form || !ANNUAL_FORMS.has(x.form) || x.start || !x.end || typeof x.val !== 'number') continue;
    const prev = byEnd.get(x.end);
    if (!prev || (x.filed ?? '') >= prev.filed) byEnd.set(x.end, { value: x.val, filed: x.filed ?? '' });
  }
  return [...byEnd.entries()].map(([end, v]) => ({ end, value: v.value })).sort((a, b) => (a.end < b.end ? -1 : 1));
}

/**
 * Un concepto XBRL de la empresa en su moneda (USD, PEN…); null si no lo reporta. `instant` para los saldos del
 * balance; si no, los valores de cada año (ingresos, flujos).
 */
export async function companyConcept(
  cik: number,
  taxonomy: 'us-gaap' | 'ifrs-full',
  concept: string,
  f: typeof fetch = fetch,
  kind: 'duration' | 'instant' = 'duration',
): Promise<{ currency: string; values: AnnualValue[] } | null> {
  const id = String(cik).padStart(10, '0');
  const body = (await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/${taxonomy}/${concept}.json`, f)) as {
    units?: Record<string, Fact[]>;
  } | null;
  // La unidad monetaria es un código de 3 letras (las de por acción vienen como «USD/shares»).
  const unit = Object.keys(body?.units ?? {}).find((u) => /^[A-Z]{3}$/.test(u));
  if (!unit) return null;
  const values = kind === 'instant' ? instantValues(body!.units![unit]!) : annualValues(body!.units![unit]!);
  return values.length ? { currency: unit, values } : null;
}
