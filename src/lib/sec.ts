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

/** Un concepto XBRL de la empresa en su moneda (USD, PEN…); null si no lo reporta. */
export async function companyConcept(
  cik: number,
  taxonomy: 'us-gaap' | 'ifrs-full',
  concept: string,
  f: typeof fetch = fetch,
): Promise<{ currency: string; values: AnnualValue[] } | null> {
  const id = String(cik).padStart(10, '0');
  const body = (await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/${taxonomy}/${concept}.json`, f)) as {
    units?: Record<string, Fact[]>;
  } | null;
  // La unidad monetaria es un código de 3 letras (las de por acción vienen como «USD/shares»).
  const unit = Object.keys(body?.units ?? {}).find((u) => /^[A-Z]{3}$/.test(u));
  if (!unit) return null;
  const values = annualValues(body!.units![unit]!);
  return values.length ? { currency: unit, values } : null;
}
