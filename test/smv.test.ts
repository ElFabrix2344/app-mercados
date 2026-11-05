import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { getHechos, isoOf, parseHechos, tipoOf, type Hecho } from '../src/lib/smv';
import { issuerSymbol, mergeHechos, prettyName, refreshSmv, shapeSmv, SMV_KEY, type SmvData } from '../src/services/smv';
import type { Stored } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

/** Una fila como las de la API (datos inventados). */
const row = (o: Partial<Record<string, string>>) => ({
  RPJ: 'X0001',
  RUC: '0',
  Numero_Expediente: '2026000001',
  Empresa: 'EMPRESA DE PRUEBA S.A.A.',
  Tipo_Hecho: 'OTROS HECHOS DE IMPORTANCIA',
  Fecha_Acuerdo_Hecho: '04/11/2026',
  Fecha_Presentacion: '04/11/2026 17:02',
  Descripcion_Hecho: 'Aviso de prueba.',
  Sector: 'DIVERSOS',
  SubSector: '',
  Tipo_Empresa: 'EMPRESAS EMISORAS',
  ...o,
});

const hecho = (o: Partial<Hecho>): Hecho => ({ id: '1', empresa: 'EMPRESA DE PRUEBA S.A.A.', tipo: 'Otros hechos de importancia', at: '2026-11-04T17:02', texto: 'Aviso de prueba.', sector: '', ...o });

describe('hechos de importancia de la SMV', () => {
  it('lee la respuesta de la API: fecha de Lima, tipo sin número y textos acotados', () => {
    expect(isoOf('04/11/2026 17:02')).toBe('2026-11-04T17:02');
    expect(isoOf('04/11/2026')).toBe('2026-11-04T00:00');
    expect(isoOf('ayer')).toBeNull();
    expect(tipoOf('10. INFORMACIÓN FINANCIERA Y MEMORIA ANUAL.')).toBe('Información financiera y memoria anual');
    expect(tipoOf('OTROS HECHOS DE IMPORTANCIA')).toBe('Otros hechos de importancia');
    const long = 'x'.repeat(400);
    const hs = parseHechos({ ResponseCode: '0', Resultado: [row({}), row({ Descripcion_Hecho: long }), row({ Fecha_Presentacion: '' })] });
    expect(hs).toHaveLength(2);
    expect(hs[0]).toEqual({ id: '2026000001', empresa: 'EMPRESA DE PRUEBA S.A.A.', tipo: 'Otros hechos de importancia', at: '2026-11-04T17:02', texto: 'Aviso de prueba.', sector: 'DIVERSOS' });
    expect(hs[1]!.texto.length).toBe(280);
    expect(hs[1]!.texto.endsWith('…')).toBe(true);
    expect(() => parseHechos({ ResponseCode: '1' })).toThrow(/sin hechos/);
  });

  it('pide las fechas como dd/mm/aaaa', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { Resultado: [row({})] } }));
    expect(await getHechos('2026-10-28', '2026-11-04', f)).toHaveLength(1);
    expect(calls[0]!.searchParams.get('sFechaInicio')).toBe('28/10/2026');
    expect(calls[0]!.searchParams.get('sFechaFin')).toBe('04/11/2026');
  });

  it('reconoce a las empresas que cotizan en EE. UU. y acorta los nombres', () => {
    expect(issuerSymbol('COMPAÑIA DE MINAS BUENAVENTURA S.A.A.')).toBe('BVN');
    expect(issuerSymbol('COMPANIA DE MINAS BUENAVENTURA S.A.A.')).toBe('BVN');
    expect(issuerSymbol('CREDICORP LTD.')).toBe('BAP');
    expect(issuerSymbol('CREDICORP CAPITAL PERU S.A.A.')).toBeNull(); // otra empresa del grupo
    expect(issuerSymbol('SOUTHERN PERU COPPER CORPORATION, SUCURSAL DEL PERU')).toBe('SCCO');
    expect(prettyName('CREDICORP LTD.')).toBe('Credicorp');
    expect(prettyName('SERVICIO DE AGUA POTABLE Y ALCANTARILLADO - SEDAPAL')).toBe('SEDAPAL');
    expect(prettyName('CORPORACION ACEROS AREQUIPA S.A.')).toBe('Corporacion Aceros Arequipa');
    expect(prettyName('BANCO BBVA PERU')).toBe('Banco BBVA Peru');
    expect(prettyName('LUZ DEL SUR S.A.A.')).toBe('Luz del Sur');
    expect(prettyName('PETROLEOS DEL PERU - PETROPERU S.A.')).toBe('PETROPERU');
    // «CORP» pegado al nombre no es un sufijo.
    expect(prettyName('ALICORP S.A.A.')).toBe('Alicorp');
    expect(prettyName('FERREYCORP S.A.A.')).toBe('Ferreycorp');
    expect(prettyName('INRETAIL PERU CORP.')).toBe('Inretail Peru');
    expect(prettyName('UNACEM CORP SOCIEDAD ANONIMA ABIERTA - UNACEM CORP S.A.A.')).toBe('UNACEM');
    expect(prettyName('INSUR S.A. COMPAÑIA DE SEGUROS')).toBe('Insur S.A. Compañia de Seguros');
  });

  it('junta lo nuevo con lo guardado: sin repetidos, sin avisos vacíos y con 60 días de las empresas de EE. UU.', () => {
    const today = '2026-11-04';
    const prev = [hecho({ id: 'a', at: '2026-10-25T10:00' }), hecho({ id: 'viejo', at: '2026-10-10T10:00' }), hecho({ id: 'bvn-viejo', empresa: 'COMPAÑIA DE MINAS BUENAVENTURA S.A.A.', at: '2026-09-20T10:00' })];
    const fresh = [
      hecho({ id: 'b', at: '2026-11-04T09:00' }),
      // El mismo aviso repetido con otro tipo.
      hecho({ id: 'b', at: '2026-11-04T09:00', tipo: 'Distribución o aplicación de utilidades' }),
      hecho({ id: 'vacio', at: '2026-11-03T09:00', tipo: 'Información financiera y memoria anual', texto: '' }),
      hecho({ id: 'scco-vacio', empresa: 'SOUTHERN COPPER CORPORATION', at: '2026-11-03T08:00', tipo: 'Información financiera y memoria anual', texto: '' }),
    ];
    expect(mergeHechos(prev, fresh, today).map((h) => h.id)).toEqual(['b', 'scco-vacio', 'a', 'bvn-viejo']);
  });

  it('la tarea programada: la primera vez 30 días, después desde lo último; cada 3 horas y solo en los primeros 10 minutos', async () => {
    const { kv } = memoryKV();
    const { f, calls } = fakeFetch(() => ({ body: { Resultado: [row({ Fecha_Presentacion: '04/11/2026 09:00' })] } }));
    const at = (iso: string) => ({ kv, now: new Date(iso), fetch: f });
    expect(await refreshSmv(at('2026-11-04T15:20:00Z'))).toBe(false); // minuto 20: no intenta
    expect(await refreshSmv(at('2026-11-04T15:00:00Z'))).toBe(true);
    expect(calls[0]!.searchParams.get('sFechaInicio')).toBe('05/10/2026');
    expect(await refreshSmv(at('2026-11-04T16:00:00Z'))).toBe(false); // todavía fresco
    expect(await refreshSmv(at('2026-11-04T18:00:00Z'))).toBe(true);
    expect(calls[1]!.searchParams.get('sFechaInicio')).toBe('02/11/2026');
    const s = (await kv.get(SMV_KEY, 'json')) as Stored<SmvData>;
    expect(s.data.through).toBe('2026-11-04');
    expect(s.data.items).toHaveLength(1);
  });

  it('lo que ve el panel: la lista general (14 días) o los hechos de una empresa', () => {
    const now = new Date('2026-11-04T20:00:00Z');
    const stored: Stored<SmvData> = {
      fetchedAt: now.toISOString(),
      data: {
        through: '2026-11-04',
        items: [
          hecho({ id: 'bvn', empresa: 'COMPAÑIA DE MINAS BUENAVENTURA S.A.A.', at: '2026-11-04T10:00' }),
          hecho({ id: 'scco-vacio', empresa: 'SOUTHERN COPPER CORPORATION', at: '2026-11-03T10:00', tipo: 'Información financiera y memoria anual', texto: '' }),
          hecho({ id: 'bvn-viejo', empresa: 'COMPAÑIA DE MINAS BUENAVENTURA S.A.A.', at: '2026-09-30T10:00' }),
        ],
      },
    };
    const feed = shapeSmv(stored, now);
    expect(feed.items.map((h) => h.id)).toEqual(['bvn']);
    expect(feed.items[0]).toMatchObject({ nombre: 'Buenaventura', symbol: 'BVN' });
    expect(shapeSmv(stored, now, 'BVN').items.map((h) => h.id)).toEqual(['bvn', 'bvn-viejo']);
    expect(shapeSmv(stored, now, 'SCCO').issuer).toEqual({ symbol: 'SCCO', name: 'Southern Copper' });
    expect(shapeSmv(stored, now, 'AAPL')).toMatchObject({ issuer: null, items: [] });
    expect(shapeSmv(null, now)).toEqual({ fetchedAt: null, items: [] });
  });

  it('la ruta es pública: también para los amigos', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const get = async (path: string) => (await (await worker.fetch(new Request(`http://localhost${path}`), env, {} as ExecutionContext)).json()) as any;
    expect((await get('/api/smv')).items.length).toBeGreaterThan(3);
    const bvn = await get('/api/smv?symbol=bvn');
    expect(bvn.issuer).toEqual({ symbol: 'BVN', name: 'Buenaventura' });
    expect(bvn.items.every((h: { symbol: string }) => h.symbol === 'BVN')).toBe(true);
  });
});
