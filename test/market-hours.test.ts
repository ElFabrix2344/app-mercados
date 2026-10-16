import { describe, expect, it } from 'vitest';
import { lastSessionDate, usMarketOpen } from '../src/lib/market-hours';

describe('usMarketOpen', () => {
  it('abre a las 9:30 y cierra a las 16:00 de NY (horario de verano, UTC-4)', () => {
    expect(usMarketOpen(new Date('2026-10-16T13:29:00Z'))).toBe(false);
    expect(usMarketOpen(new Date('2026-10-16T13:30:00Z'))).toBe(true);
    expect(usMarketOpen(new Date('2026-10-16T19:59:00Z'))).toBe(true);
    expect(usMarketOpen(new Date('2026-10-16T20:00:00Z'))).toBe(false);
  });

  it('sigue la hora de invierno de NY (UTC-5)', () => {
    expect(usMarketOpen(new Date('2026-12-15T14:29:00Z'))).toBe(false);
    expect(usMarketOpen(new Date('2026-12-15T14:30:00Z'))).toBe(true);
  });

  it('está cerrada el fin de semana', () => {
    expect(usMarketOpen(new Date('2026-10-17T15:00:00Z'))).toBe(false);
    expect(usMarketOpen(new Date('2026-10-18T15:00:00Z'))).toBe(false);
  });
});

describe('lastSessionDate', () => {
  it('el fin de semana y el lunes antes de abrir apuntan al viernes', () => {
    expect(lastSessionDate(new Date('2026-10-17T15:00:00Z'))).toBe('2026-10-16');
    expect(lastSessionDate(new Date('2026-10-19T12:00:00Z'))).toBe('2026-10-16');
  });

  it('desde la apertura apunta al mismo día', () => {
    expect(lastSessionDate(new Date('2026-10-19T14:00:00Z'))).toBe('2026-10-19');
    expect(lastSessionDate(new Date('2026-10-19T23:00:00Z'))).toBe('2026-10-19');
  });
});
