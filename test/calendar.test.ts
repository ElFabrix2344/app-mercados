import { describe, expect, it } from 'vitest';
import { upcoming, zonedToUtc, type EconEvent } from '../src/lib/calendar';

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
