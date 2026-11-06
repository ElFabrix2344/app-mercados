// Posición de los fondos en materias primas (elegida por el usuario el 6 nov, al revisar OpenBB): el informe semanal COT
// de la CFTC (lib/cftc.ts), de dominio público, así que lo ven también los amigos. Cobre, oro y plata de COMEX y petróleo
// WTI de NYMEX; el zinc no tiene, porque se negocia en Londres. Un solo registro en KV (`cot`), renovado como mucho cada
// 3 horas (≤ 8 escrituras al día): el informe sale una vez por semana. Describe lo que hicieron los fondos; no predice.

import { getCotRows, type CotRow } from '../lib/cftc';
import { ApiError } from '../lib/http';
import { cached, type CacheDeps, type Fresh } from './market';

/** Las claves son las de las materias primas del BCRP en el panel (`COMMODITIES` en app.js). */
export const COT_MARKETS = [
  { key: 'copper', code: '085692', name: 'Cobre', exchange: 'COMEX' },
  { key: 'gold', code: '088691', name: 'Oro', exchange: 'COMEX' },
  { key: 'silver', code: '084691', name: 'Plata', exchange: 'COMEX' },
  { key: 'oil', code: '067651', name: 'Petróleo WTI', exchange: 'NYMEX' },
] as const;
export const COT_TTL_MS = 3 * 3_600_000;
/** Un año de informes: la semana de hoy se compara con las anteriores, y son las barras del panel. */
export const COT_WEEKS = 52;
/** Con menos semanas no se dice si la posición es «de costumbre». */
const MIN_WEEKS_TO_RANK = 8;

export interface CotMarket {
  key: string;
  name: string;
  exchange: string;
  /** El martes de las posiciones más nuevas (AAAA-MM-DD). */
  date: string;
  /** Contratos de los fondos a que sube menos los que tienen a que baja (positivo: comprados). */
  net: number;
  openInterest: number;
  /** El neto como fracción de los contratos abiertos. */
  netPct: number;
  /** Lo mismo, la semana anterior (null si no hay). */
  prevNetPct: number | null;
  /** Qué parte de las semanas anteriores del año tuvo un neto más bajo: 0 = el más bajo del año, 1 = el más alto. */
  rank: number | null;
  /** Las semanas del año, de la más vieja a la más nueva: [martes, neto como fracción]. */
  points: [string, number][];
}

export interface CotData {
  /** El informe más nuevo (martes), o null si no llegó ninguno. */
  date: string | null;
  markets: Record<string, CotMarket>;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** Arma cada mercado con las semanas de la CFTC (llegan de la más nueva a la más vieja; aquí se ordenan igual). */
export function buildCot(rows: CotRow[]): CotData {
  const markets: Record<string, CotMarket> = {};
  for (const m of COT_MARKETS) {
    // Una fila por martes (si se repitiera, la primera que llegó).
    const byDate = new Map<string, CotRow>();
    for (const r of rows) if (r.code === m.code && !byDate.has(r.date)) byDate.set(r.date, r);
    const weeks = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-COT_WEEKS);
    const last = weeks.at(-1);
    if (!last) continue;
    const points = weeks.map((w) => [w.date, round((w.long - w.short) / w.openInterest)] as [string, number]);
    const netPct = points.at(-1)![1];
    const before = points.slice(0, -1).map(([, v]) => v);
    markets[m.key] = {
      key: m.key,
      name: m.name,
      exchange: m.exchange,
      date: last.date,
      net: last.long - last.short,
      openInterest: last.openInterest,
      netPct,
      prevNetPct: points.at(-2)?.[1] ?? null,
      rank: before.length >= MIN_WEEKS_TO_RANK ? round(before.filter((v) => v < netPct).length / before.length) : null,
      points,
    };
  }
  const dates = Object.values(markets).map((x) => x.date).sort();
  return { date: dates.at(-1) ?? null, markets };
}

export async function cot(d: CacheDeps): Promise<Fresh<CotData>> {
  return cached<CotData>(d, 'cot', COT_TTL_MS, async () => {
    // Un poco más de un año, por si alguna semana salió con atraso (los feriados corren el informe).
    const since = new Date(d.now.getTime() - 380 * 86_400_000).toISOString().slice(0, 10);
    const data = buildCot(await getCotRows(COT_MARKETS.map((m) => m.code), since, d.fetch));
    // Vacío no se guarda: así queda el registro anterior, si había.
    if (!data.date) throw new ApiError('bad_response', 502, 'La CFTC no trajo ningún informe.', 'cftc');
    return data;
  });
}
