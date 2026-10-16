// API de BCRPData: https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api
// Formato: /api/{codigo1-codigo2}/json/{inicio}/{fin}/esp. Sin clave. Los días sin dato vienen como "n.d.".

import { ApiError } from './http';
import { num } from './num';

const BASE = 'https://estadisticas.bcrp.gob.pe/estadisticas/series/api';

export const BCRP_SERIES = {
  fxBuy: 'PD04637PD', // TC interbancario, compra (diario)
  fxSell: 'PD04638PD', // TC interbancario, venta (diario)
  policyRate: 'PD12301MD', // tasa de referencia (diario)
  inflation12m: 'PN01273PM', // IPC Lima Metropolitana, var% 12 meses (mensual)
} as const;

export interface BcrpPoint {
  date: string; // YYYY-MM-DD (mensual: día 01)
  values: (number | null)[];
}

const MONTHS: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', set: '09', sep: '09', oct: '10', nov: '11', dic: '12',
};

/** "14.Oct.26" → 2026-10-14 · "Sep.2026" → 2026-09-01 · "30.Set.26" → 2026-09-30. */
export function parseBcrpDate(name: string): string | null {
  const daily = /^(\d{1,2})\.([A-Za-z]{3})\.(\d{2})$/.exec(name.trim());
  if (daily) {
    const m = MONTHS[daily[2]!.toLowerCase()];
    return m ? `20${daily[3]}-${m}-${daily[1]!.padStart(2, '0')}` : null;
  }
  const monthly = /^([A-Za-z]{3})\.(\d{4})$/.exec(name.trim());
  if (monthly) {
    const m = MONTHS[monthly[1]!.toLowerCase()];
    return m ? `${monthly[2]}-${m}-01` : null;
  }
  return null;
}

/**
 * El BCRP a veces agrega un aviso HTML de PHP (`<br /><font size='1'><table class='xdebug-error'…`)
 * después del JSON, y entonces JSON.parse falla. Se lee solo el primer objeto completo.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseBcrp(raw: unknown, seriesCount: number): BcrpPoint[] {
  const periods = (raw as { periods?: unknown })?.periods;
  if (!Array.isArray(periods)) throw new ApiError('bad_response', 502, 'BCRP: respuesta sin periodos.', 'bcrp');
  const out: BcrpPoint[] = [];
  for (const p of periods) {
    const date = parseBcrpDate(String((p as Record<string, unknown>)?.name ?? ''));
    const vals = (p as Record<string, unknown>)?.values;
    if (!date || !Array.isArray(vals)) continue;
    const values = Array.from({ length: seriesCount }, (_, i) => num(vals[i]));
    out.push({ date, values });
  }
  return out;
}

/** start/end: YYYY-MM-DD para series diarias, YYYY-MM para mensuales. */
export async function getBcrp(codes: string[], start: string, end: string, f: typeof fetch = fetch): Promise<BcrpPoint[]> {
  const url = `${BASE}/${codes.join('-')}/json/${start}/${end}/esp`;
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': 'mercados-panel-personal' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `BCRP no respondió: ${(e as Error).message}`, 'bcrp');
  }
  if (!res.ok) throw new ApiError('upstream_error', 502, `BCRP: HTTP ${res.status}`, 'bcrp');
  return parseBcrp(extractJson(await res.text()), codes.length);
}

/** Último punto con dato en la columna i. */
export function lastWithValue(points: BcrpPoint[], i: number): { date: string; value: number } | null {
  for (let k = points.length - 1; k >= 0; k--) {
    const v = points[k]!.values[i];
    if (v !== null && v !== undefined) return { date: points[k]!.date, value: v };
  }
  return null;
}
