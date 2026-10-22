import { describe, expect, it } from 'vitest';
import { NYSE_CALENDAR_UNTIL, NYSE_EARLY_CLOSES, NYSE_HOLIDAYS, isTradingDay, lastSessionDate, usMarketOpen } from '../src/lib/market-hours';

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

  it('está cerrada en feriados (Acción de Gracias, Viernes Santo, Independencia trasladada)', () => {
    expect(usMarketOpen(new Date('2026-11-26T16:00:00Z'))).toBe(false);
    expect(usMarketOpen(new Date('2026-04-03T15:00:00Z'))).toBe(false);
    expect(usMarketOpen(new Date('2026-07-03T15:00:00Z'))).toBe(false);
  });

  it('cierra a la 1:00 p. m. de NY en los días de cierre anticipado', () => {
    // Viernes 27 nov 2026 (NY en UTC-5): 12:59 abierta, 13:00 cerrada.
    expect(usMarketOpen(new Date('2026-11-27T17:59:00Z'))).toBe(true);
    expect(usMarketOpen(new Date('2026-11-27T18:00:00Z'))).toBe(false);
  });
});

describe('calendario de la NYSE', () => {
  it('ningún feriado ni cierre anticipado cae en fin de semana, y todos están dentro del calendario cargado', () => {
    for (const d of [...NYSE_HOLIDAYS, ...NYSE_EARLY_CLOSES]) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      expect(wd >= 1 && wd <= 5, d).toBe(true);
      expect(d <= NYSE_CALENDAR_UNTIL, d).toBe(true);
    }
    expect(isTradingDay('2026-11-26')).toBe(false);
    expect(isTradingDay('2026-11-27')).toBe(true);
  });
});

describe('lastSessionDate', () => {
  it('el fin de semana y el lunes antes de abrir apuntan al viernes', () => {
    expect(lastSessionDate(new Date('2026-10-17T15:00:00Z'))).toBe('2026-10-16');
    expect(lastSessionDate(new Date('2026-10-19T12:00:00Z'))).toBe('2026-10-16');
  });

  it('se salta los feriados: el lunes 6 jul 2026 antes de abrir apunta al jueves 2 (el 3 es feriado)', () => {
    expect(lastSessionDate(new Date('2026-07-06T12:00:00Z'))).toBe('2026-07-02');
    expect(lastSessionDate(new Date('2026-11-26T18:00:00Z'))).toBe('2026-11-25');
  });

  it('desde la apertura apunta al mismo día', () => {
    expect(lastSessionDate(new Date('2026-10-19T14:00:00Z'))).toBe('2026-10-19');
    expect(lastSessionDate(new Date('2026-10-19T23:00:00Z'))).toBe('2026-10-19');
  });
});
