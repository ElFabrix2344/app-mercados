// Estadísticas sobre una serie de cierres diarios (ordenada de antigua a reciente).

import type { DailyPoint } from './twelvedata';

export interface SeriesStats {
  from: string;
  to: string;
  first: number;
  last: number;
  /** Rendimiento total del periodo (0.537 = +53,7 %). */
  totalReturn: number;
  maxClose: { date: string; value: number };
  minClose: { date: string; value: number };
  worstDay: { date: string; ret: number } | null;
  bestDay: { date: string; ret: number } | null;
  /** Volatilidad anualizada de los rendimientos diarios simples. */
  annualVol: number | null;
  /** Mayor caída desde un pico previo (negativa: -0.25 = -25 %). */
  maxDrawdown: { value: number; peakDate: string; troughDate: string } | null;
}

export function dailyReturns(pts: DailyPoint[]): { date: string; ret: number }[] {
  const out: { date: string; ret: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!.close;
    if (prev > 0) out.push({ date: pts[i]!.date, ret: pts[i]!.close / prev - 1 });
  }
  return out;
}

/** Observaciones por año según las fechas: ~252 en bolsa, ~365 en cripto. */
export function periodsPerYear(pts: DailyPoint[]): number {
  if (pts.length < 2) return 252;
  const days = (Date.parse(pts[pts.length - 1]!.date) - Date.parse(pts[0]!.date)) / 86_400_000;
  return days > 0 ? ((pts.length - 1) * 365.25) / days : 252;
}

export function maxDrawdown(pts: DailyPoint[]): SeriesStats['maxDrawdown'] {
  if (pts.length < 2) return null;
  let peak = pts[0]!;
  let best: SeriesStats['maxDrawdown'] = null;
  for (const p of pts) {
    if (p.close > peak.close) peak = p;
    const dd = p.close / peak.close - 1;
    if (!best || dd < best.value) best = { value: dd, peakDate: peak.date, troughDate: p.date };
  }
  return best && best.value < 0 ? best : null;
}

export function seriesStats(pts: DailyPoint[]): SeriesStats | null {
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let maxC = first;
  let minC = first;
  for (const p of pts) {
    if (p.close > maxC.close) maxC = p;
    if (p.close < minC.close) minC = p;
  }
  const rets = dailyReturns(pts);
  let worst: SeriesStats['worstDay'] = null;
  let best: SeriesStats['bestDay'] = null;
  for (const r of rets) {
    if (!worst || r.ret < worst.ret) worst = r;
    if (!best || r.ret > best.ret) best = r;
  }
  let annualVol: number | null = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((s, r) => s + r.ret, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r.ret - mean) ** 2, 0) / (rets.length - 1);
    annualVol = Math.sqrt(variance) * Math.sqrt(periodsPerYear(pts));
  }
  return {
    from: first.date,
    to: last.date,
    first: first.close,
    last: last.close,
    totalReturn: last.close / first.close - 1,
    maxClose: { date: maxC.date, value: maxC.close },
    minClose: { date: minC.date, value: minC.close },
    worstDay: worst,
    bestDay: best,
    annualVol,
    maxDrawdown: maxDrawdown(pts),
  };
}
