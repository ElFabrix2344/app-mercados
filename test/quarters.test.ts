import { describe, expect, it } from 'vitest';
import { contiguous, quarterValues, trailingSum } from '../src/lib/quarters';

const p = (start: string, end: string, value: number) => ({ start, end, value });

describe('trimestres sueltos (lib/quarters.ts)', () => {
  it('los de ~3 meses van tal cual; si un informe los corrige, ya viene resuelto por (inicio, fin)', () => {
    expect(quarterValues([p('2026-01-01', '2026-03-31', 30), p('2026-04-01', '2026-06-30', 35)])).toEqual([p('2026-01-01', '2026-03-31', 30), p('2026-04-01', '2026-06-30', 35)]);
  });

  it('el flujo de caja solo viene acumulado: cada trimestre es la resta de dos acumulados del mismo año', () => {
    const q = quarterValues([
      p('2025-01-01', '2025-03-31', 10),
      p('2025-01-01', '2025-06-30', 25),
      p('2025-01-01', '2025-09-30', 45),
      p('2025-01-01', '2025-12-31', 70),
      p('2026-01-01', '2026-03-31', 12),
    ]);
    expect(q.map((x) => [x.start, x.end, x.value])).toEqual([
      ['2025-01-01', '2025-03-31', 10],
      ['2025-04-01', '2025-06-30', 15],
      ['2025-07-01', '2025-09-30', 20],
      ['2025-10-01', '2025-12-31', 25],
      ['2026-01-01', '2026-03-31', 12],
    ]);
  });

  it('sin los nueve meses, el cuarto trimestre es el año menos los tres primeros; con años de 52 semanas también', () => {
    // Año fiscal de 52 semanas que cierra a fines de setiembre (como Apple).
    const q = quarterValues([
      p('2024-09-29', '2024-12-28', 124),
      p('2024-12-29', '2025-03-29', 95),
      p('2025-03-30', '2025-06-28', 94),
      p('2024-09-29', '2025-09-27', 416),
    ]);
    expect(q.at(-1)).toEqual(p('2025-06-29', '2025-09-27', 103));
    // Si falta uno de los tres, no se inventa el cuarto.
    expect(quarterValues([p('2025-01-01', '2025-03-31', 10), p('2025-07-01', '2025-09-30', 20), p('2025-01-01', '2025-12-31', 70)]).map((x) => x.end)).toEqual(['2025-03-31', '2025-09-30']);
  });

  it('periodos que no son un trimestre (un semestre suelto, un año) no se cuelan', () => {
    expect(quarterValues([p('2025-01-01', '2025-06-30', 25), p('2025-01-01', '2025-12-31', 70)])).toEqual([]);
  });

  it('últimos 12 meses: cuatro trimestres seguidos que terminan en esa fecha', () => {
    const q = [p('2025-10-01', '2025-12-31', 25), p('2026-01-01', '2026-03-31', 12), p('2026-04-01', '2026-06-30', 14), p('2026-07-01', '2026-09-30', 16)];
    expect(contiguous(q)).toBe(true);
    expect(trailingSum(q, '2026-09-30')).toBe(67);
    expect(trailingSum(q, '2026-06-30')).toBeNull(); // faltan trimestres hacia atrás
    expect(trailingSum(q, '2026-08-31')).toBeNull(); // no hay un trimestre que termine ese día
    // Con un hueco (falta el segundo de 2026) no hay 12 meses.
    const gap = [p('2025-07-01', '2025-09-30', 20), q[0]!, q[1]!, q[3]!];
    expect(contiguous(gap)).toBe(false);
    expect(trailingSum(gap, '2026-09-30')).toBeNull();
  });
});
