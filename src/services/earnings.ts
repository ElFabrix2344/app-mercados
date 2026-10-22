// Resultados trimestrales de las acciones de la lista (Finnhub, con la clave gratis del dueño). Solo para el
// dueño: los términos de Finnhub no permiten mostrar sus datos a otras personas. Sin FINNHUB_API_KEY queda
// apagado. Un registro en KV por lista, renovado cada 12 h (unas 2 escrituras al día).

import type { EconEvent } from '../lib/calendar';
import { getEarnings, type EarningsHour, type EarningsRelease } from '../lib/finnhub';
import { ApiError } from '../lib/http';
import { addDays } from '../lib/num';
import { cached, isUsEquity, type Deps, type Fresh } from './market';

export const EARNINGS_TTL_MS = 12 * 3_600_000;
/** Hacia adelante: un trimestre y algo, para que entre el próximo resultado de cada empresa. */
export const EARNINGS_AHEAD_DAYS = 120;
/** Hacia atrás: lo que da el plan gratis (1 mes), para mostrar el último resultado. */
export const EARNINGS_BACK_DAYS = 30;

export interface EarningsData {
  /** De la más vieja a la más nueva. */
  releases: EarningsRelease[];
  /** Símbolos que fallaron en la última lectura (los demás se muestran igual). */
  errors: Record<string, string>;
  from: string;
  to: string;
}

export const MOMENT: Record<EarningsHour, string> = {
  bmo: 'antes de la apertura',
  amc: 'después del cierre',
  dmh: 'durante la sesión',
};

/** «3T 2026»: trimestre fiscal de la empresa. */
export const quarterLabel = (r: EarningsRelease) => (r.quarter && r.year ? `${r.quarter}T ${r.year}` : null);

/** Variación del BPA real frente al esperado (fracción); null si falta alguno o lo esperado es 0. */
export function epsSurprise(r: EarningsRelease): number | null {
  if (r.epsActual === null || r.epsEstimate === null || r.epsEstimate === 0) return null;
  return (r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate);
}

export function earningsEvent(r: EarningsRelease): EconEvent {
  const detail = [quarterLabel(r), r.hour ? MOMENT[r.hour] : null].filter(Boolean).join(' · ');
  return { date: r.date, kind: 'empresa', title: `Resultados de ${r.symbol}`, ...(detail ? { detail } : {}), company: r };
}

/** Lo que el panel y el conector muestran de los resultados de la lista. */
export interface CompanyCalendar {
  /** false si falta FINNHUB_API_KEY: la función queda apagada (no es un error). */
  enabled: boolean;
  /** Próximas presentaciones (desde hoy), como eventos del calendario. */
  events: EconEvent[];
  /** Último resultado ya presentado de cada empresa en el último mes, del más nuevo al más viejo. */
  recent: EarningsRelease[];
  /** Hasta qué fecha se pidieron. */
  until: string | null;
  fetchedAt: string | null;
  stale: boolean;
  note: string | null;
  errors: Record<string, string>;
}

const OFF: CompanyCalendar = { enabled: false, events: [], recent: [], until: null, fetchedAt: null, stale: false, note: null, errors: {} };

export function shapeCompanies(r: Fresh<EarningsData>, today: string): CompanyCalendar {
  const { releases, errors, to } = r.data;
  // Las presentaciones vienen en orden: la última que pisa cada símbolo es la más nueva.
  const last = new Map<string, EarningsRelease>();
  for (const x of releases) if (x.date < today && x.epsActual !== null) last.set(x.symbol, x);
  const failed = Object.keys(errors);
  return {
    enabled: true,
    events: releases.filter((x) => x.date >= today).map(earningsEvent),
    recent: [...last.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    until: to,
    fetchedAt: r.fetchedAt,
    stale: r.stale,
    note: r.note ?? (failed.length ? `Finnhub no respondió para ${failed.join(', ')}.` : null),
    errors,
  };
}

/**
 * Fechas de resultados de las acciones de la lista (sin divisas ni cripto; los ETF como SPY no traen fechas).
 * Nunca rompe el calendario: si Finnhub falla y no hay nada guardado, vuelve vacío con la nota del error.
 */
export async function companyCalendar(d: Deps, list: string[], today: string): Promise<CompanyCalendar> {
  const key = d.finnhubKey;
  if (!key) return OFF;
  const symbols = [...new Set(list.filter(isUsEquity))].sort();
  if (!symbols.length) return { ...OFF, enabled: true };
  const from = addDays(today, -EARNINGS_BACK_DAYS);
  const to = addDays(today, EARNINGS_AHEAD_DAYS);
  try {
    const r = await cached<EarningsData>(d, `earnings:${symbols.join(',')}`, EARNINGS_TTL_MS, async () => {
      // El plan gratis permite 60 pedidos por minuto: la lista (8 como máximo) entra de una vez.
      const results = await Promise.allSettled(symbols.map((s) => getEarnings(s, from, to, key, d.fetch)));
      const releases: EarningsRelease[] = [];
      const errors: Record<string, string> = {};
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') releases.push(...res.value);
        else errors[symbols[i]!] = res.reason instanceof Error ? res.reason.message : 'no respondió';
      });
      // Si fallaron todos (clave mal puesta, Finnhub caído), mejor lo guardado antes que un registro vacío.
      if (results.every((res) => res.status === 'rejected')) {
        const first = (results[0] as PromiseRejectedResult).reason;
        throw first instanceof ApiError ? first : new ApiError('upstream_error', 502, 'Finnhub no respondió.', 'finnhub');
      }
      releases.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return { releases, errors, from, to };
    });
    return shapeCompanies(r, today);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ...OFF, enabled: true, stale: true, note: e.message };
  }
}
