// Conector de Claude: servidor MCP remoto en /mcp (Streamable HTTP, sin estado).
// Usa las mismas fuentes, la misma caché en KV y el mismo freno de créditos que el panel.
// No autentica por su cuenta: Cloudflare Access (Managed OAuth) le da el token a Claude
// e index.ts valida el JWT de Access y el correo antes de llegar aquí.

import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Role } from './auth/access';
import { ApiError } from './lib/http';
import { mockHistory, mockPeru, mockQuotes, mockUsa } from './mock';
import { DAILY_CREDIT_CAP, DEFAULT_RANGE, MAX_SYMBOLS, RANGES, creditsUsed, getWatchlist, history, peru, quotes, usa, type Deps } from './services/market';

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
  'Datos del panel personal «Mercados» del usuario: precios e historial de su lista de seguimiento (Twelve Data), ' +
  'Perú (BCRP) y EE. UU. (FRED). Los datos pueden venir de la caché del panel: al responder, di la hora de «actualizado» ' +
  'y avisa si «dato_guardado» es true. Para símbolos fuera de la lista usa otra fuente (por ejemplo, el conector de Twelve Data).';

const INSTRUCTIONS_FRIEND =
  'Datos públicos del panel «Mercados»: Perú (BCRP) y EE. UU. (FRED). Los datos pueden venir de la caché del panel: al ' +
  'responder, di la hora de «actualizado» y avisa si «dato_guardado» es true. Los precios de mercado no están disponibles ' +
  'en este conector para tu cuenta.';

export function handleMcp(req: Request, c: McpContext): Promise<Response> {
  const handler = createMcpHandler(() => buildServer(c), {
    responseMode: 'json',
    onerror: (e) => console.warn('MCP:', e.message),
  });
  return handler.fetch(req);
}

export function buildServer(c: McpContext): McpServer {
  const owner = c.role === 'owner';
  const server = new McpServer({ name: 'mercados', version: '0.3.0' }, { instructions: owner ? INSTRUCTIONS : INSTRUCTIONS_FRIEND });
  const when: When = (iso) => localTime(iso, c.timeZone);

  // Precios e historial (Twelve Data): solo para el dueño, por la licencia del plan gratis.
  if (owner) registerMarketTools(server, c, when);
  registerPublicTools(server, c, when);
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
        'máximo y mínimo. Los porcentajes vienen en puntos porcentuales (12.5 = +12,5 %).',
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
          ...(cierres === 'ninguno' ? {} : { cierres: cierres === 'diario' ? pts : monthEnds(pts) }),
          actualizado: when(r.fetchedAt),
          dato_guardado: r.stale,
          nota: r.note,
        };
      }),
  );
}

function registerPublicTools(server: McpServer, c: McpContext, when: When): void {
  const { deps } = c;

  server.registerTool(
    'peru_bcrp',
    {
      title: 'Perú: dólar, tasa de referencia e inflación (BCRP)',
      description:
        'Datos del Banco Central de Reserva del Perú (BCRPData, guardados hasta 6 h): tipo de cambio interbancario del dólar ' +
        '(compra y venta en soles, últimos ~30 días hábiles), tasa de referencia de política monetaria (%) e inflación de Lima ' +
        'Metropolitana a 12 meses (%, últimos 13 meses).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const r = c.mock ? mockPeru(deps.now) : await peru(deps);
        const last = r.data.fx.at(-1);
        return {
          fuente: 'BCRP (BCRPData)',
          dolar_interbancario: last ? { fecha: last.date, compra: last.buy, venta: last.sell } : null,
          dolar_ultimos_dias: { columnas: ['fecha', 'compra', 'venta'], filas: r.data.fx.map((p) => [p.date, p.buy, p.sell]) },
          tasa_de_referencia_pct: r.data.policyRate && { fecha: r.data.policyRate.date, valor: r.data.policyRate.value },
          inflacion_lima_12_meses_pct: r.data.inflation.map((p) => [p.date.slice(0, 7), round(p.value)]),
          series: { compra: 'PD04637PD', venta: 'PD04638PD', tasa_de_referencia: 'PD12301MD', inflacion: 'PN01273PM' },
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
