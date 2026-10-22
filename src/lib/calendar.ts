// Calendario económico: fechas oficiales cargadas a mano, como los feriados de la NYSE. Cada año hay que
// agregar el siguiente desde la fuente de cada evento (SOURCES); `CALENDAR_UNTIL` dice hasta cuándo hay datos.

import { isoDate } from './num';

export type EventKind = 'bcrp' | 'fed' | 'inei' | 'bls';

export interface EconEvent {
  /** Día del anuncio, en la fecha local de quien publica. */
  date: string;
  kind: EventKind;
  title: string;
  /** Periodo al que se refiere (p. ej. «Inflación de octubre de 2026») u otro detalle corto. */
  detail?: string;
  /** Hora oficial del anuncio y su zona horaria; se muestra convertida a la hora de Lima. */
  time?: { hhmm: string; tz: string };
  /** La fuente la publica como tentativa. */
  tentative?: boolean;
}

export const SOURCES: Record<EventKind, { name: string; url: string }> = {
  bcrp: { name: 'BCRP (Programa Monetario)', url: 'https://www.bcrp.gob.pe/politica-monetaria.html' },
  fed: { name: 'Reserva Federal (FOMC)', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
  inei: { name: 'INEI (precios de Lima Metropolitana)', url: 'https://www.inei.gob.pe/' },
  bls: { name: 'BLS (índice de precios al consumidor)', url: 'https://www.bls.gov/schedule/news_release/cpi.htm' },
};

/** Hasta qué fecha está cargado el calendario de cada fuente (se llena junto con EVENTS). */
export const CALENDAR_UNTIL: Partial<Record<EventKind, string>> = {};

/**
 * Fechas verificadas en la fuente oficial de cada evento. Mientras esté vacío, el panel oculta el calendario y
 * el conector no ofrece la herramienta `calendario` (ver ROADMAP.md).
 */
export const EVENTS: EconEvent[] = [];

export interface UpcomingEvent extends EconEvent {
  /** Instante del anuncio (ISO, UTC) si la fuente da la hora. */
  at: string | null;
}

/** Diferencia en minutos entre la hora de pared de `tz` y UTC en un instante dado. */
function offsetMinutes(ts: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, x.value]),
  );
  return Math.round((Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) - ts) / 60_000);
}

/** «14:00 del 28 oct en America/New_York» → instante UTC (ISO). Respeta el horario de verano de esa zona. */
export function zonedToUtc(date: string, hhmm: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wall - offsetMinutes(wall, tz) * 60_000;
  // Segunda pasada por si el primer cálculo cayó del otro lado de un cambio de hora.
  ts = wall - offsetMinutes(ts, tz) * 60_000;
  return new Date(ts).toISOString();
}

/** Eventos desde hoy (fecha de Lima) hasta `days` días después, en orden. */
export function upcoming(events: EconEvent[], now: Date, days: number, timeZone = 'America/Lima'): UpcomingEvent[] {
  const today = isoDate(now, timeZone);
  const until = isoDate(new Date(now.getTime() + days * 86_400_000), timeZone);
  return events
    .filter((e) => e.date >= today && e.date <= until)
    .map((e) => ({ ...e, at: e.time ? zonedToUtc(e.date, e.time.hhmm, e.time.tz) : null }))
    // Por día y, dentro del día, primero los que tienen hora (en orden) y al final los que no
    // (comparación de texto simple: «z» va después de los dígitos; localeCompare no lo garantiza).
    .sort((a, b) => {
      const ka = `${a.date} ${a.at ?? 'z'}`;
      const kb = `${b.date} ${b.at ?? 'z'}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}
