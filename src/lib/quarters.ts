// Trimestres sueltos y últimos 12 meses a partir de lo que traen los informes de la SEC (9 nov: «la ficha al día»).
// Un 10-Q trae el trimestre y el acumulado del año en los resultados, pero solo el acumulado en el flujo de caja; y el
// cuarto trimestre no sale en ningún informe: es el año menos los nueve meses. Funciones puras sobre los periodos de
// un concepto (lib/sec.ts, periodValues).

import { addDays } from './num';
import type { PeriodValue } from './sec';

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
/** Un trimestre: 13 o 14 semanas, o tres meses de calendario (días entre el primero y el último, como en annualValues). */
const isQuarter = (days: number) => days >= 80 && days <= 100;
const isYear = (days: number) => days >= 350 && days <= 380;

/**
 * Los trimestres sueltos de un concepto, del más viejo al más nuevo: los periodos de ~3 meses tal cual y, donde solo
 * hay acumulados, la resta de dos que empiezan el mismo día (6 meses − 3, 9 − 6, el año − 9). Si faltan los nueve
 * meses pero están los tres primeros trimestres, el cuarto es el año menos su suma.
 */
export function quarterValues(periods: PeriodValue[]): PeriodValue[] {
  const byEnd = new Map<string, PeriodValue>();
  for (const p of periods) if (isQuarter(daysBetween(p.start, p.end))) byEnd.set(p.end, { ...p });

  const byStart = new Map<string, PeriodValue[]>();
  for (const p of periods) {
    const group = byStart.get(p.start);
    if (group) group.push(p);
    else byStart.set(p.start, [p]);
  }
  for (const group of byStart.values()) {
    group.sort((a, b) => (a.end < b.end ? -1 : 1));
    for (let i = 1; i < group.length; i++) {
      const [a, b] = [group[i - 1]!, group[i]!];
      if (!byEnd.has(b.end) && isQuarter(daysBetween(a.end, b.end))) byEnd.set(b.end, { start: addDays(a.end, 1), end: b.end, value: b.value - a.value });
    }
  }

  for (const y of periods) {
    if (!isYear(daysBetween(y.start, y.end)) || byEnd.has(y.end)) continue;
    const inside = [...byEnd.values()].filter((q) => q.start >= y.start && q.end < y.end).sort((a, b) => (a.end < b.end ? -1 : 1));
    const first = inside[0];
    const last = inside.at(-1);
    if (inside.length !== 3 || !first || !last || first.start !== y.start || !isQuarter(daysBetween(last.end, y.end))) continue;
    byEnd.set(y.end, { start: addDays(last.end, 1), end: y.end, value: y.value - inside.reduce((s, q) => s + q.value, 0) });
  }
  return [...byEnd.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
}

/** ¿Son cuatro trimestres seguidos (un año completo, sin huecos)? */
export function contiguous(quarters: { start: string; end: string }[]): boolean {
  if (quarters.length !== 4) return false;
  for (let i = 1; i < 4; i++) if (!isQuarter(daysBetween(quarters[i - 1]!.end, quarters[i]!.end))) return false;
  return isYear(daysBetween(quarters[0]!.start, quarters[3]!.end));
}

/**
 * Suma de los cuatro trimestres que terminan en `end` (los últimos 12 meses a esa fecha); null si falta alguno o no
 * son seguidos.
 */
export function trailingSum(quarters: PeriodValue[], end: string): number | null {
  const i = quarters.findIndex((q) => q.end === end);
  if (i < 3) return null;
  const four = quarters.slice(i - 3, i + 1);
  return contiguous(four) ? four.reduce((s, q) => s + q.value, 0) : null;
}
