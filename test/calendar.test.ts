import { describe, expect, it } from 'vitest';
import { CALENDAR_UNTIL, EVENTS, SOURCES, upcoming, zonedToUtc, type EconEvent } from '../src/lib/calendar';

describe('fechas cargadas', () => {
  it('son fechas válidas, de fuentes conocidas, sin repetir y dentro de lo que dice CALENDAR_UNTIL', () => {
    const seen = new Set<string>();
    for (const e of EVENTS) {
      expect(new Date(`${e.date}T12:00:00Z`).toISOString().slice(0, 10)).toBe(e.date);
      expect(SOURCES[e.kind]).toBeDefined();
      expect(e.date <= CALENDAR_UNTIL[e.kind]!).toBe(true);
      expect(seen.has(`${e.kind}|${e.date}`)).toBe(false);
      seen.add(`${e.kind}|${e.date}`);
    }
  });

  it('las horas de la Fed y del BLS pasan bien a la hora de Lima (el cambio de hora de EE. UU. es el 1 nov 2026)', () => {
    const list = upcoming(EVENTS, new Date('2026-10-22T12:00:00Z'), 30);
    const fed = list.find((e) => e.kind === 'fed')!;
    expect(fed.date).toBe('2026-10-28');
    expect(fed.at).toBe('2026-10-28T18:00:00.000Z'); // 2:00 p. m. en Nueva York (EDT) = 1:00 p. m. en Lima
    const bls = list.find((e) => e.kind === 'bls')!;
    expect(bls.date).toBe('2026-11-10');
    expect(bls.at).toBe('2026-11-10T13:30:00.000Z'); // 8:30 a. m. en Nueva York (EST) = 8:30 a. m. en Lima
  });
});

describe('zonedToUtc', () => {
  it('convierte la hora de Nueva York respetando el horario de verano', () => {
    // 28 oct 2026: horario de verano en NY (UTC−4) → 14:00 NY = 18:00 UTC = 13:00 Lima.
    expect(zonedToUtc('2026-10-28', '14:00', 'America/New_York')).toBe('2026-10-28T18:00:00.000Z');
    // 9 dic 2026: horario estándar (UTC−5) → 14:00 NY = 19:00 UTC = 14:00 Lima.
    expect(zonedToUtc('2026-12-09', '14:00', 'America/New_York')).toBe('2026-12-09T19:00:00.000Z');
    // Lima no cambia de hora (UTC−5).
    expect(zonedToUtc('2026-11-12', '18:00', 'America/Lima')).toBe('2026-11-12T23:00:00.000Z');
  });
});

describe('upcoming', () => {
  const ev = (date: string, extra: Partial<EconEvent> = {}): EconEvent => ({ date, kind: 'fed', title: 'x', ...extra });

  it('deja los eventos de hoy (en Lima) hasta N días, en orden y con la hora en UTC', () => {
    // 22 oct 2026 a las 02:00 UTC todavía es 21 oct en Lima.
    const now = new Date('2026-10-22T02:00:00Z');
    const list = upcoming(
      [ev('2026-10-20'), ev('2026-11-30'), ev('2026-10-21', { kind: 'inei' }), ev('2026-10-28', { time: { hhmm: '14:00', tz: 'America/New_York' } })],
      now,
      30,
    );
    expect(list.map((e) => e.date)).toEqual(['2026-10-21', '2026-10-28']);
    expect(list[1]!.at).toBe('2026-10-28T18:00:00.000Z');
    expect(list[0]!.at).toBeNull();
  });

  it('dentro del mismo día van primero los que tienen hora', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const list = upcoming([ev('2026-11-10', { kind: 'inei' }), ev('2026-11-10', { kind: 'bls', time: { hhmm: '08:30', tz: 'America/New_York' } })], now, 30);
    expect(list.map((e) => e.kind)).toEqual(['bls', 'inei']);
  });
});
