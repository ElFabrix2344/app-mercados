// Los datos que «Pregúntale a Rueda» le puede pedir al panel: solo los públicos, los mismos que ven los amigos (BCRP,
// FRED, las fechas oficiales del calendario, los titulares y los resultados de la SEC). Nada de precios de Twelve Data,
// de Finnhub, de Polymarket, de la cuenta Hapi ni de la cartera de nadie. Cada herramienta devuelve poco, a propósito:
// cada token que vuelve se paga.

import { ApiError } from '../lib/http';
import type { Herramienta } from '../lib/claude';
import { EVENTS, upcoming } from '../lib/calendar';
import type { FilingsData } from './filings';
import type { FinancialsData, FinancialPeriod } from './financials';
import { SYMBOL_RE, isUsEquity, type CurveData, type Fresh, type MarketSeries, type PeruData, type PeruMarkets, type UsaData } from './market';
import type { NewsData } from './news';

/** De dónde salen los datos: los servicios de verdad o, en local, los de prueba. */
export interface Fuentes {
  peru(): Promise<Fresh<PeruData>>;
  mercados(): Promise<Fresh<PeruMarkets>>;
  usa(): Promise<Fresh<UsaData>>;
  curva(): Promise<Fresh<CurveData>>;
  noticias(): Promise<Fresh<NewsData>>;
  resultados(symbol: string): Promise<Fresh<FinancialsData>>;
  reportes(symbol: string): Promise<Fresh<FilingsData>>;
}

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
const millones = (x: number | null | undefined) => (x == null ? null : Math.round(x / 1e5) / 10);
const sinArgumentos = { type: 'object' as const, properties: {}, additionalProperties: false as const };

/** Último dato y cuánto cambió en 1 y 12 meses: en % para precios e índices, en la unidad de la serie para tasas. */
function serie(s: MarketSeries, cambio: 'pct' | 'diff' = 'pct') {
  const { last, m1, y1 } = s.summary;
  if (!last) return null;
  const k = cambio === 'pct' ? 'pct' : 'puntos';
  const v = (c: typeof m1) => (c ? r2(cambio === 'pct' ? c.pct * 100 : c.diff) : null);
  return { fecha: last.date, valor: r2(last.value), [`cambio_1_mes_${k}`]: v(m1), [`cambio_12_meses_${k}`]: v(y1) };
}

const periodo = (p: FinancialPeriod | null) => p && { hasta: p.end, ingresos: millones(p.revenue), utilidad_operativa: millones(p.operatingIncome), utilidad_neta: millones(p.netIncome) };

/** Las herramientas de «Pregúntale a Rueda». `usadas` es cómo se le cuenta a la persona de dónde salió la respuesta. */
export const FUENTE_DE: Record<string, string> = { peru: 'BCRP', eeuu: 'FRED', calendario: 'calendario oficial', noticias: 'titulares', empresa: 'SEC' };

export function herramientas(f: Fuentes, now: Date, timeZone: string): Herramienta[] {
  return [
    {
      name: 'peru',
      description:
        'Perú, del BCRP: dólar interbancario (venta, en soles), tasa de referencia, inflación de Lima a 12 meses, lo que esperan los analistas ' +
        'a 12 meses, y con su cambio en 1 y 12 meses: cobre, oro, plata, zinc y petróleo WTI, reservas internacionales, índice de la Bolsa de ' +
        'Lima y bonos del Perú a 10 años.',
      input_schema: sinArgumentos,
      async run() {
        const [p, mk] = await Promise.all([f.peru(), f.mercados().catch(() => null)]);
        const fx = p.data.fx;
        const hace = fx.at(-22) ?? fx[0];
        const esp = p.data.expectations.at(-1);
        return JSON.stringify({
          fuente: 'BCRP',
          dolar_interbancario_venta: fx.length ? { fecha: fx.at(-1)!.date, soles: fx.at(-1)!.sell, hace_un_mes: hace?.sell ?? null } : null,
          tasa_de_referencia_pct: p.data.policyRate && { fecha: p.data.policyRate.date, valor: p.data.policyRate.value },
          inflacion_lima_12_meses_pct: p.data.inflation.slice(-4).map((x) => [x.date.slice(0, 7), r2(x.value)]),
          expectativas_a_12_meses: esp ? { encuesta: esp.date.slice(0, 7), inflacion_pct: r2(esp.inflation), pbi_pct: r2(esp.gdp), dolar: r2(esp.fx) } : null,
          mercados: mk && {
            cobre_usd_por_libra: serie(mk.data.copper),
            oro_usd_por_onza: serie(mk.data.gold),
            plata_usd_por_onza: serie(mk.data.silver),
            zinc_usd_por_libra: serie(mk.data.zinc),
            petroleo_wti_usd_por_barril: serie(mk.data.oil),
            reservas_internacionales_millones_usd: serie(mk.data.reserves),
            indice_general_bvl: serie(mk.data.bvl),
            bono_peru_10_anios_soles_pct: serie(mk.data.bond10pen, 'diff'),
            bono_peru_10_anios_dolares_pct: serie(mk.data.bond10usd, 'diff'),
          },
        });
      },
    },
    {
      name: 'eeuu',
      description: 'EE. UU., de FRED: bono del Tesoro a 10 años, tasa de la Fed, inflación anual de los últimos meses y la curva de rendimientos (10 años menos 2 años).',
      input_schema: sinArgumentos,
      async run() {
        const [u, cv] = await Promise.all([f.usa(), f.curva().catch(() => null)]);
        const t = u.data.treasury10y;
        const hoy = cv?.data.curves[0];
        return JSON.stringify({
          fuente: 'FRED',
          bono_10_anios_pct: t.length ? { fecha: t.at(-1)!.date, valor: t.at(-1)!.value, hace_un_mes: t.at(-22)?.value ?? null } : null,
          tasa_fed_pct: u.data.fedFunds && { fecha: u.data.fedFunds.date, valor: u.data.fedFunds.value },
          inflacion_anual_pct: u.data.cpiYoY.slice(-4).map((x) => [x.date.slice(0, 7), r2(x.value)]),
          curva_hoy_pct: hoy ? Object.fromEntries(cv!.data.tenors.map((plazo, i) => [plazo, hoy.values[i] ?? null])) : null,
          diferencia_10_menos_2_anios_puntos: cv?.data.spread10y2y.at(-1)?.[1] ?? null,
        });
      },
    },
    {
      name: 'calendario',
      description: 'Próximos anuncios oficiales: decisiones de tasas del BCRP y de la Fed, e inflación del Perú (INEI) y de EE. UU. (BLS), con su fecha.',
      input_schema: {
        type: 'object',
        properties: { dias: { type: 'integer', description: 'Cuántos días hacia adelante, de 1 a 60. Si no se indica, 30.' } },
        additionalProperties: false,
      },
      async run(input) {
        const dias = Math.min(60, Math.max(1, Math.round(Number(input.dias)) || 30));
        return JSON.stringify({
          hoy: now.toISOString().slice(0, 10),
          eventos: upcoming(EVENTS, now, dias, timeZone)
            .slice(0, 25)
            .map((e) => ({ fecha: e.date, quien: e.kind, que: e.title, ...(e.detail ? { detalle: e.detail } : {}), ...(e.tentative ? { tentativo: true } : {}) })),
        });
      },
    },
    {
      name: 'noticias',
      description: 'Los titulares de mercado más recientes (Perú, Latinoamérica, EE. UU. y global), con su medio y su fecha. Solo titulares, no la nota.',
      input_schema: sinArgumentos,
      async run() {
        const n = await f.noticias();
        return JSON.stringify({ titulares: n.data.items.slice(0, 18).map((x) => [x.publishedAt?.slice(0, 10) ?? null, x.source, x.title]) });
      },
    },
    {
      name: 'empresa',
      description:
        'Resultados de una empresa que reporta a la SEC, por su símbolo en EE. UU. (SCCO, AAPL, BAP): ingresos, utilidad operativa y utilidad neta ' +
        'de los últimos 12 meses, de los 12 anteriores, de sus últimos años fiscales y de sus últimos trimestres, en millones, más sus últimos ' +
        'reportes presentados. No trae el precio de la acción.',
      input_schema: {
        type: 'object',
        properties: { simbolo: { type: 'string', description: 'El símbolo, por ejemplo SCCO.' } },
        required: ['simbolo'],
        additionalProperties: false,
      },
      async run(input) {
        const symbol = String(input.simbolo ?? '').trim().toUpperCase();
        if (!SYMBOL_RE.test(symbol) || !isUsEquity(symbol)) throw new ApiError('bad_request', 400, 'Ese no es el símbolo de una acción (por ejemplo, SCCO o AAPL).');
        const d = (await f.resultados(symbol)).data;
        if (!d.cik) throw new ApiError('not_found', 404, `La SEC no tiene informes de ${symbol}: pasa con los ETF, los fondos y las empresas que no cotizan en EE. UU.`);
        const rep = await f.reportes(symbol).catch(() => null);
        return JSON.stringify({
          fuente: 'SEC EDGAR',
          empresa: d.name,
          moneda: d.currency,
          unidad: 'millones',
          ultimos_12_meses: periodo(d.ttm),
          los_12_meses_anteriores: periodo(d.ttmPrev),
          anios_fiscales: d.years.slice(-4).map((y) => ({ anio: y.year, ingresos: millones(y.revenue), utilidad_operativa: millones(y.operatingIncome), utilidad_neta: millones(y.netIncome) })),
          trimestres: d.quarters.slice(-5).map(periodo),
          ...(d.quarters.length ? {} : { nota: 'Solo presenta informes anuales (emisor extranjero): no hay trimestres.' }),
          ultimos_reportes: rep?.data.filings.slice(0, 5).map((x) => ({ fecha: x.date, formulario: x.form, ...(x.items.length ? { temas: x.items } : {}) })) ?? null,
        });
      },
    },
  ];
}
