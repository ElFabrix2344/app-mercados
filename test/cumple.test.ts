import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { isBirthday, nextBirthday, parseBirthday } from '../src/lib/cumple';
import { addDays, isoDate } from '../src/lib/num';
import { memoryKV } from './helpers';

const LIMA = 'America/Lima';

describe('cumpleaños del dueño (OWNER_BIRTHDAY)', () => {
  it('lee «MM-DD» y rechaza lo que no es un día del año', () => {
    expect(parseBirthday('11-09')).toEqual({ month: 11, day: 9 });
    expect(parseBirthday(' 02-29 ')).toEqual({ month: 2, day: 29 });
    for (const bad of [undefined, '', '9-11', '11/09', '13-01', '04-31', '00-10', '2026-11-09']) expect(parseBirthday(bad)).toBeNull();
  });

  it('el día se cuenta con la fecha de Lima, no con la de UTC', () => {
    // 9 nov 2026, 00:00 en Lima = 05:00 UTC.
    expect(isBirthday('11-09', new Date('2026-11-09T04:59:00Z'), LIMA)).toBe(false);
    expect(isBirthday('11-09', new Date('2026-11-09T05:00:00Z'), LIMA)).toBe(true);
    expect(isBirthday('11-09', new Date('2026-11-10T04:59:00Z'), LIMA)).toBe(true);
    expect(isBirthday('11-09', new Date('2026-11-10T05:00:00Z'), LIMA)).toBe(false);
    expect(isBirthday(undefined, new Date('2026-11-09T15:00:00Z'), LIMA)).toBe(false);
  });

  it('el próximo cumpleaños: hoy cuenta; si ya pasó, el del año siguiente; el 29 de febrero, el 28 si no es bisiesto', () => {
    expect(nextBirthday('11-09', new Date('2026-11-04T15:00:00Z'), LIMA)).toBe('2026-11-09');
    expect(nextBirthday('11-09', new Date('2026-11-09T15:00:00Z'), LIMA)).toBe('2026-11-09');
    expect(nextBirthday('11-09', new Date('2026-11-10T15:00:00Z'), LIMA)).toBe('2027-11-09');
    expect(nextBirthday('02-29', new Date('2026-11-04T15:00:00Z'), LIMA)).toBe('2027-02-28');
    expect(nextBirthday('02-29', new Date('2027-11-04T15:00:00Z'), LIMA)).toBe('2028-02-29');
    expect(nextBirthday('nada', new Date(), LIMA)).toBeNull();
  });

  describe('en el panel (local, con datos de prueba)', () => {
    const mmdd = (days: number) => addDays(isoDate(new Date(), LIMA), days).slice(5);
    // En local, el dueño y el «amigo» de DEV_ROLE entran con el mismo correo (dev@localhost); OWNER_EMAILS dice de quién
    // es el nombre del juego que ven los demás.
    const env = (birthday: string | undefined, kv = memoryKV().kv) => (role?: string) =>
      ({
        CACHE: kv,
        ASSETS: { fetch: async () => new Response('asset') },
        TIMEZONE: LIMA,
        DEV_MODE: 'true',
        MOCK_DATA: 'true',
        DEV_ROLE: role,
        OWNER_EMAILS: 'dev@localhost',
        OWNER_BIRTHDAY: birthday,
      }) as unknown as Env;
    const get = async (path: string, e: Env) => (await (await worker.fetch(new Request(`http://localhost${path}`), e, {} as ExecutionContext)).json()) as Record<string, any>;
    const named = async (e: Env) => {
      await worker.fetch(
        new Request('http://localhost/api/forecasts/name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'Fabri' }) }),
        e,
        {} as ExecutionContext,
      );
    };

    it('ese día el estado trae el cumpleaños para todos: al dueño se lo saluda y a los demás se les avisa', async () => {
      const as = env(mmdd(0));
      await named(as());
      expect((await get('/api/status', as())).birthday).toEqual({ alias: 'Fabri', mine: true });
      expect((await get('/api/status', as('friend'))).birthday).toEqual({ alias: 'Fabri', mine: false });
      expect((await get('/api/status', as())).config.OWNER_BIRTHDAY).toMatchObject({ loaded: true, formatOk: true });
      // Sin nombre del juego, el aviso va sin nombre.
      expect((await get('/api/status', env(mmdd(0))('friend'))).birthday).toEqual({ alias: null, mine: false });
    });

    it('otro día, o sin OWNER_BIRTHDAY, no hay nada', async () => {
      expect((await get('/api/status', env(mmdd(1))())).birthday).toBeNull();
      expect((await get('/api/status', env(mmdd(-1))('friend'))).birthday).toBeNull();
      expect((await get('/api/status', env(undefined)())).birthday).toBeNull();
      expect((await get('/api/status', env('31-12')())).config.OWNER_BIRTHDAY).toMatchObject({ loaded: true, formatOk: false });
    });

    it('la agenda de todos trae la fecha si cae dentro de los días pedidos', async () => {
      const as = env(mmdd(10));
      await named(as());
      const date = addDays(isoDate(new Date(), LIMA), 10);
      expect((await get('/api/calendar?days=30', as())).birthday).toEqual({ date, alias: 'Fabri', mine: true });
      expect((await get('/api/calendar?days=30', as('friend'))).birthday).toEqual({ date, alias: 'Fabri', mine: false });
      expect((await get('/api/calendar?days=5', as())).birthday).toBeNull();
      expect((await get('/api/calendar', env(undefined)())).birthday).toBeNull();
    });
  });
});
