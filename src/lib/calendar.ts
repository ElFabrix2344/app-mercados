// Calendario económico: fechas oficiales cargadas a mano, como los feriados de la NYSE. Cada año hay que
// agregar el siguiente desde la fuente de cada evento (SOURCES); `CALENDAR_UNTIL` dice hasta cuándo hay datos.

import type { EarningsRelease } from './finnhub';
import { isoDate } from './num';

/** «empresa»: resultados de las acciones de la lista (Finnhub), solo para el dueño; no van en EVENTS. */
export type EventKind = 'bcrp' | 'fed' | 'inei' | 'bls' | 'empresa';

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
  /** Solo resultados de empresas: símbolo, momento del día y lo que esperan los analistas. */
  company?: EarningsRelease;
}

type Source = { name: string; url: string };

export const SOURCES: Record<EventKind, Source> = {
  bcrp: { name: 'BCRP (Programa Monetario)', url: 'https://www.bcrp.gob.pe/politica-monetaria/notas-informativas-del-programa-monetario.html' },
  fed: { name: 'Reserva Federal (FOMC)', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm' },
  inei: { name: 'INEI (precios de Lima Metropolitana)', url: 'https://www.inei.gob.pe/calendario/' },
  bls: { name: 'BLS (índice de precios al consumidor)', url: 'https://www.bls.gov/schedule/news_release/cpi.htm' },
  empresa: { name: 'Finnhub (resultados de empresas)', url: 'https://finnhub.io/docs/api/earnings-calendar' },
};

/** Las fuentes que ve cada rol: los resultados de empresas (Finnhub) son solo para el dueño. */
export function sourcesFor(owner: boolean): Partial<Record<EventKind, Source>> {
  if (owner) return SOURCES;
  const { empresa: _, ...rest } = SOURCES;
  return rest;
}

/** Hasta qué fecha está cargado el calendario de cada fuente. */
export const CALENDAR_UNTIL: Partial<Record<EventKind, string>> = {
  // El cronograma de 2027 sale en la nota del Programa Monetario de diciembre de 2026.
  bcrp: '2026-12-31',
  fed: '2027-12-31',
  inei: '2027-12-31',
  bls: '2027-12-31',
};

const NY = 'America/New_York';
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
/** «2026-10» → «octubre de 2026». */
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;

/** Decisión del FOMC: el comunicado sale el segundo día a las 2:00 p. m. de Nueva York (así lo publica cada nota de prensa). */
const fomc = (start: string, end: string, sep: boolean, tentative = false): EconEvent => ({
  date: end,
  kind: 'fed',
  title: 'Decisión de tasas de la Fed (FOMC)',
  detail: `Reunión del ${Number(start.slice(8))} al ${Number(end.slice(8))}${sep ? ', con proyecciones económicas' : ''}`,
  time: { hhmm: '14:00', tz: NY },
  ...(tentative ? { tentative } : {}),
});

/** IPC de EE. UU.: el BLS lo publica a las 8:30 a. m. de Nueva York. `ref` es el mes al que corresponde (YYYY-MM). */
const cpi = (date: string, ref: string): EconEvent => ({
  date,
  kind: 'bls',
  title: 'Inflación de EE. UU. (IPC)',
  detail: `Dato de ${monthName(ref)}`,
  time: { hhmm: '08:30', tz: NY },
});

/** IPC de Lima: el INEI lo publica el día 1 del mes siguiente, aunque sea fin de semana o feriado (sin hora oficial). */
const ipcLima = (date: string, ref: string, tentative = false): EconEvent => ({
  date,
  kind: 'inei',
  title: 'Inflación de Lima Metropolitana (IPC)',
  detail: `Dato de ${monthName(ref)}`,
  ...(tentative ? { tentative } : {}),
});

const bcrp = (date: string): EconEvent => ({ date, kind: 'bcrp', title: 'Decisión de la tasa de referencia del BCRP', detail: 'Programa Monetario' });

/**
 * Fechas verificadas el 21 oct 2026 en cada fuente oficial (ver SOURCES y ROADMAP.md):
 * - BCRP: cronograma 2026 de la nota informativa del 11 dic 2025 (la nota del 7 oct 2026 confirma el 12 nov).
 *   No se calcula por regla: la sesión de octubre de 2026 fue un miércoles.
 * - Fed: calendario del FOMC; las de 2027 son tentativas hasta que las confirme la reunión anterior.
 * - INEI: calendario oficial para 2026; 2027 todavía no está publicado y va como tentativo (día 1 de cada mes).
 * - BLS: calendario del CPI de 2026 y 2027.
 */
export const EVENTS: EconEvent[] = [
  bcrp('2026-11-12'),
  bcrp('2026-12-10'),

  fomc('2026-10-27', '2026-10-28', false),
  fomc('2026-12-08', '2026-12-09', true),
  fomc('2027-01-26', '2027-01-27', false, true),
  fomc('2027-03-16', '2027-03-17', true, true),
  fomc('2027-04-27', '2027-04-28', false, true),
  fomc('2027-06-08', '2027-06-09', true, true),
  fomc('2027-07-27', '2027-07-28', false, true),
  fomc('2027-09-14', '2027-09-15', true, true),
  fomc('2027-10-26', '2027-10-27', false, true),
  fomc('2027-12-07', '2027-12-08', true, true),

  ipcLima('2026-11-01', '2026-10'),
  ipcLima('2026-12-01', '2026-11'),
  ipcLima('2027-01-01', '2026-12', true),
  ipcLima('2027-02-01', '2027-01', true),
  ipcLima('2027-03-01', '2027-02', true),
  ipcLima('2027-04-01', '2027-03', true),
  ipcLima('2027-05-01', '2027-04', true),
  ipcLima('2027-06-01', '2027-05', true),
  ipcLima('2027-07-01', '2027-06', true),
  ipcLima('2027-08-01', '2027-07', true),
  ipcLima('2027-09-01', '2027-08', true),
  ipcLima('2027-10-01', '2027-09', true),
  ipcLima('2027-11-01', '2027-10', true),
  ipcLima('2027-12-01', '2027-11', true),

  cpi('2026-11-10', '2026-10'),
  cpi('2026-12-10', '2026-11'),
  cpi('2027-01-13', '2026-12'),
  cpi('2027-02-11', '2027-01'),
  cpi('2027-03-10', '2027-02'),
  cpi('2027-04-13', '2027-03'),
  cpi('2027-05-12', '2027-04'),
  cpi('2027-06-10', '2027-05'),
  cpi('2027-07-14', '2027-06'),
  cpi('2027-08-11', '2027-07'),
  cpi('2027-09-14', '2027-08'),
  cpi('2027-10-14', '2027-09'),
  cpi('2027-11-10', '2027-10'),
  cpi('2027-12-10', '2027-11'),
];

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
