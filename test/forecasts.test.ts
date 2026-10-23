import { describe, expect, it } from 'vitest';
import { SPECS, consensus, dollarQuestion, parseForecast, questionById, questionsAt, readyToResolve, resolve, score } from '../src/lib/forecasts';
import { RESULTS_KEY, forecastView, playerId, resolveForecasts, setAlias, submitForecast, type Results } from '../src/services/forecasts';
import { memoryKV } from './helpers';

// Viernes 23 oct 2026, 10:00 en Lima: el primer día del juego.
const NOW = new Date('2026-10-23T15:00:00Z');

describe('preguntas', () => {
  it('salen solas del calendario y del fin de mes, ya abiertas y en orden de cierre', () => {
    expect(questionsAt(NOW).map((q) => q.id)).toEqual(['fed-2026-10-28', 'inei-2026-10', 'bls-2026-10', 'bcrp-2026-11-12', 'dolar-2026-11', 'inei-2026-11']);
  });

  it('cierran a la medianoche de Lima antes del anuncio; el dólar, una semana antes del último día hábil', () => {
    const fed = questionById('fed-2026-10-28')!;
    expect(fed).toMatchObject({ kind: 'fed', type: 'choice', date: '2026-10-28', closesAt: '2026-10-28T05:00:00.000Z' });
    const inei = questionById('inei-2026-10')!;
    expect(inei).toMatchObject({ date: '2026-11-01', ref: '2026-10', unit: '%', step: 0.01, closesAt: '2026-11-01T05:00:00.000Z' });
    expect(inei.title).toBe('Inflación de Lima a 12 meses: dato de octubre de 2026');
    // Noviembre de 2026 termina en lunes 30.
    expect(dollarQuestion('2026-11')).toMatchObject({ date: '2026-11-30', closesAt: '2026-11-23T05:00:00.000Z', unit: 'S/', step: 0.001 });
    expect(questionById('dolar-2026-11-30')).toBeNull();
    expect(questionById('fed-2026-10-29')).toBeNull();
  });

  it('las de antes de que empezara el juego no existen', () => {
    // El dólar de octubre cerró justo al empezar (23 oct, 00:00 de Lima).
    expect(questionsAt(new Date('2026-11-05T15:00:00Z')).map((q) => q.id)).not.toContain('dolar-2026-10');
  });
});

describe('valores y puntos', () => {
  it('valida y redondea al paso de cada pregunta', () => {
    expect(parseForecast(SPECS.inei, '2,157')).toEqual({ value: 2.16 });
    expect(parseForecast(SPECS.bls, 3.04)).toEqual({ value: 3 });
    expect(parseForecast(SPECS.dolar, '3.71249')).toEqual({ value: 3.712 });
    expect(parseForecast(SPECS.dolar, '37')).toEqual({ error: 'El número tiene que estar entre 2 y 6.' });
    expect(parseForecast(SPECS.inei, 'mucho')).toEqual({ error: 'Escribe un número.' });
    expect(parseForecast(SPECS.bcrp, 'sube')).toEqual({ value: 'sube' });
    expect(parseForecast(SPECS.bcrp, 'sube mucho')).toEqual({ error: 'Elige si sube, se mantiene o baja.' });
  });

  it('10 por acertar la decisión; en números, 1 punto menos por cada paso de error', () => {
    expect(score(SPECS.fed, 'mantiene', 'mantiene')).toBe(10);
    expect(score(SPECS.fed, 'baja', 'mantiene')).toBe(0);
    expect(score(SPECS.inei, 2.25, 2.15)).toBe(8); // 0,10 pp de error
    expect(score(SPECS.inei, 3, 2.15)).toBe(0);
    expect(score(SPECS.dolar, 3.712, 3.7)).toBe(7.6); // 1,2 céntimos
  });

  it('el consenso: cuántos eligieron cada opción, o la mediana', () => {
    expect(consensus(SPECS.bcrp, ['sube', 'mantiene', 'mantiene'])).toEqual({ sube: 1, mantiene: 2, baja: 0 });
    expect(consensus(SPECS.inei, [2.1, 2.3, 2.2, 2.6])).toBe(2.25);
    expect(consensus(SPECS.inei, [])).toBeNull();
  });
});

describe('resolución', () => {
  const after = new Date('2026-11-13T15:00:00Z');
  const bcrp = questionById('bcrp-2026-11-12')!;

  it('decisiones: el último dato antes del anuncio frente al primero después', () => {
    // La nueva tasa aparece al día siguiente…
    expect(resolve(bcrp, { policyRates: [{ date: '2026-11-11', value: 4.25 }, { date: '2026-11-12', value: 4.25 }, { date: '2026-11-13', value: 4 }] }, after)).toBe('baja');
    // …o el mismo día del anuncio: da igual.
    expect(resolve(bcrp, { policyRates: [{ date: '2026-11-11', value: 4.25 }, { date: '2026-11-12', value: 4.5 }, { date: '2026-11-13', value: 4.5 }] }, after)).toBe('sube');
    expect(resolve(bcrp, { policyRates: [{ date: '2026-11-11', value: 4.25 }, { date: '2026-11-13', value: 4.25 }] }, after)).toBe('mantiene');
    // Sin el dato de después todavía no se resuelve, y antes de que pase el día ni se busca.
    expect(resolve(bcrp, { policyRates: [{ date: '2026-11-11', value: 4.25 }, { date: '2026-11-12', value: 4.25 }] }, after)).toBeNull();
    expect(readyToResolve(bcrp, new Date('2026-11-12T22:00:00Z'))).toBe(false);
    const fed = questionById('fed-2026-10-28')!;
    const target = [{ date: '2026-10-27', upper: 4.25 }, { date: '2026-10-28', upper: 4.25 }, { date: '2026-10-29', upper: 4 }];
    expect(resolve(fed, { fedTarget: target }, new Date('2026-10-29T15:00:00Z'))).toBe('baja');
  });

  it('inflación: el dato de ese mes (EE. UU., con un decimal, como lo publica el BLS)', () => {
    expect(resolve(questionById('inei-2026-10')!, { inflationLima: [{ date: '2026-10-01', value: 1.5432 }] }, new Date('2026-11-01T15:00:00Z'))).toBe(1.54);
    expect(resolve(questionById('bls-2026-10')!, { cpiYoY: [{ date: '2026-10-01', value: 2.96 }] }, new Date('2026-11-10T15:00:00Z'))).toBe(3);
    expect(resolve(questionById('bls-2026-10')!, { cpiYoY: [{ date: '2026-09-01', value: 2.9 }] }, new Date('2026-11-10T15:00:00Z'))).toBeNull();
  });

  it('dólar: el último dato del mes, desde el 3 del mes siguiente', () => {
    const q = dollarQuestion('2026-11');
    const fx = [
      { date: '2026-11-27', sell: 3.71 },
      { date: '2026-11-30', sell: 3.70549 },
      { date: '2026-12-01', sell: 3.69 },
    ];
    expect(resolve(q, { fx }, new Date('2026-12-02T15:00:00Z'))).toBeNull();
    expect(resolve(q, { fx }, new Date('2026-12-03T15:00:00Z'))).toBe(3.705);
  });
});

describe('jugar', () => {
  const YO = 'yo@example.com';
  const ANA = 'ana@example.com';

  it('el id del jugador sale del correo (sin guardarlo) y no distingue mayúsculas', async () => {
    expect(await playerId('Yo@Example.com ')).toBe(await playerId(YO));
    expect(await playerId(YO)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('el nombre: de 2 a 20 caracteres y sin repetirse', async () => {
    const { kv } = memoryKV();
    await expect(setAlias(kv, YO, 'F')).rejects.toThrow('de 2 a 20');
    await setAlias(kv, YO, '  Fabri   P ');
    expect((await forecastView(kv, YO, NOW)).me.alias).toBe('Fabri P');
    await expect(setAlias(kv, ANA, 'fabri p')).rejects.toThrow('ya lo usa otro');
    // Cambiar el propio nombre sí se puede.
    await setAlias(kv, YO, 'Fabri');
  });

  it('pronosticar: hace falta nombre, la pregunta abierta y un valor válido', async () => {
    const { kv } = memoryKV();
    await expect(submitForecast(kv, YO, NOW, { questionId: 'fed-2026-10-28', value: 'sube' })).rejects.toThrow('Primero elige tu nombre');
    await setAlias(kv, YO, 'Fabri');
    await expect(submitForecast(kv, YO, NOW, { questionId: 'fed-2026-10-29', value: 'sube' })).rejects.toThrow('no existe');
    await expect(submitForecast(kv, YO, NOW, { questionId: 'fed-2026-10-28', value: 3 })).rejects.toThrow('sube, se mantiene o baja');
    await expect(submitForecast(kv, YO, new Date('2026-10-28T05:00:00Z'), { questionId: 'fed-2026-10-28', value: 'sube' })).rejects.toThrow('ya cerró');
    await expect(submitForecast(kv, YO, NOW, { questionId: 'fed-2026-12-09', value: 'sube' })).rejects.toThrow('todavía no abre');
    const e = await submitForecast(kv, YO, NOW, { questionId: 'inei-2026-10', value: '1,6' });
    expect(e).toMatchObject({ qid: 'inei-2026-10', value: 1.6 });
  });

  it('lo de los demás se ve recién al cierre; después, con el resultado, salen los puntos y el ranking', async () => {
    const { kv } = memoryKV();
    await setAlias(kv, YO, 'Fabri');
    await setAlias(kv, ANA, 'Ana');
    await submitForecast(kv, YO, NOW, { questionId: 'fed-2026-10-28', value: 'mantiene' });
    await submitForecast(kv, ANA, NOW, { questionId: 'fed-2026-10-28', value: 'baja' });
    // Cambiar el pronóstico mientras está abierta.
    await submitForecast(kv, ANA, NOW, { questionId: 'fed-2026-10-28', value: 'sube' });

    const open = (await forecastView(kv, YO, NOW)).questions.find((q) => q.id === 'fed-2026-10-28')!;
    expect(open).toMatchObject({ status: 'open', count: 2, mine: 'mantiene', entries: null, consensus: null, result: null });

    const closedAt = new Date('2026-10-28T06:00:00Z');
    const closed = (await forecastView(kv, YO, closedAt)).questions.find((q) => q.id === 'fed-2026-10-28')!;
    expect(closed.status).toBe('closed');
    // Sin resultado todavía, en el orden de las opciones (sube, mantiene, baja).
    expect(closed.entries).toEqual([
      { alias: 'Ana', value: 'sube', points: null, mine: false },
      { alias: 'Fabri', value: 'mantiene', points: null, mine: true },
    ]);
    expect(closed.consensus).toEqual({ sube: 1, mantiene: 1, baja: 0 });
    // Las cerradas que nadie pronosticó no aparecen.
    expect((await forecastView(kv, YO, closedAt)).questions.filter((q) => q.status !== 'open').map((q) => q.id)).toEqual(['fed-2026-10-28']);

    await kv.put(RESULTS_KEY, JSON.stringify({ 'fed-2026-10-28': { value: 'mantiene', at: '2026-10-29T15:00:00.000Z' } } satisfies Results));
    const v = await forecastView(kv, ANA, new Date('2026-10-29T15:00:00Z'));
    const done = v.questions.find((q) => q.id === 'fed-2026-10-28')!;
    expect(done).toMatchObject({ status: 'resolved', result: 'mantiene', mine: 'sube', minePoints: 0 });
    expect(v.ranking).toEqual([
      { alias: 'Fabri', points: 10, count: 1, mine: false },
      { alias: 'Ana', points: 0, count: 1, mine: true },
    ]);
  });
});

describe('resolveForecasts (tarea programada)', () => {
  it('resuelve lo que ya tiene dato, lo guarda una vez y después no hace nada', async () => {
    const now = new Date('2026-10-29T15:00:00Z');
    const usa = {
      fetchedAt: '2026-10-29T14:00:00.000Z',
      data: {
        treasury10y: [],
        fedFunds: null,
        cpiYoY: [],
        fedTarget: [
          { date: '2026-10-27', lower: 4, upper: 4.25 },
          { date: '2026-10-28', lower: 4, upper: 4.25 },
          { date: '2026-10-29', lower: 3.75, upper: 4 },
        ],
      },
    };
    const mem = memoryKV({ usa });
    const d = { kv: mem.kv, now, fredKey: 'f' };
    expect(await resolveForecasts(d)).toEqual(['fed-2026-10-28']);
    expect(JSON.parse(mem.store.get(RESULTS_KEY)!)['fed-2026-10-28'].value).toBe('baja');
    const writes = mem.writes();
    expect(await resolveForecasts(d)).toEqual([]);
    expect(mem.writes()).toBe(writes);
  });
});
