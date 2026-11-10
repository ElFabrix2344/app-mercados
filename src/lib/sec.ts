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

/** Twelve Data escribe las clases con punto: BRK-B de la SEC es BRK.B. */
export const fromSecTicker = (ticker: string) => ticker.trim().toUpperCase().replace(/-/g, '.');

/** «SOUTHERN COPPER CORP/ (SCCO)» → «SOUTHERN COPPER CORP»; también sin el estado o el «ADR» del final («CORP /DE/»). */
export const entityName = (entity: string, fallback: string) =>
  entity
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*\/(?:[A-Z]{2,4}\/?)?$/, '')
    .trim() || fallback;

interface SearchBody {
  hits?: { hits?: { _id?: string; _source?: { tickers?: string | null; entity?: string | null } }[] };
}

const searchIndex = (q: string, f: typeof fetch) =>
  secJson(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`, f) as Promise<SearchBody | null>;

/** Código CIK y nombre de la empresa con ese ticker exacto; null si no reporta a la SEC (ETF, fondos, cripto…). */
export async function findCik(symbol: string, f: typeof fetch = fetch): Promise<{ cik: number; name: string } | null> {
  const ticker = secTicker(symbol);
  const body = await searchIndex(ticker, f);
  for (const hit of body?.hits?.hits ?? []) {
    const tickers = (hit._source?.tickers ?? '').toUpperCase().split(/[\s,]+/);
    const cik = Number(hit._id);
    if (tickers.includes(ticker) && Number.isInteger(cik) && cik > 0) return { cik, name: entityName(hit._source?.entity ?? '', ticker) };
  }
  return null;
}

export interface SecMatch {
  /** Como lo escribe Twelve Data (BRK.B). */
  symbol: string;
  name: string;
  cik: number;
}

/** Lo que se puede escribir en el buscador: nombres y símbolos (Coca Cola, BRK.B, AT&T). */
export const SEARCH_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'/-]{0,39}$/u;
const TICKER_RE = /^[A-Z0-9]{1,6}(-[A-Z]{1,2})?$/;
/** Preferentes, warrants, unidades y derechos (BAC-PL, VAL-WT, SCE-PN): el plan gratis de Twelve Data no los trae. */
const NOT_COMMON = /-(P[A-Z]?|W[ST]?|U|R)$/;

/**
 * Empresas del buscador de EDGAR que cotizan (las que traen ticker), en su orden, hasta `max`. De cada una va su ticker
 * principal (el primero que lista la SEC, o el que se escribió si es otro de los suyos, como GOOGL) y sus otras clases
 * de acciones (BRK.A). Las preferentes, warrants y unidades no van, salvo que se escriban tal cual: llenarían la lista.
 */
export function parseSearch(body: SearchBody | null, typed: string, max = 8): SecMatch[] {
  const exact = secTicker(typed);
  const out: SecMatch[] = [];
  for (const hit of body?.hits?.hits ?? []) {
    const cik = Number(hit._id);
    const tickers = (hit._source?.tickers ?? '').toUpperCase().split(/[\s,]+/).filter((t) => TICKER_RE.test(t));
    if (!Number.isInteger(cik) || cik <= 0 || !tickers.length) continue;
    const main = tickers.includes(exact) ? exact : tickers[0]!;
    if (main !== exact && NOT_COMMON.test(main)) continue;
    const base = main.replace(/-[A-Z]$/, '');
    const classes = tickers.filter((t) => t !== main && t.startsWith(`${base}-`) && /^-[A-OQSTV-Z]$/.test(t.slice(base.length)));
    const name = entityName(hit._source?.entity ?? '', main);
    for (const t of [main, ...classes]) {
      const symbol = fromSecTicker(t);
      if (out.length < max && !out.some((m) => m.symbol === symbol)) out.push({ symbol, name, cik });
    }
  }
  return out;
}

/**
 * Buscador de EDGAR por nombre o ticker: «southern» encuentra SCCO y «credicorp», BAP. Dos arreglos para que encuentre
 * más: los tickers con punto se buscan con guion (BRK.B → BRK-B) y, si un nombre con espacios no encuentra nada, se
 * prueba junto («mercado libre» → MERCADOLIBRE).
 */
export async function searchCompanies(q: string, f: typeof fetch = fetch, max = 8): Promise<SecMatch[]> {
  const typed = q.trim().replace(/\s+/g, ' ');
  const query = /^[A-Za-z0-9]{1,6}\.[A-Za-z]{1,2}$/.test(typed) ? secTicker(typed) : typed;
  const found = parseSearch(await searchIndex(query, f), typed, max);
  if (found.length || !query.includes(' ')) return found;
  return parseSearch(await searchIndex(query.replace(/ /g, ''), f), typed, max);
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

export interface PeriodValue {
  start: string;
  end: string;
  value: number;
}

/** Informes con cifras de un periodo: los anuales y los trimestrales (10-Q). */
const PERIOD_FORMS = new Set([...ANNUAL_FORMS, '10-Q', '10-Q/A']);

/**
 * Todos los periodos de un concepto en los informes anuales y trimestrales: años, trimestres y acumulados del año
 * (6 y 9 meses). Uno por (inicio, fin): el del informe más nuevo. De aquí salen los trimestres sueltos y los últimos
 * 12 meses (lib/quarters.ts).
 */
export function periodValues(facts: Fact[]): PeriodValue[] {
  const byKey = new Map<string, PeriodValue & { filed: string }>();
  for (const x of facts) {
    if (!x.form || !PERIOD_FORMS.has(x.form) || !x.start || !x.end || typeof x.val !== 'number') continue;
    const k = `${x.start}|${x.end}`;
    const prev = byKey.get(k);
    if (!prev || (x.filed ?? '') >= prev.filed) byKey.set(k, { start: x.start, end: x.end, value: x.val, filed: x.filed ?? '' });
  }
  return [...byKey.values()]
    .map(({ start, end, value }) => ({ start, end, value }))
    .sort((a, b) => (a.end !== b.end ? (a.end < b.end ? -1 : 1) : a.start < b.start ? -1 : 1));
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
  return balancesOf(facts, ANNUAL_FORMS);
}

/** Saldos de todos los balances, también los de los informes trimestrales (para el dato más nuevo). */
export function balanceValues(facts: Fact[]): AnnualValue[] {
  return balancesOf(facts, PERIOD_FORMS);
}

function balancesOf(facts: Fact[], forms: Set<string>): AnnualValue[] {
  const byEnd = new Map<string, { value: number; filed: string }>();
  for (const x of facts) {
    if (!x.form || !forms.has(x.form) || x.start || !x.end || typeof x.val !== 'number') continue;
    const prev = byEnd.get(x.end);
    if (!prev || (x.filed ?? '') >= prev.filed) byEnd.set(x.end, { value: x.val, filed: x.filed ?? '' });
  }
  return [...byEnd.entries()].map(([end, v]) => ({ end, value: v.value })).sort((a, b) => (a.end < b.end ? -1 : 1));
}

export interface ConceptData {
  /** Moneda (USD, PEN…) o «shares» si se pidió un concepto que cuenta acciones. */
  currency: string;
  /** Los valores de cada año fiscal o, en un saldo, los de los balances anuales. */
  values: AnnualValue[];
  /** En un flujo: todos sus periodos de los informes anuales y trimestrales (años, trimestres y acumulados). */
  periods: PeriodValue[];
  /** En un saldo: los de todos los balances, también los trimestrales. */
  balances: AnnualValue[];
}

/**
 * Un concepto XBRL de la empresa en su moneda (USD, PEN…); null si no lo reporta. `instant` para los saldos del
 * balance; si no, los valores de cada periodo (ingresos, flujos). Con `unit: 'shares'`, los conceptos que cuentan
 * acciones (el promedio diluido del año).
 */
export async function companyConcept(
  cik: number,
  taxonomy: 'us-gaap' | 'ifrs-full',
  concept: string,
  f: typeof fetch = fetch,
  kind: 'duration' | 'instant' = 'duration',
  unitKind: 'money' | 'shares' = 'money',
): Promise<ConceptData | null> {
  const id = String(cik).padStart(10, '0');
  const body = (await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/${taxonomy}/${concept}.json`, f)) as {
    units?: Record<string, Fact[]>;
  } | null;
  // La unidad monetaria es un código de 3 letras (las de por acción vienen como «USD/shares»).
  const unit = Object.keys(body?.units ?? {}).find((u) => (unitKind === 'shares' ? u === 'shares' : /^[A-Z]{3}$/.test(u)));
  if (!unit) return null;
  const facts = body!.units![unit]!;
  const data: ConceptData =
    kind === 'instant'
      ? { currency: unit, values: instantValues(facts), periods: [], balances: balanceValues(facts) }
      : { currency: unit, values: annualValues(facts), periods: periodValues(facts), balances: [] };
  return data.values.length || data.periods.length || data.balances.length ? data : null;
}

// ---------- reportes presentados (submissions) ----------

/** Qué es cada reporte, para agruparlo en la ficha. */
export type FilingKind = 'anual' | 'trimestral' | 'evento' | 'junta' | 'tarde';

/** Los formularios que se muestran (sus correcciones, «/A», también). Lo demás es ruido: prospectos, cartas, anexos. */
const FILING_KINDS: Record<string, FilingKind> = {
  '10-K': 'anual',
  '20-F': 'anual',
  '40-F': 'anual',
  '10-Q': 'trimestral',
  '8-K': 'evento',
  '6-K': 'evento',
  'DEF 14A': 'junta',
  'NT 10-K': 'tarde',
  'NT 10-Q': 'tarde',
  'NT 20-F': 'tarde',
};

export interface Filing {
  /** Formulario tal como lo presenta la SEC (10-K, 8-K/A…). */
  form: string;
  kind: FilingKind;
  /** Día en que se presentó. */
  date: string;
  /** Periodo que cubre: el cierre del año o del trimestre; en un 8-K, el día del hecho. */
  period: string | null;
  /** Temas de un 8-K («2.02» son resultados, «5.02» cambios de directivos…), sin el de anexos. */
  items: string[];
  /** El documento principal en sec.gov (lo abre el navegador de quien mira). */
  url: string;
}

export interface SecCompany {
  name: string;
  /** Rubro según la SEC (su código SIC), en inglés. */
  industry: string | null;
  /** Mes y día en que cierra su año fiscal («1231»). */
  fiscalYearEnd: string | null;
  website: string | null;
  exchanges: string[];
}

export interface Submissions {
  company: SecCompany;
  /** Del más nuevo al más viejo. */
  filings: Filing[];
  /** Avisos de compras y ventas de directivos (formulario 4): cuántos en 90 días y en un año, y el último. */
  insiders: { d90: number; d365: number; last: string | null };
}

interface SubmissionsBody {
  name?: string;
  sicDescription?: string;
  fiscalYearEnd?: string;
  website?: string;
  exchanges?: (string | null)[];
  filings?: { recent?: Record<string, unknown[]> };
}

/** Reportes que se guardan por empresa. */
export const FILINGS_KEPT = 30;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Enlace al documento en sec.gov; si el nombre del archivo no es de fiar, a la carpeta del reporte. */
function filingUrl(cik: number, accession: string, doc: string): string | null {
  if (!/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/`;
  return /^[\w][\w.-]*$/.test(doc) ? base + doc : base;
}

/**
 * Los reportes que importan de la lista de EDGAR (viene en columnas, del más nuevo al más viejo): anuales,
 * trimestrales, hechos (8-K y 6-K), la junta de accionistas y los avisos de que un informe llegará tarde. Quedan los
 * últimos FILINGS_KEPT y, aunque sean más viejos, los dos anuales más nuevos. Los formularios 4 solo se cuentan.
 */
export function parseSubmissions(body: SubmissionsBody, cik: number, now: Date): Submissions {
  const r = body.filings?.recent ?? {};
  const col = (name: string) => (Array.isArray(r[name]) ? (r[name] as unknown[]) : []);
  const [forms, dates, periods, items, accns, docs] = ['form', 'filingDate', 'reportDate', 'items', 'accessionNumber', 'primaryDocument'].map(col) as [unknown[], unknown[], unknown[], unknown[], unknown[], unknown[]];
  const today = now.toISOString().slice(0, 10);
  const daysAgo = (date: string) => (Date.parse(today) - Date.parse(date)) / 86_400_000;
  const filings: Filing[] = [];
  const annual: Filing[] = [];
  const insiders = { d90: 0, d365: 0, last: null as string | null };
  for (let i = 0; i < forms.length; i++) {
    const form = String(forms[i] ?? '');
    const date = String(dates[i] ?? '');
    if (!ISO_DAY.test(date)) continue;
    if (form === '4') {
      if (daysAgo(date) <= 365) insiders.d365++;
      if (daysAgo(date) <= 90) insiders.d90++;
      if (!insiders.last || date > insiders.last) insiders.last = date;
      continue;
    }
    const kind = FILING_KINDS[form.replace(/\/A$/, '')];
    const url = kind ? filingUrl(cik, String(accns[i] ?? ''), String(docs[i] ?? '')) : null;
    if (!kind || !url) continue;
    const period = String(periods[i] ?? '');
    const filing: Filing = {
      form,
      kind,
      date,
      period: ISO_DAY.test(period) ? period : null,
      items: String(items[i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d\.\d\d$/.test(s) && s !== '9.01'),
      url,
    };
    if (filings.length < FILINGS_KEPT) filings.push(filing);
    else if (kind === 'anual' && annual.length < 2) filings.push(filing);
    if (kind === 'anual') annual.push(filing);
    if (filings.length >= FILINGS_KEPT && annual.length >= 2) break;
  }
  filings.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const site = text(body.website);
  return {
    company: {
      name: text(body.name) ?? '',
      industry: text(body.sicDescription),
      fiscalYearEnd: /^\d{4}$/.test(body.fiscalYearEnd ?? '') ? body.fiscalYearEnd! : null,
      website: site && /^https?:\/\/[\w.-]+(\/[\w./-]*)?$/i.test(site) ? site : null,
      exchanges: (body.exchanges ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0),
    },
    filings,
    insiders,
  };
}

/** Lo que la empresa presentó a la SEC (unos 100–170 KB por empresa); null si la SEC no la tiene. */
export async function companySubmissions(cik: number, now: Date, f: typeof fetch = fetch): Promise<Submissions | null> {
  const id = String(cik).padStart(10, '0');
  const body = (await secJson(`https://data.sec.gov/submissions/CIK${id}.json`, f)) as SubmissionsBody | null;
  return body ? parseSubmissions(body, cik, now) : null;
}
