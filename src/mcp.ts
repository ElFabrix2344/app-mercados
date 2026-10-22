// Conector de Claude: servidor MCP remoto en /mcp (Streamable HTTP, sin estado), dentro del Worker mercados-mcp.
// Usa las mismas fuentes, la misma caché en KV y el mismo freno de créditos que el panel.
// No autentica por su cuenta: mcp-worker.ts valida el token OAuth y el rol antes de llegar aquí.

import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Role } from './auth/access';
import { CALENDAR_UNTIL, EVENTS, SOURCES, upcoming } from './lib/calendar';
import { ApiError } from './lib/http';
import { mockCompare, mockHistory, mockPeru, mockPeruMarkets, mockQuotes, mockUsa } from './mock';
import {
  COMPARE_MAX,
  DAILY_CREDIT_CAP,
  DEFAULT_RANGE,
  MAX_SYMBOLS,
  RANGES,
  compare,
  compareSymbols,
  creditsUsed,
  getWatchlist,
  history,
  peru,
  peruMarkets,
  quotes,
  usa,
  type CompareResult,
  type Deps,
  type Fresh,
  type HistoryResult,
  type MarketSeries,
  type PeruMarkets,
} from './services/market';

export interface McpContext {
  deps: Deps;
  /** Datos ficticios (solo desarrollo local). */
  mock: boolean;
  /** Zona horaria en la que se muestran las horas. */
  timeZone: string;
  /** Los amigos solo reciben las herramientas de datos públicos (BCRP y FRED). */
  role: Role;
}

const INSTRUCTIONS =
  'Datos del panel personal «Mercados» del usuario: precios, historial con indicadores técnicos y comparación de los ' +
  'símbolos de su lista de seguimiento (Twelve Data), ' +
  'Perú (BCRP), EE. UU. (FRED) y el calendario económico. Los datos pueden venir de la caché del panel: al responder, di ' +
  'la hora de «actualizado» y avisa si «dato_guardado» es true. Para símbolos fuera de la lista usa otra fuente (por ' +
  'ejemplo, el conector de Twelve Data).';

const INSTRUCTIONS_FRIEND =
  'Datos públicos del panel «Mercados»: Perú (BCRP), EE. UU. (FRED) y el calendario económico. Los datos pueden venir de ' +
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
  const server = new McpServer({ name: 'mercados', version: '0.4.0' }, { instructions: owner ? INSTRUCTIONS : INSTRUCTIONS_FRIEND });
  const when: When = (iso) => localTime(iso, c.timeZone);

  // Precios e historial (Twelve Data): solo para el dueño, por la licencia del plan gratis.
  if (owner) registerMarketTools(server, c, when);
  registerPublicTools(server, c, when);
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
        'Precios actuales de los símbolos de la lista de seguimiento del panel Mercados (acciones y ETF de EE. UU., divisas como ' +
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
        'Bollinger de 20 días y 2 desviaciones (posicion_pct: 0 = banda inferior, 100 = banda superior). ' +
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
        const list = await getWatchlist(deps.kv);
        const symbol = normalize(simbolo);
        if (!list.includes(symbol)) throw notInList([symbol], list);

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
        const list = await getWatchlist(deps.kv);
        const symbols = compareSymbols(simbolos);
        const outside = symbols.filter((s) => !list.includes(s));
        if (outside.length) throw notInList(outside, list);

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
    bollinger:
      sup !== null && inf !== null
        ? { superior: sup, inferior: inf, posicion_pct: sup > inf ? Math.round(((cierre - inf) / (sup - inf)) * 1000) / 10 : null }
        : null,
  };
}

/** Una serie de mercado del BCRP para Claude: último dato, variaciones y cierre de cada mes. */
function marketOut(s: MarketSeries) {
  const { last, m1, y1 } = s.summary;
  return {
    fecha: last?.date ?? null,
    valor: last?.value ?? null,
    variacion_1_mes_pct: m1 && pct(m1.pct),
    variacion_12_meses_pct: y1 && pct(y1.pct),
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
        'Metropolitana a 12 meses (%, últimos 13 meses) y, en «mercados», cobre y oro en Londres, reservas internacionales ' +
        'netas e índice general de la Bolsa de Valores de Lima: último dato, variación a 1 y 12 meses (en puntos ' +
        'porcentuales: 12.5 = +12,5 %) y el cierre de cada mes del último año.',
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
          mercados: mk && {
            cobre_usd_por_libra: marketOut(mk.data.copper),
            oro_usd_por_onza_troy: marketOut(mk.data.gold),
            reservas_internacionales_netas_millones_usd: marketOut(mk.data.reserves),
            indice_general_bvl: marketOut(mk.data.bvl),
            actualizado: when(mk.fetchedAt),
            dato_guardado: mk.stale,
          },
          ...(mkError ? { mercados_error: mkError } : {}),
          series: {
            compra: 'PD04637PD',
            venta: 'PD04638PD',
            tasa_de_referencia: 'PD12301MD',
            inflacion: 'PN01273PM',
            cobre: 'PD04701XD (centavos de US$ por libra, aquí convertido a US$)',
            oro: 'PD04704XD',
            reservas: 'PD04650MD',
            bvl: 'PD38026MD',
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
        'Datos de FRED (Reserva Federal de St. Louis, guardados hasta 6 h): rendimiento del bono del Tesoro a 10 años (%, ' +
        'últimos ~60 días hábiles), tasa efectiva de fondos federales (%) e inflación anual del IPC (%, últimos 13 meses).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const r = c.mock ? mockUsa(deps.now) : await usa(deps);
        const t10 = r.data.treasury10y;
        return {
          fuente: 'FRED (Reserva Federal de St. Louis)',
          bono_10_anios_pct: t10.length ? { fecha: t10.at(-1)!.date, valor: t10.at(-1)!.value } : null,
          bono_10_anios_serie: t10.map((p) => [p.date, p.value]),
          tasa_fed_pct: r.data.fedFunds && { fecha: r.data.fedFunds.date, valor: r.data.fedFunds.value },
          inflacion_anual_pct: r.data.cpiYoY.map((p) => [p.date.slice(0, 7), round(p.value)]),
          series: { bono_10_anios: 'DGS10', tasa_fed: 'DFF', inflacion: 'CPIAUCSL (variación % a 12 meses)' },
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );
}

function registerCalendarTool(server: McpServer, c: McpContext): void {
  server.registerTool(
    'calendario',
    {
      title: 'Calendario económico (BCRP, Fed e inflación de Perú y EE. UU.)',
      description:
        'Próximas fechas oficiales: decisiones de tasa del BCRP (Programa Monetario) y de la Reserva Federal (FOMC), y ' +
        'publicación de la inflación de Lima Metropolitana (INEI) y de EE. UU. (BLS). La hora va en la zona horaria indicada ' +
        'cuando la fuente la publica. «cobertura» dice hasta qué fecha está cargado cada calendario: más allá no hay datos.',
      inputSchema: z.object({
        dias: z.number().int().min(1).max(366).default(60).describe('Cuántos días hacia adelante (por defecto 60).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ dias }) =>
      run(async () => ({
        zona_horaria: c.timeZone,
        eventos: upcoming(EVENTS, c.deps.now, dias, c.timeZone).map((e) => ({
          fecha: e.date,
          hora: e.at ? localTime(e.at, c.timeZone)!.slice(11) : null,
          fuente: SOURCES[e.kind].name,
          evento: e.title,
          detalle: e.detail ?? null,
          ...(e.tentative ? { tentativo: true } : {}),
        })),
        cobertura: CALENDAR_UNTIL,
        fuentes: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.url])),
      })),
  );
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

function notInList(symbols: string[], list: string[]): ApiError {
  return new ApiError(
    'bad_request',
    400,
    `${symbols.join(', ')} no está en la lista de seguimiento (${list.join(', ')}). ` +
      'Para otros símbolos usa otra fuente, por ejemplo el conector de Twelve Data, o agrégalos a la lista en el panel Mercados.',
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
