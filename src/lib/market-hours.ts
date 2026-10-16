// Horario de la bolsa de Nueva York (NYSE/NASDAQ): lunes a viernes, 9:30–16:00 hora de NY.
// No contempla feriados: en un feriado la app cree que está abierta y gasta algunos créditos de más.

import { addDays } from './num';

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

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

export function usMarketOpen(d: Date): boolean {
  const { date, minutes } = nyParts(d);
  return isWeekday(date) && minutes >= OPEN_MIN && minutes < CLOSE_MIN;
}

/** Fecha (en NY) de la última sesión que ya empezó: sirve para saber si hubo una sesión entre dos momentos. */
export function lastSessionDate(d: Date): string {
  const { date, minutes } = nyParts(d);
  if (isWeekday(date) && minutes >= OPEN_MIN) return date;
  let day = addDays(date, -1);
  while (!isWeekday(day)) day = addDays(day, -1);
  return day;
}
