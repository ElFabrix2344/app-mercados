// Horario de la bolsa de Nueva York (NYSE/NASDAQ): lunes a viernes, 9:30–16:00 hora de NY,
// sin los feriados y con los cierres anticipados (13:00) del calendario oficial de la NYSE.
// Fuente: https://www.nyse.com/markets/hours-calendars. Hay que agregar cada año nuevo
// (NYSE_CALENDAR_UNTIL dice hasta cuándo está cargado; después solo se excluyen los fines de semana).

import { addDays } from './num';

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

/** Días con la bolsa cerrada (fecha de NY). */
export const NYSE_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // Año Nuevo
  '2026-01-19', // Martin Luther King Jr.
  '2026-02-16', // Día de Washington
  '2026-04-03', // Viernes Santo
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independencia (feriado trasladado)
  '2026-09-07', // Día del Trabajo
  '2026-11-26', // Acción de Gracias
  '2026-12-25', // Navidad
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26', // Viernes Santo
  '2027-05-31',
  '2027-06-18', // Juneteenth (trasladado)
  '2027-07-05', // Independencia (trasladado)
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // Navidad (trasladada)
]);

/** Días en que la bolsa cierra a la 1:00 p. m. de NY. */
export const NYSE_EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

/** Último día cubierto por el calendario de arriba. */
export const NYSE_CALENDAR_UNTIL = '2027-12-31';

const fmtNY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Fecha (YYYY-MM-DD) y minuto del día en Nueva York. */
function nyParts(d: Date): { date: string; minutes: number } {
  const p = Object.fromEntries(fmtNY.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const isWeekday = (date: string) => {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5;
};

/** Hay sesión ese día (fecha de NY): día de semana y no feriado. */
export const isTradingDay = (date: string): boolean => isWeekday(date) && !NYSE_HOLIDAYS.has(date);

export function usMarketOpen(d: Date): boolean {
  const { date, minutes } = nyParts(d);
  const close = NYSE_EARLY_CLOSES.has(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
  return isTradingDay(date) && minutes >= OPEN_MIN && minutes < close;
}

/** Fecha (en NY) de la última sesión que ya empezó: sirve para saber si hubo una sesión entre dos momentos. */
export function lastSessionDate(d: Date): string {
  const { date, minutes } = nyParts(d);
  if (isTradingDay(date) && minutes >= OPEN_MIN) return date;
  let day = addDays(date, -1);
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}

/**
 * Fecha (en NY) del último cierre ya ocurrido: la sesión de hoy si ya cerró hace `settleMin` minutos o más (para que el
 * dato del día quede firme); si no, la sesión anterior.
 */
export function lastClosedSession(d: Date, settleMin = 0): string {
  const { date, minutes } = nyParts(d);
  const close = NYSE_EARLY_CLOSES.has(date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
  if (isTradingDay(date) && minutes >= close + settleMin) return date;
  let day = addDays(date, -1);
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}