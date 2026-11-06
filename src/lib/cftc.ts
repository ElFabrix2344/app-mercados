// CFTC, informe semanal «Commitments of Traders» (COT), versión «Disaggregated, Futures Only», por su API pública
// (publicreporting.cftc.gov, con Socrata): no pide clave. La información del gobierno en el sitio de la CFTC es de
// dominio público, así que se puede mostrar a todos; su política pide citar a la CFTC (revisado el 6 nov 2026 en
// cftc.gov/WebPolicy). Sale cada viernes a las 15:30 de Nueva York, con las posiciones del martes.

import { ApiError } from './http';

const COT_URL = 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json';

/** Una semana de un mercado: los contratos abiertos y los de los fondos («managed money»). */
export interface CotRow {
  /** El martes de las posiciones (AAAA-MM-DD). */
  date: string;
  /** Código del contrato en la CFTC (cobre de COMEX: 085692). */
  code: string;
  openInterest: number;
  /** Contratos de los fondos que ganan si el precio sube… */
  long: number;
  /** …y los que ganan si baja. */
  short: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[0-9A-Z]{6}$/;

/** La API devuelve los números como texto. */
const count = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Las semanas desde `since` (AAAA-MM-DD) de los contratos pedidos, en una sola consulta. */
export async function getCotRows(codes: readonly string[], since: string, f: typeof fetch = fetch): Promise<CotRow[]> {
  // Los códigos y la fecha van dentro de la consulta: solo se aceptan con su forma exacta.
  if (!DATE_RE.test(since) || !codes.length || codes.some((c) => !CODE_RE.test(c))) {
    throw new ApiError('bad_request', 400, 'CFTC: pedido no válido.', 'cftc');
  }
  const url = new URL(COT_URL);
  url.searchParams.set('$select', 'report_date_as_yyyy_mm_dd,cftc_contract_market_code,open_interest_all,m_money_positions_long_all,m_money_positions_short_all');
  url.searchParams.set('$where', `cftc_contract_market_code in(${codes.map((c) => `'${c}'`).join(',')}) AND report_date_as_yyyy_mm_dd >= '${since}'`);
  url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  url.searchParams.set('$limit', '1000');
  let res: Response;
  try {
    res = await f(url.toString(), { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `La CFTC no respondió: ${(e as Error).message}`, 'cftc');
  }
  if (res.status === 429) throw new ApiError('rate_limited', 429, 'La CFTC pidió esperar (límite de consultas).', 'cftc');
  if (!res.ok) throw new ApiError('upstream_error', 502, `CFTC: HTTP ${res.status}`, 'cftc');
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new ApiError('bad_response', 502, 'CFTC: respuesta inesperada.', 'cftc');
  const out: CotRow[] = [];
  for (const raw of body) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const date = typeof r.report_date_as_yyyy_mm_dd === 'string' ? r.report_date_as_yyyy_mm_dd.slice(0, 10) : '';
    const code = typeof r.cftc_contract_market_code === 'string' ? r.cftc_contract_market_code.trim() : '';
    const openInterest = count(r.open_interest_all);
    const long = count(r.m_money_positions_long_all);
    const short = count(r.m_money_positions_short_all);
    if (!DATE_RE.test(date) || !code || !openInterest || long === null || short === null) continue;
    out.push({ date, code, openInterest, long, short });
  }
  return out;
}
