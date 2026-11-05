// Cumpleaños del dueño (pedido del usuario el 4 nov): ese día Rueda lo saluda con confeti y la fecha aparece en su
// agenda. La fecha va en el secreto OWNER_BIRTHDAY («MM-DD») y no en el código, porque el repositorio es público.
// Solo lo ve el dueño.

import { isoDate } from './num';

export interface Birthday {
  month: number;
  day: number;
}

/** «11-09» → { month: 11, day: 9 }; null si falta o no es un día del año (el 29 de febrero vale). */
export function parseBirthday(v: string | undefined): Birthday | null {
  const m = /^(\d{2})-(\d{2})$/.exec((v ?? '').trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  // 2024 es bisiesto: así el 29 de febrero también es una fecha válida.
  const d = new Date(Date.UTC(2024, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { month, day } : null;
}

/** El cumpleaños en un año dado (quien nació el 29 de febrero lo celebra el 28 en los años no bisiestos). */
function dateIn(year: number, b: Birthday): string {
  const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  const day = b.month === 2 && b.day === 29 && !leap ? 28 : b.day;
  return `${year}-${String(b.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** El próximo cumpleaños desde hoy, hoy incluido (fechas de `timeZone`). */
export function nextBirthday(v: string | undefined, now: Date, timeZone: string): string | null {
  const b = parseBirthday(v);
  if (!b) return null;
  const today = isoDate(now, timeZone);
  const year = Number(today.slice(0, 4));
  const thisYear = dateIn(year, b);
  return thisYear >= today ? thisYear : dateIn(year + 1, b);
}

/** ¿Hoy es el cumpleaños? (fecha de `timeZone`). */
export function isBirthday(v: string | undefined, now: Date, timeZone: string): boolean {
  return nextBirthday(v, now, timeZone) === isoDate(now, timeZone);
}
