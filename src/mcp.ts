// Conector de Claude: servidor MCP remoto en /mcp (Streamable HTTP, sin estado), dentro del Worker mercados-mcp.
// Usa las mismas fuentes, la misma caché en KV y el mismo freno de créditos que el panel.
// No autentica por su cuenta: mcp-worker.ts valida el token OAuth y el rol antes de llegar aquí.

import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Role } from './auth/access';
import { CALENDAR_UNTIL, EVENTS, SOURCES, sourcesFor, upcoming } from './lib/calendar';
import type { EarningsRelease } from './lib/finnhub';
import { ApiError } from './lib/http';
import { isoDate } from './lib/num';
import {
  mockCompany,
  mockCompanyCalendar,
  mockCompare,
  mockCurve,
  mockEodView,
  mockFactors,
  mockFinancials,
  mockForecastExtras,
  mockHistory,
  mockNews,
  mockPeru,
  mockPeruMarkets,
  mockPriceSource,
  mockQuotes,
  mockSymbolNews,
  mockUsa,
} from './mock';
import { companyData } from './services/company';
import { factorGrades } from './services/factors';
import { financials } from './services/financials';
import { eodView, knownSymbols } from './services/eod';
import { forecastView } from './services/forecasts';
import { companyCalendar, epsSurprise, MOMENT, quarterLabel } from './services/earnings';
import { marketNews, newsQuery, quoteName, symbolNews, type NewsItem } from './services/news';
import { kvSource, readTrades, valuePortfolio } from './services/portfolio';
import { buildSummary, publishSummary, SUMMARY_DAYS, SUMMARY_LIMITS } from './services/summary';
import {
  COMPARE_MAX,
  DAILY_CREDIT_CAP,
  DEFAULT_RANGE,
  MAX_SYMBOLS,
  RANGES,
  compare,
  compareSymbols,
  creditsUsed,
  curve,
  getWatchlist,
  history,
  isUsEquity,
  peru,
  peruMarkets,
  quotes,
  SYMBOL_RE,
  usa,
  type CompareResult,
  type Deps,
  type Fresh,
  type HistoryResult,
  type MarketSeries,
  type PeruMarkets,
  type PointChange,
} from './services/market';

export interface McpContext {
  deps: Deps;
  /** Datos ficticios (solo desarrollo local). */
  mock: boolean;
  /** Zona horaria en la que se muestran las horas. */
  timeZone: string;
  /** Los amigos solo reciben las herramientas de datos públicos (BCRP y FRED). */
  role: Role;
  /** Correo de quien usa el conector: con él se busca su nombre y sus pronósticos del grupo. */
  email?: string | null;
}

const INSTRUCTIONS =
  'Datos del panel personal «Rueda» del usuario: precios, historial con indicadores técnicos y comparación de los ' +
  'símbolos de su lista de seguimiento y de su lista diaria (Twelve Data), datos de sus empresas (Finnhub), resultados ' +
  'anuales de cualquier empresa que reporte a la SEC, Perú (BCRP), EE. UU. (FRED), el calendario económico y el juego de ' +
  'pronósticos del grupo. Con publicar_resumen se guarda el resumen del día que ven todos en el panel. Los datos pueden venir de la ' +
  'caché del panel: al responder, di ' +
  'la hora de «actualizado» y avisa si «dato_guardado» es true. Para precios de símbolos fuera de la lista usa otra fuente (por ' +
  'ejemplo, el conector de Twelve Data).';

const INSTRUCTIONS_FRIEND =
  'Datos públicos del panel «Rueda»: Perú (BCRP), EE. UU. (FRED), resultados anuales de empresas (SEC) y el calendario ' +
  'económico. Los datos pueden venir de ' +
  'la caché del panel: al responder, di la hora de «actualizado» y avisa si «dato_guardado» es true. Los precios de ' +
  'mercado no están disponibles en este conector para tu cuenta.';

export function handleMcp(req: Request, c: McpContext): Promise<Response> {
  const handler = createMcpHandler(() => buildServer(c), {
    responseMode: 'json',
    onerror: (e) => console.warn('MCP:', e.message),
  });
  return handler.fetch(req);
}

export function buildServer(c: McpContext): McpServer {
  const owner = c.role === 'owner';
  const server = new McpServer({ name: 'rueda', version: '0.13.0' }, { instructions: owner ? INSTRUCTIONS : INSTRUCTIONS_FRIEND });
  const when: When = (iso) => localTime(iso, c.timeZone);

  // Precios e historial (Twelve Data): solo para el dueño, por la licencia del plan gratis.
  if (owner) registerMarketTools(server, c, when);
  registerPublicTools(server, c, when);
  // La única herramienta que escribe: el resumen del día que publica la tarea programada del dueño.
  if (owner) registerSummaryTool(server, c);
  // Sin fechas cargadas, una herramienta de calendario vacía solo confundiría a Claude.
  if (EVENTS.length) registerCalendarTool(server, c);
  return server;
}

type When = (iso: string | null | undefined) => string | null;

function registerMarketTools(server: McpServer, c: McpContext, when: When): void {
  const { deps } = c;

  server.registerTool(
    'precios',
    {
      title: 'Precios de la lista de seguimiento',
      description:
        'Precios actuales de los símbolos de la lista de seguimiento del panel Rueda (acciones y ETF de EE. UU., divisas como ' +
        'USD/PEN, cripto como BTC/USD), de Twelve Data. Sin argumentos devuelve toda la lista. Sale de la caché del panel: las ' +
        'acciones solo se renuevan con la bolsa de Nueva York abierta y todo respeta el freno diario de créditos. ' +
        'variacion_pct está en puntos porcentuales (0.31 = +0,31 %). Las horas están en la zona horaria indicada.',
      inputSchema: z.object({
        simbolos: z
          .array(z.string().max(20))
          .max(MAX_SYMBOLS)
          .optional()
          .describe('Símbolos de la lista, p. ej. ["BAP", "USD/PEN"]. Si se omite, toda la lista.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ simbolos }) =>
      run(async () => {
        const list = await getWatchlist(deps.kv);
        const asked = simbolos?.length ? unique(simbolos.map(normalize)) : list;
        const inList = asked.filter((s) => list.includes(s));
        const outside = asked.filter((s) => !list.includes(s));
        if (!inList.length) throw notInList(outside, list);

        const r = c.mock ? mockQuotes(list, deps.now) : await quotes(deps, list, false, inList);
        const order = (s: string) => inList.indexOf(s);
        const shown = r.data.quotes.filter((q) => inList.includes(q.symbol)).sort((a, b) => order(a.symbol) - order(b.symbol));
        const fetched = inList.map((s) => r.data.fetched[s]).filter((t): t is string => !!t);
        return {
          fuente: 'Twelve Data',
          zona_horaria: c.timeZone,
          bolsa_nueva_york: r.market.open ? 'abierta' : 'cerrada',
          actualizado: when(fetched.sort().at(-1) ?? r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
          creditos_hoy: { usados: await creditsUsed(deps.kv, deps.now), freno: DAILY_CREDIT_CAP },
          precios: shown.map((q) => ({
            simbolo: q.symbol,
            nombre: q.name,
            bolsa: q.exchange,
            moneda: q.currency,
            precio: q.price,
            variacion: q.change,
            variacion_pct: round(q.changePct),
            cierre_anterior: q.prevClose,
            minimo_52_semanas: q.low52,
            maximo_52_semanas: q.high52,
            hora_del_precio: when(q.asOf),
          })),
          errores: Object.fromEntries(Object.entries(r.data.errors).filter(([s]) => inList.includes(s))),
          ...(outside.length ? { fuera_de_lista: { simbolos: outside, nota: `No están en la lista (${list.join(', ')}).` } } : {}),
        };
      }),
  );

  server.registerTool(
    'historial',
    {
      title: 'Historial (hasta 5 años)',
      description:
        'Cierres diarios de un símbolo de la lista de seguimiento en el rango pedido (1M, 3M, 6M, YTD, 1A, 3A o 5A; Twelve Data, ' +
        'guardados hasta 12 h) y sus estadísticas para ese rango: rendimiento total (medido desde el cierre anterior al inicio), ' +
        'volatilidad anualizada de los rendimientos diarios, máxima caída desde un pico previo, mejor y peor día, y cierres ' +
        'máximo y mínimo. También los indicadores técnicos del último cierre, calculados con los 5 años guardados: medias ' +
        'móviles simples de 50 y 200 días (y la distancia del cierre a cada una), RSI de 14 días (Wilder) y bandas de ' +
        'Bollinger de 20 días y 2 desviaciones (posicion_pct: 0 = banda inferior, 100 = banda superior), MACD (12, 26, 9: ' +
        'línea, señal e histograma) y el volumen de ese día (consolidado de las bolsas de EE. UU.; null en divisas). ' +
        'Los porcentajes vienen en puntos porcentuales (12.5 = +12,5 %).',
      inputSchema: z.object({
        simbolo: z.string().max(20).describe('Símbolo de la lista, p. ej. "BAP" o "USD/PEN".'),
        rango: z.enum(RANGES).default(DEFAULT_RANGE).describe('Periodo: 1M, 3M, 6M, YTD (año en curso), 1A (por defecto), 3A o 5A.'),
        cierres: z
          .enum(['ninguno', 'mensual', 'diario'])
          .default('mensual')
          .describe('Cierres a incluir además de las estadísticas: ninguno, el último de cada mes (por defecto) o todos los diarios (~250 por año).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ simbolo, rango, cierres }) =>
      run(async () => {
        const list = await knownSymbols(deps.kv);
        const symbol = normalize(simbolo);
        if (!list.includes(symbol)) throw notInList([symbol], list, BOTH);

        const r = c.mock ? mockHistory(symbol, deps.now, rango) : await history(deps, symbol, rango);
        const pts = r.data.points;
        const st = r.stats;
        return {
          fuente: 'Twelve Data (cierres diarios)',
          simbolo: symbol,
          rango: r.range,
          desde: pts[0]?.[0] ?? null,
          hasta: pts.at(-1)?.[0] ?? null,
          observaciones: pts.length,
          estadisticas: st && {
            primer_cierre: st.first,
            ultimo_cierre: st.last,
            rendimiento_total_pct: pct(st.totalReturn),
            volatilidad_anual_pct: st.annualVol === null ? null : pct(st.annualVol),
            maxima_caida: st.maxDrawdown && {
              pct: pct(st.maxDrawdown.value),
              desde_el_pico_del: st.maxDrawdown.peakDate,
              hasta_el: st.maxDrawdown.troughDate,
            },
            mejor_dia: st.bestDay && { fecha: st.bestDay.date, variacion_pct: pct(st.bestDay.ret) },
            peor_dia: st.worstDay && { fecha: st.worstDay.date, variacion_pct: pct(st.worstDay.ret) },
            cierre_maximo: { fecha: st.maxClose.date, valor: st.maxClose.value },
            cierre_minimo: { fecha: st.minClose.date, valor: st.minClose.value },
          },
          indicadores_ultimo_cierre: indicatorSnapshot(r),
          ...(cierres === 'ninguno' ? {} : { cierres: cierres === 'diario' ? pts : monthEnds(pts) }),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );

  server.registerTool(
    'comparar',
    {
      title: 'Comparar símbolos (rendimiento y correlación)',
      description:
        `Compara de 2 a ${COMPARE_MAX} símbolos de la lista de seguimiento en un rango (1M, 3M, 6M, YTD, 1A, 3A o 5A): ` +
        'rendimiento total, volatilidad anualizada y máxima caída de cada uno, y la correlación de sus rendimientos diarios ' +
        '(de −1 a 1). Usa solo los días en que todos tienen cierre (la cripto también cotiza los fines de semana), así que ' +
        'las cifras pueden diferir un poco de las de historial. Incluye la evolución en base 100 (100 = primer día común) ' +
        'al cierre de cada mes. Los porcentajes vienen en puntos porcentuales (12.5 = +12,5 %).',
      inputSchema: z.object({
        simbolos: z
          .array(z.string().max(20))
          .min(2)
          .max(COMPARE_MAX)
          .describe('De 2 a 4 símbolos de la lista, p. ej. ["BAP", "SPY"].'),
        rango: z.enum(RANGES).default(DEFAULT_RANGE).describe('Periodo: 1M, 3M, 6M, YTD (año en curso), 1A (por defecto), 3A o 5A.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ simbolos, rango }) =>
      run(async () => {
        const list = await knownSymbols(deps.kv);
        const symbols = compareSymbols(simbolos);
        const outside = symbols.filter((s) => !list.includes(s));
        if (outside.length) throw notInList(outside, list, BOTH);

        const r = c.mock ? mockCompare(symbols, deps.now, rango) : await compare(deps, symbols, rango);
        const names = r.series.map((s) => s.symbol);
        return {
          fuente: 'Twelve Data (cierres diarios)',
          rango: r.range,
          desde: r.dates[0] ?? null,
          hasta: r.dates.at(-1) ?? null,
          dias_en_comun: r.dates.length,
          simbolos: r.series.map((s) => ({
            simbolo: s.symbol,
            primer_cierre: s.closes[0] ?? null,
            ultimo_cierre: s.closes.at(-1) ?? null,
            rendimiento_total_pct: s.stats && pct(s.stats.totalReturn),
            volatilidad_anual_pct: s.stats?.annualVol == null ? null : pct(s.stats.annualVol),
            maxima_caida_pct: s.stats?.maxDrawdown == null ? null : pct(s.stats.maxDrawdown),
          })),
          correlacion_rendimientos_diarios: { simbolos: names, matriz: r.correlation },
          base_100_cierre_de_mes: { columnas: ['fecha', ...names], filas: rebasedMonthEnds(r) },
          ...(Object.keys(r.errors).length ? { errores: r.errors } : {}),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.notes.join(' ') || null,
        };
      }),
  );

  server.registerTool(
    'cartera',
    {
      title: 'Cartera simulada',
      description:
        'Cartera simulada del usuario: sus compras y ventas (fecha, cantidad y precio en US$) valorizadas con los últimos precios ' +
        'guardados del panel. Trae las posiciones abiertas (cantidad, costo promedio, precio, valor y ganancia), lo ganado en ' +
        'ventas, los totales en US$ y en soles, y la comparación con haber hecho las mismas compras y ventas en el S&P 500 (SPY). ' +
        'Costo promedio, sin dividendos ni comisiones. Porcentajes en puntos porcentuales (12.5 = +12,5 %). Solo lectura: las ' +
        'operaciones se cargan en el panel.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const list = await getWatchlist(deps.kv);
        const src = c.mock ? mockPriceSource(list, deps.now) : kvSource(deps);
        const p = await valuePortfolio(await readTrades(deps.kv), src);
        const t = p.totals;
        return {
          moneda: 'US$',
          operaciones: p.trades.map((x) => ({ fecha: x.date, operacion: x.side === 'buy' ? 'compra' : 'venta', simbolo: x.symbol, cantidad: x.qty, precio: x.price })),
          posiciones: p.positions.map((x) => ({
            simbolo: x.symbol,
            cantidad: x.qty,
            costo_promedio: x.avgCost,
            precio: x.price,
            valor: x.value,
            ganancia: x.gain,
            ganancia_pct: x.ret === null ? null : pct(x.ret),
            ganancia_realizada: x.realized,
          })),
          totales: t && {
            invertido: t.invested,
            valor_actual: t.value,
            cobrado_en_ventas: t.proceeds,
            total: t.total,
            ganancia: t.gain,
            rendimiento_pct: pct(t.ret),
            ganancia_realizada: t.realized,
            ganancia_no_realizada: t.unrealized,
          },
          en_soles:
            t && p.fx
              ? { tipo_de_cambio: p.fx.rate, fuente: p.fx.source, total: Math.round(t.total * p.fx.rate * 100) / 100, ganancia: Math.round(t.gain * p.fx.rate * 100) / 100 }
              : null,
          frente_al_sp500:
            t && p.benchmark
              ? { total_si_fuera_spy: p.benchmark.total, rendimiento_spy_pct: pct(p.benchmark.ret), diferencia_pts: pct(t.ret - p.benchmark.ret) }
              : null,
          precios_de: when(p.pricesAt),
          notas: p.notes,
        };
      }),
  );

  server.registerTool(
    'empresa',
    {
      title: 'Datos de una empresa de la lista',
      description:
        'Datos de Finnhub (guardados hasta 24 h) de una acción de la lista: perfil, capitalización (en millones), PER y BPA de ' +
        'los últimos 12 meses, precio/valor contable, precio/ventas, beta, dividendo, márgenes, ROE, crecimiento de ingresos ' +
        'y del BPA, máximo y mínimo de 52 semanas, recomendaciones de los analistas de los últimos meses, sorpresas del BPA ' +
        'de los últimos 4 trimestres y empresas comparables. Porcentajes en puntos porcentuales (12.5 = 12,5 %); montos en ' +
        'la moneda en que reporta la empresa. Los ETF casi no traen datos; las divisas y la cripto, ninguno.',
      inputSchema: z.object({ simbolo: z.string().max(20).describe('Símbolo de la lista, p. ej. "BAP".') }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ simbolo }) =>
      run(async () => {
        const list = await knownSymbols(deps.kv);
        const symbol = normalize(simbolo);
        if (!list.includes(symbol)) throw notInList([symbol], list, BOTH);
        const r = c.mock ? mockCompany(symbol, deps.now) : await companyData(deps, symbol);
        if (!r.enabled || !r.applicable) return { simbolo: symbol, nota: r.note };
        const { profile: p, metrics: m } = r.data;
        return {
          fuente: 'Finnhub',
          simbolo: symbol,
          perfil: p && {
            nombre: p.name,
            sector: p.industry,
            pais: p.country,
            moneda: p.currency,
            bolsa: p.exchange,
            salida_a_bolsa: p.ipo,
            web: p.weburl,
            capitalizacion_millones: p.marketCap,
            acciones_en_circulacion_millones: p.sharesOutstanding,
          },
          indicadores: m && {
            per_12m: m.pe,
            precio_valor_contable: m.pb,
            precio_ventas: m.ps,
            beta: m.beta,
            dividendo_pct: m.dividendYield,
            bpa_12m: m.eps,
            margen_neto_pct: m.netMargin,
            margen_operativo_pct: m.operatingMargin,
            roe_pct: m.roe,
            crecimiento_ingresos_pct: m.revenueGrowth,
            crecimiento_bpa_pct: m.epsGrowth,
            maximo_52s: m.high52 !== null ? { valor: m.high52, fecha: m.high52Date } : null,
            minimo_52s: m.low52 !== null ? { valor: m.low52, fecha: m.low52Date } : null,
          },
          analistas: r.data.recommendations.map((x) => ({
            mes: x.period.slice(0, 7),
            compra_fuerte: x.strongBuy,
            compra: x.buy,
            mantener: x.hold,
            venta: x.sell,
            venta_fuerte: x.strongSell,
          })),
          sorpresas_bpa: r.data.surprises.map((x) => ({
            trimestre_fiscal: x.quarter && x.year ? `${x.quarter}T ${x.year}` : null,
            cierre_del_periodo: x.period,
            bpa_real: x.actual,
            bpa_esperado: x.estimate,
            sorpresa_pct: x.surprisePct === null ? null : round(x.surprisePct),
          })),
          comparables: r.data.peers,
          notas_por_factores: await (async () => {
            // Un extra: si falla, lo demás se responde igual.
            const g = c.mock ? mockFactors(symbol, deps.now) : await factorGrades(deps, symbol).catch(() => null);
            if (!g || !g.enabled || !g.applicable) return null;
            return {
              comparables_usadas: g.data.peers,
              notas: Object.fromEntries(g.data.factors.map((f) => [f.label.toLowerCase(), f.grade])),
              como_se_calcula: 'Percentil de cada indicador dentro del grupo (la empresa y sus comparables); A = 20 % mejor, F = 20 % peor.',
            };
          })(),
          ...(Object.keys(r.data.errors).length ? { partes_con_error: r.data.errors } : {}),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );

  server.registerTool(
    'lista_diaria',
    {
      title: 'Lista diaria (cierres)',
      description:
        'Símbolos de la lista diaria del panel Rueda (hasta 20, aparte de la lista de seguimiento): último cierre, su fecha, ' +
        'variación frente al cierre anterior y rendimiento de 1 año. Se actualizan una vez al día, después del cierre de ' +
        'Nueva York (cripto y divisas, con el cierre del día anterior): no son precios en vivo. Para el historial, ' +
        'indicadores o datos de empresa de uno de ellos, usa historial o empresa. variacion_pct y rendimiento_1a_pct en ' +
        'puntos porcentuales (0.31 = +0,31 %).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const v = c.mock ? await mockEodView(deps.kv, deps.now) : await eodView(deps.kv);
        return {
          fuente: 'Twelve Data (cierres diarios)',
          simbolos: v.symbols,
          maximo: v.max,
          cierres: v.rows.map((r) =>
            r.pending
              ? { simbolo: r.symbol, pendiente: true }
              : {
                  simbolo: r.symbol,
                  nombre: r.name,
                  fecha: r.date,
                  cierre: r.close,
                  variacion: r.change === null ? null : round(r.change),
                  variacion_pct: round(r.changePct),
                  rendimiento_1a_pct: r.ret1y === null ? null : pct(r.ret1y),
                },
          ),
          ...(v.symbols.length ? {} : { nota: 'La lista diaria está vacía: se arma en el panel Rueda.' }),
        };
      }),
  );
}

/** Indicadores técnicos del último cierre (el mismo en cualquier rango). */
function indicatorSnapshot(r: HistoryResult) {
  const last = r.data.points.at(-1);
  if (!last) return null;
  const [fecha, cierre] = last;
  const at = (xs: (number | null)[]) => xs.at(-1) ?? null;
  const mm50 = at(r.indicators.sma50);
  const mm200 = at(r.indicators.sma200);
  const sup = at(r.indicators.bbUpper);
  const inf = at(r.indicators.bbLower);
  const vs = (m: number | null) => (m ? pct(cierre / m - 1) : null);
  return {
    fecha,
    cierre,
    mm50,
    mm200,
    cierre_vs_mm50_pct: vs(mm50),
    cierre_vs_mm200_pct: vs(mm200),
    rsi14: round(at(r.indicators.rsi14)),
    macd: at(r.indicators.macd) === null ? null : { linea: round(at(r.indicators.macd)), senal: round(at(r.indicators.macdSignal)), histograma: round(at(r.indicators.macdHist)) },
    volumen: r.bars?.volume.at(-1) ?? null,
    bollinger:
      sup !== null && inf !== null
        ? { superior: sup, inferior: inf, posicion_pct: sup > inf ? Math.round(((cierre - inf) / (sup - inf)) * 1000) / 10 : null }
        : null,
  };
}

/**
 * Una serie de mercado del BCRP para Claude: último dato, variaciones y cierre de cada mes. Las variaciones van en %
 * (precios e índices), en puntos porcentuales (tasas) o en puntos básicos (el spread).
 */
function marketOut(s: MarketSeries, unit: 'pct' | 'pp' | 'pb' = 'pct') {
  const { last, m1, y1 } = s.summary;
  const change = (c: PointChange | null) => c && (unit === 'pct' ? pct(c.pct) : unit === 'pp' ? round(c.diff) : Math.round(c.diff));
  return {
    fecha: last?.date ?? null,
    valor: last?.value ?? null,
    [`variacion_1_mes_${unit}`]: change(m1),
    [`variacion_12_meses_${unit}`]: change(y1),
    cierres_mensuales: monthEnds(s.points),
  };
}

/** Base 100 del primer día común y del último día de cada mes. */
function rebasedMonthEnds(r: CompareResult): (string | number | null)[][] {
  const byMonth = new Map<string, number>();
  r.dates.forEach((d, i) => byMonth.set(d.slice(0, 7), i));
  const idx = [...new Set([0, ...byMonth.values()])].filter((i) => i < r.dates.length);
  return idx.map((i) => [r.dates[i]!, ...r.series.map((s) => round(s.rebased[i] ?? null))]);
}

function registerPublicTools(server: McpServer, c: McpContext, when: When): void {
  const { deps } = c;

  server.registerTool(
    'peru_bcrp',
    {
      title: 'Perú: dólar, tasas, inflación, cobre, oro, reservas y BVL (BCRP)',
      description:
        'Datos del Banco Central de Reserva del Perú (BCRPData, guardados hasta 6 h): tipo de cambio interbancario del dólar ' +
        '(compra y venta en soles, últimos ~30 días hábiles), tasa de referencia de política monetaria (%), inflación de Lima ' +
        'Metropolitana a 12 meses (%, últimos 13 meses), lo que esperan los analistas a 12 meses según la encuesta de ' +
        'expectativas del BCRP (inflación y PBI en %, tipo de cambio en soles; últimos 6 meses) y, en «mercados», cobre y ' +
        'oro en Londres, reservas internacionales ' +
        'netas, índice general de la Bolsa de Valores de Lima, rendimiento del bono del gobierno peruano a 10 años (en soles ' +
        'y en dólares) y un riesgo país aproximado (bono peruano en dólares menos Tesoro de EE. UU., ambos a 10 años, en ' +
        'puntos básicos; no es el EMBIG, que el BCRP no actualiza desde el 3 de setiembre de 2026). Para cada uno: último ' +
        'dato, variación a 1 y 12 meses (_pct en % con 12.5 = +12,5 %; _pp en puntos porcentuales; _pb en puntos básicos) y ' +
        'el cierre de cada mes del último año.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const r = c.mock ? mockPeru(deps.now) : await peru(deps);
        // Los mercados van aparte: si el BCRP falla con ellos, igual se entrega lo demás.
        let mk: Fresh<PeruMarkets> | null = null;
        let mkError: string | null = null;
        try {
          mk = c.mock ? mockPeruMarkets(deps.now) : await peruMarkets(deps);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          mkError = e.message;
        }
        const last = r.data.fx.at(-1);
        return {
          fuente: 'BCRP (BCRPData)',
          dolar_interbancario: last ? { fecha: last.date, compra: last.buy, venta: last.sell } : null,
          dolar_ultimos_dias: { columnas: ['fecha', 'compra', 'venta'], filas: r.data.fx.map((p) => [p.date, p.buy, p.sell]) },
          tasa_de_referencia_pct: r.data.policyRate && { fecha: r.data.policyRate.date, valor: r.data.policyRate.value },
          inflacion_lima_12_meses_pct: r.data.inflation.map((p) => [p.date.slice(0, 7), round(p.value)]),
          // Encuesta de expectativas del BCRP: lo que esperan analistas y empresas a 12 meses (mes de la encuesta).
          expectativas_analistas_12_meses: (r.data.expectations ?? []).slice(-6).map((e) => ({
            mes: e.date.slice(0, 7),
            inflacion_pct: round(e.inflation),
            pbi_pct: round(e.gdp),
            tipo_de_cambio: e.fx === null ? null : Math.round(e.fx * 1000) / 1000,
          })),
          mercados: mk && {
            cobre_usd_por_libra: marketOut(mk.data.copper),
            oro_usd_por_onza_troy: marketOut(mk.data.gold),
            reservas_internacionales_netas_millones_usd: marketOut(mk.data.reserves),
            indice_general_bvl: marketOut(mk.data.bvl),
            bono_peru_10_anios_soles_pct: marketOut(mk.data.bond10pen, 'pp'),
            bono_peru_10_anios_dolares_pct: marketOut(mk.data.bond10usd, 'pp'),
            riesgo_pais_aproximado_pb: marketOut(mk.data.spread10, 'pb'),
            actualizado: when(mk.fetchedAt),
            dato_guardado: mk.stale,
          },
          ...(mkError ? { mercados_error: mkError } : {}),
          series: {
            compra: 'PD04637PD',
            venta: 'PD04638PD',
            tasa_de_referencia: 'PD12301MD',
            inflacion: 'PN01273PM',
            expectativas: 'PD12912AM (inflación), PD38048AM (PBI), PD38049AM (tipo de cambio)',
            cobre: 'PD04701XD (centavos de US$ por libra, aquí convertido a US$)',
            oro: 'PD04704XD',
            reservas: 'PD04650MD',
            bvl: 'PD38026MD',
            bono_soles: 'PD31893DD',
            bono_dolares: 'PD31894DD',
            riesgo_pais_aproximado: 'PD31894DD − PD04719XD (Tesoro de EE. UU. a 10 años)',
          },
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );

  server.registerTool(
    'eeuu_fred',
    {
      title: 'EE. UU.: bono a 10 años, tasa de la Fed e inflación (FRED)',
      description:
        'Datos de FRED (Reserva Federal de St. Louis, guardados hasta 6 h): curva del Tesoro de 1 mes a 30 años (hoy, hace ' +
        'un mes y hace un año, con la diferencia 10 años − 2 años), rendimiento del bono del Tesoro a 10 años (%, ' +
        'últimos ~60 días hábiles), tasa efectiva de fondos federales (%) e inflación anual del IPC (%, últimos 13 meses).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const r = c.mock ? mockUsa(deps.now) : await usa(deps);
        // La curva es un extra: si falla, lo demás se responde igual.
        const cv = c.mock ? mockCurve(deps.now) : await curve(deps).catch(() => null);
        const t10 = r.data.treasury10y;
        return {
          fuente: 'FRED (Reserva Federal de St. Louis)',
          bono_10_anios_pct: t10.length ? { fecha: t10.at(-1)!.date, valor: t10.at(-1)!.value } : null,
          bono_10_anios_serie: t10.map((p) => [p.date, p.value]),
          tasa_fed_pct: r.data.fedFunds && { fecha: r.data.fedFunds.date, valor: r.data.fedFunds.value },
          inflacion_anual_pct: r.data.cpiYoY.map((p) => [p.date.slice(0, 7), round(p.value)]),
          curva_rendimientos: cv && {
            plazos: cv.data.tenors,
            curvas: cv.data.curves.map((k) => ({ cuando: k.label, fecha: k.date, tasas_pct: k.values })),
            diferencia_10a_2a_pp: cv.data.spread10y2y.at(-1) ?? null,
            nota: 'Diferencia negativa = curva invertida.',
          },
          series: { bono_10_anios: 'DGS10', tasa_fed: 'DFF', inflacion: 'CPIAUCSL (variación % a 12 meses)', curva: 'DGS1MO … DGS30' },
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );

  server.registerTool(
    'resultados_anuales',
    {
      title: 'Resultados anuales de una empresa (SEC)',
      description:
        'Ingresos, utilidad operativa y utilidad neta por año fiscal (hasta 12 años) de cualquier empresa que reporte a la SEC ' +
        'de EE. UU.: el 10-K de las de EE. UU. y el 20-F o 40-F de las extranjeras que cotizan allá (p. ej. SCCO, BVN, BAP, ' +
        'IFS). Datos públicos de SEC EDGAR, guardados hasta 7 días. Montos completos (no en millones) en la moneda en que ' +
        'reporta la empresa (USD, PEN…), tal como figuran en sus informes; los bancos no reportan ingresos como las demás. ' +
        'Los ETF y los fondos no tienen.',
      inputSchema: z.object({ simbolo: z.string().max(20).describe('Símbolo de la acción, p. ej. "SCCO" o "AAPL".') }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ simbolo }) =>
      run(async () => {
        const symbol = normalize(simbolo);
        if (!SYMBOL_RE.test(symbol) || !isUsEquity(symbol)) throw new ApiError('bad_request', 400, 'Escribe el símbolo de una acción, como SCCO o AAPL.');
        const r = c.mock ? mockFinancials(symbol, deps.now) : await financials(deps, symbol);
        const d = r.data;
        const lastEnd = d.years.at(-1)?.end;
        return {
          fuente: 'SEC EDGAR (informes anuales)',
          simbolo: symbol,
          empresa: d.name,
          cik: d.cik,
          norma: d.standard === 'ifrs-full' ? 'NIIF' : d.standard === 'us-gaap' ? 'US GAAP' : null,
          moneda: d.currency,
          anios: d.years.map((y) => ({
            anio_fiscal: y.year,
            cierre: y.end,
            ingresos: y.revenue,
            utilidad_operativa: y.operatingIncome,
            utilidad_neta: y.netIncome,
            margen_neto_pct: y.revenue !== null && y.revenue > 0 && y.netIncome !== null ? pct(y.netIncome / y.revenue) : null,
          })),
          ...(d.cik ? {} : { sin_datos: 'La SEC no tiene informes anuales de este símbolo (pasa con los ETF y los fondos).' }),
          ...(lastEnd && Date.parse(lastEnd) < deps.now.getTime() - 485 * 86_400_000
            ? { aviso: `Los datos de la SEC llegan hasta el año fiscal ${d.years.at(-1)!.year}: el informe del año siguiente todavía no aparece en ellos.` }
            : {}),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );

  server.registerTool(
    'noticias',
    {
      title: 'Noticias del mercado',
      description:
        'Titulares recientes de medios económicos (Bloomberg, WSJ, MarketWatch, CNBC, Gestión y Bloomberg Línea) con medio, hora, ' +
        'enlace y un resumen corto cuando el medio lo da. Sin símbolo: noticias generales, filtrables por grupo (latam: Perú y ' +
        'Latinoamérica; eeuu; global). Con un símbolo de la lista (solo el dueño de la app): titulares de esa empresa, de ' +
        'Yahoo Finance y Google News. Son solo titulares: para el detalle hay que abrir el enlace (algunos medios tienen muro ' +
        'de pago). Sirven para explicar movimientos de precios junto con las otras herramientas.',
      inputSchema: z.object({
        grupo: z.enum(['todas', 'latam', 'eeuu', 'global']).default('todas').describe('Qué noticias generales: todas (por defecto), latam, eeuu o global.'),
        cantidad: z.number().int().min(1).max(30).default(15).describe('Cuántos titulares (por defecto 15).'),
        simbolo: z.string().max(20).optional().describe('Símbolo de la lista para ver solo sus noticias, p. ej. "BAP" (solo el dueño).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ grupo, cantidad, simbolo }) =>
      run(async () => {
        const item = (n: NewsItem) => ({ titular: n.title, medio: n.source, hora: when(n.publishedAt), enlace: n.url, ...(n.summary ? { resumen: n.summary } : {}) });
        if (simbolo) {
          if (c.role !== 'owner') throw new ApiError('forbidden', 403, 'Las noticias por acción son solo para el dueño de la app.');
          const list = await knownSymbols(deps.kv);
          const symbol = normalize(simbolo);
          if (!list.includes(symbol)) throw notInList([symbol], list, BOTH);
          const name = c.mock ? null : await quoteName(deps.kv, symbol);
          const items = c.mock ? mockSymbolNews(symbol, deps.now) : await symbolNews(deps, symbol, name, cantidad);
          return { simbolo: symbol, busqueda: newsQuery(symbol, name), zona_horaria: c.timeZone, noticias: items.slice(0, cantidad).map(item) };
        }
        const r = c.mock ? mockNews(deps.now) : await marketNews(deps);
        const items = r.data.items.filter((n) => grupo === 'todas' || n.group === grupo).slice(0, cantidad);
        return {
          zona_horaria: c.timeZone,
          grupo,
          noticias: items.map(item),
          ...(Object.keys(r.data.errors).length ? { fuentes_con_error: r.data.errors } : {}),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
        };
      }),
  );

  server.registerTool(
    'pronosticos',
    {
      title: 'Pronósticos del grupo',
      description:
        'El juego de pronósticos del panel Rueda (sin plata, con datos públicos): decisiones de tasa del BCRP y de la Fed ' +
        '(sube, mantiene o baja), inflación a 12 meses de Lima (INEI) y de EE. UU. (BLS, con un decimal) y el dólar ' +
        'interbancario del BCRP al cierre de cada mes. Trae las preguntas abiertas (cuántos pronosticaron y el pronóstico ' +
        'de quien pregunta; los de los demás se ven recién al cierre), las cerradas con lo que puso cada uno, las resueltas ' +
        'con el resultado y los puntos, y el ranking. Puntos: 10 por acertar la decisión; en los números, 10 menos 1 por ' +
        'cada 0,05 pp de error (inflación) o por cada medio céntimo (dólar). Solo lectura: se juega en el panel.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        if (!c.email) throw new ApiError('forbidden', 401, 'No se sabe quién pregunta: vuelve a conectar el conector.');
        const v = await forecastView(deps.kv, c.email, deps.now, c.mock ? mockForecastExtras(deps.now) : {});
        const at = (iso: string) => localTime(iso, c.timeZone);
        const entries = (q: (typeof v.questions)[number]) => q.entries?.map((e) => ({ nombre: e.alias, pronostico: e.value, ...(e.points !== null ? { puntos: e.points } : {}) }));
        return {
          zona_horaria: c.timeZone,
          tu_nombre: v.me.alias,
          abiertas: v.questions
            .filter((q) => q.status === 'open')
            .map((q) => ({ pregunta: q.title, fecha: q.date, cierra: at(q.closesAt), pronosticaron: q.count, tu_pronostico: q.mine })),
          cerradas: v.questions
            .filter((q) => q.status === 'closed')
            .map((q) => ({ pregunta: q.title, fecha: q.date, pronosticos: entries(q), consenso: q.consensus, tu_pronostico: q.mine })),
          resueltas: v.questions
            .filter((q) => q.status === 'resolved')
            .map((q) => ({ pregunta: q.title, fecha: q.date, resultado: q.result, pronosticos: entries(q), tus_puntos: q.minePoints })),
          ranking: v.ranking.map((r) => ({ nombre: r.alias, puntos: r.points, pronosticos_resueltos: r.count, ...(r.mine ? { eres_tu: true } : {}) })),
        };
      }),
  );

}

/** `publicar_resumen`: solo el dueño (su tarea programada de cada mañana). Lo publicado lo ven también los amigos. */
function registerSummaryTool(server: McpServer, c: McpContext): void {
  const { deps } = c;
  const L = SUMMARY_LIMITS;
  server.registerTool(
    'publicar_resumen',
    {
      title: 'Publicar el resumen del día en Rueda',
      description:
        `Guarda el «Resumen del día» que se ve arriba en el panel Rueda, para el dueño y para sus amigos. Reemplaza el de ` +
        `hoy si ya había (la fecha la pone Rueda: hoy, hora de Lima) y se guardan los últimos ${SUMMARY_DAYS} días. Reglas: ` +
        '(1) usa solo información pública: los titulares generales de la herramienta noticias (sin símbolo), peru_bcrp, ' +
        'eeuu_fred y calendario. Nunca uses precios, historial, comparar, cartera, lista_diaria ni empresa: sus licencias no ' +
        'permiten mostrar esos datos a otras personas. (2) No inventes cifras: usa solo las que salen de esas herramientas o ' +
        'de los titulares. (3) Texto plano en español, sin Markdown. (4) En fuentes van los enlaces de los titulares que ' +
        'usaste, tal como los da noticias (o de una fuente oficial: BCRP, INEI, SMV, Fed, BLS, FRED o SEC); otros dominios ' +
        'se rechazan.',
      inputSchema: z.object({
        titulo: z.string().max(L.title[1]).describe(`Titular del día, como el de un diario (${L.title[0]} a ${L.title[1]} caracteres).`),
        texto: z
          .string()
          .max(L.text[1])
          .describe(`Un párrafo de 3 a 6 frases con lo más importante de ayer y lo que viene hoy (${L.text[0]} a ${L.text[1]} caracteres).`),
        puntos: z
          .array(z.string().max(L.point[1]))
          .max(L.points)
          .default([])
          .describe(`Opcional: hasta ${L.points} puntos cortos (por ejemplo Perú, EE. UU. y la agenda de hoy), sin viñetas.`),
        fuentes: z
          .array(z.object({ enlace: z.string().max(600).describe('Enlace del titular.'), titular: z.string().max(L.sourceTitle).optional().describe('Titular de la nota.') }))
          .min(1)
          .max(L.sources)
          .describe(`De 1 a ${L.sources} fuentes: los titulares que usaste.`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ titulo, texto, puntos, fuentes }) =>
      run(async () => {
        // Los titulares de la caché dan el título y el medio de cada enlace. Si no se pueden leer, se aceptan igual los
        // enlaces de los medios y fuentes oficiales conocidos.
        let news: NewsItem[] = [];
        try {
          news = (c.mock ? mockNews(deps.now) : await marketNews(deps)).data.items;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
        }
        const draft = { title: titulo, text: texto, points: puntos, sources: fuentes.map((f) => ({ url: f.enlace, title: f.titular })) };
        const s = buildSummary(draft, news, deps.now, c.timeZone);
        const store = await publishSummary(deps.kv, s);
        return {
          publicado: true,
          fecha: s.date,
          titulo: s.title,
          fuentes: s.sources.map((x) => ({ medio: x.source, titular: x.title })),
          dias_guardados: store.items.length,
          nota: 'Ya se ve arriba en el panel Rueda, también para los amigos.',
        };
      }),
  );
}

function registerCalendarTool(server: McpServer, c: McpContext): void {
  const owner = c.role === 'owner';
  server.registerTool(
    'calendario',
    {
      title: owner ? 'Calendario económico y resultados de tu lista' : 'Calendario económico (BCRP, Fed e inflación de Perú y EE. UU.)',
      description:
        'Próximas fechas oficiales: decisiones de tasa del BCRP (Programa Monetario) y de la Reserva Federal (FOMC), y ' +
        'publicación de la inflación de Lima Metropolitana (INEI) y de EE. UU. (BLS). La hora va en la zona horaria indicada ' +
        'cuando la fuente la publica. «cobertura» dice hasta qué fecha está cargado cada calendario: más allá no hay datos.' +
        (owner
          ? ' También trae las fechas de resultados trimestrales de las acciones de la lista (Finnhub, solo para el dueño), ' +
            'con el momento del día y el BPA e ingresos que esperan los analistas (ajustados, no GAAP, en la moneda en que ' +
            'reporta cada empresa; el trimestre es el fiscal). En «resultados_empresas.recientes» va el último resultado ' +
            'del último mes de cada empresa, con lo esperado, lo real y la sorpresa del BPA.'
          : ''),
      inputSchema: z.object({
        dias: z.number().int().min(1).max(366).default(60).describe('Cuántos días hacia adelante (por defecto 60).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: owner },
    },
    ({ dias }) =>
      run(async () => {
        const { deps } = c;
        let companies = null;
        if (owner) {
          const list = await knownSymbols(deps.kv);
          const today = isoDate(deps.now, c.timeZone);
          companies = c.mock ? mockCompanyCalendar(list, deps.now, today) : await companyCalendar(deps, list, today);
        }
        return {
          zona_horaria: c.timeZone,
          eventos: upcoming([...EVENTS, ...(companies?.events ?? [])], deps.now, dias, c.timeZone).map((e) => ({
            fecha: e.date,
            hora: e.at ? localTime(e.at, c.timeZone)!.slice(11) : null,
            fuente: SOURCES[e.kind].name,
            evento: e.title,
            detalle: e.detail ?? null,
            ...(e.tentative ? { tentativo: true } : {}),
            ...(e.company ? releaseOut(e.company) : {}),
          })),
          cobertura: CALENDAR_UNTIL,
          fuentes: Object.fromEntries(Object.entries(sourcesFor(owner)).map(([k, s]) => [k, s.url])),
          ...(companies
            ? {
                resultados_empresas: companies.enabled
                  ? {
                      hasta: companies.until,
                      actualizado: localTime(companies.fetchedAt, c.timeZone),
                      dato_guardado: companies.stale,
                      nota: companies.note,
                      recientes: companies.recent.map(releaseOut),
                    }
                  : { activo: false, nota: 'Falta la clave de Finnhub (FINNHUB_API_KEY): sin ella no hay fechas de resultados.' },
              }
            : {}),
        };
      }),
  );
}

/** Una presentación de resultados, como la recibe Claude. */
function releaseOut(r: EarningsRelease) {
  const surprise = epsSurprise(r);
  return {
    simbolo: r.symbol,
    fecha: r.date,
    momento: r.hour ? MOMENT[r.hour] : null,
    trimestre_fiscal: quarterLabel(r),
    bpa_estimado: r.epsEstimate,
    ingresos_estimados: r.revenueEstimate,
    ...(r.epsActual !== null ? { bpa_real: r.epsActual } : {}),
    ...(r.revenueActual !== null ? { ingresos_reales: r.revenueActual } : {}),
    ...(surprise !== null ? { sorpresa_bpa_pct: Math.round(surprise * 1000) / 10 } : {}),
  };
}

/** Ejecuta una herramienta: el resultado va como JSON; los errores conocidos, como mensaje para Claude. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (e) {
    if (!(e instanceof ApiError)) console.error('Error no controlado en MCP', e);
    const message = e instanceof ApiError ? e.message : 'Error interno al leer los datos.';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

/** Para las herramientas que aceptan símbolos de las dos listas. */
const BOTH = 'tus listas, la de seguimiento y la diaria';

function notInList(symbols: string[], list: string[], where = 'la lista de seguimiento'): ApiError {
  return new ApiError(
    'bad_request',
    400,
    `${symbols.join(', ')} no está en ${where} (${list.join(', ')}). ` +
      'Para otros símbolos usa otra fuente, por ejemplo el conector de Twelve Data, o agrégalos a la lista en el panel Rueda.',
  );
}

const normalize = (s: string) => s.trim().toUpperCase();
const unique = (xs: string[]) => [...new Set(xs)];
const round = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
/** Fracción → puntos porcentuales con 2 decimales (0.1234 → 12.34). */
const pct = (x: number) => Math.round(x * 10_000) / 100;

/** Último cierre de cada mes. */
export function monthEnds(points: [string, number][]): [string, number][] {
  const byMonth = new Map<string, [string, number]>();
  for (const p of points) byMonth.set(p[0].slice(0, 7), p);
  return [...byMonth.values()];
}

/** ISO → "2026-10-16 10:02" en la zona horaria dada. */
export function localTime(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
