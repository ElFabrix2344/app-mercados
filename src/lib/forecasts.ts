// Pronósticos del grupo: preguntas sobre datos públicos (BCRP, INEI, Fed y BLS), así también juegan los amigos.
// Las preguntas salen solas del calendario económico (lib/calendar.ts) y del fin de cada mes (dólar). Cada una da
// hasta 10 puntos: acertar la decisión da 10; en los números, 10 menos un punto por cada `perPoint` de error.
// Funciones puras: la caché, los jugadores y la tarea programada están en services/forecasts.ts.

import { EVENTS, zonedToUtc, type EconEvent } from './calendar';
import { addDays, isoDate } from './num';

export type ForecastKind = 'bcrp' | 'fed' | 'inei' | 'bls' | 'dolar';
export const CHOICES = ['sube', 'mantiene', 'baja'] as const;
export type Choice = (typeof CHOICES)[number];
export type ForecastValue = Choice | number;

export interface KindSpec {
  type: 'choice' | 'number';
  unit: '%' | 'S/' | null;
  /** Paso del número (y decimales con que se guarda y se resuelve). */
  step: number | null;
  /** Error que cuesta 1 punto. */
  perPoint: number | null;
  /** Rango razonable (para rechazar errores de tipeo). */
  min: number | null;
  max: number | null;
}

export const SPECS: Record<ForecastKind, KindSpec> = {
  bcrp: { type: 'choice', unit: null, step: null, perPoint: null, min: null, max: null },
  fed: { type: 'choice', unit: null, step: null, perPoint: null, min: null, max: null },
  // Inflación a 12 meses: 1 punto por cada 0,05 pp de error.
  inei: { type: 'number', unit: '%', step: 0.01, perPoint: 0.05, min: -5, max: 30 },
  // El BLS la publica con un decimal: así se resuelve.
  bls: { type: 'number', unit: '%', step: 0.1, perPoint: 0.05, min: -5, max: 30 },
  // Dólar: 1 punto por cada medio céntimo.
  dolar: { type: 'number', unit: 'S/', step: 0.001, perPoint: 0.005, min: 2, max: 6 },
};

export interface Question extends KindSpec {
  id: string;
  kind: ForecastKind;
  title: string;
  /** Día del anuncio (decisiones e inflación) o último día hábil del mes (dólar). */
  date: string;
  /** Mes del dato (inflación y dólar), YYYY-MM. */
  ref: string | null;
  /** Instantes (ISO) en que abre y cierra. */
  opensAt: string;
  closesAt: string;
  /** La fecha del anuncio todavía es tentativa. */
  tentative?: boolean;
}

const LIMA = 'America/Lima';
/** Una pregunta se abre 45 días antes de su fecha. */
export const OPEN_DAYS = 45;
/** Medianoche de Lima del 23 oct 2026: lo que cerró antes no es parte del juego (nadie pudo pronosticarlo). */
export const GAME_START = '2026-10-23T05:00:00.000Z';
/** El dólar de fin de mes se cierra una semana antes. */
const DOLLAR_CLOSE_DAYS = 7;

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;

/** «2026-10» + n meses. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Medianoche de Lima al empezar ese día: hasta ahí se puede pronosticar. */
const limaMidnight = (date: string) => zonedToUtc(date, '00:00', LIMA);

/** Último día de lunes a viernes del mes. */
function lastWeekday(ym: string): string {
  let d = addDays(`${addMonths(ym, 1)}-01`, -1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, -1);
  return d;
}

const opens = (date: string) => new Date(Date.parse(limaMidnight(date)) - OPEN_DAYS * 86_400_000).toISOString();

/** La pregunta de un evento del calendario (decisiones del BCRP y la Fed, inflación del INEI y el BLS). */
export function eventQuestion(e: EconEvent): Question | null {
  if (e.kind !== 'bcrp' && e.kind !== 'fed' && e.kind !== 'inei' && e.kind !== 'bls') return null;
  // La inflación que se publica en un mes es la del mes anterior.
  const ref = e.kind === 'inei' || e.kind === 'bls' ? addMonths(e.date.slice(0, 7), -1) : null;
  const title = {
    bcrp: '¿El BCRP sube, mantiene o baja su tasa de referencia?',
    fed: '¿La Fed sube, mantiene o baja su tasa?',
    inei: `Inflación de Lima a 12 meses: dato de ${ref && monthName(ref)}`,
    bls: `Inflación de EE. UU. a 12 meses: dato de ${ref && monthName(ref)}`,
  }[e.kind];
  return {
    id: ref ? `${e.kind}-${ref}` : `${e.kind}-${e.date}`,
    kind: e.kind,
    ...SPECS[e.kind],
    title,
    date: e.date,
    ref,
    opensAt: opens(e.date),
    closesAt: limaMidnight(e.date),
    ...(e.tentative ? { tentative: true } : {}),
  };
}

/** Dólar interbancario (venta, BCRP) del último día hábil del mes; se cierra una semana antes. */
export function dollarQuestion(ym: string): Question {
  const date = lastWeekday(ym);
  return {
    id: `dolar-${ym}`,
    kind: 'dolar',
    ...SPECS.dolar,
    title: `Dólar interbancario (venta) al cierre de ${monthName(ym)}`,
    date,
    ref: ym,
    opensAt: opens(date),
    closesAt: limaMidnight(addDays(date, -DOLLAR_CLOSE_DAYS)),
  };
}

/**
 * Preguntas ya abiertas cuya fecha fue hace menos de 60 días (las abiertas, las cerradas y las recién resueltas), sin
 * las que cerraron antes de que empezara el juego.
 */
export function questionsAt(now: Date, events: EconEvent[] = EVENTS): Question[] {
  const from = addDays(isoDate(now, LIMA), -60);
  const live = (q: Question | null): q is Question =>
    !!q && q.date >= from && Date.parse(q.opensAt) <= now.getTime() && Date.parse(q.closesAt) > Date.parse(GAME_START);
  const out: Question[] = [];
  for (const e of events) {
    const q = eventQuestion(e);
    if (live(q)) out.push(q);
  }
  const thisMonth = isoDate(now, LIMA).slice(0, 7);
  for (let k = -2; k <= 2; k++) {
    const q = dollarQuestion(addMonths(thisMonth, k));
    if (live(q)) out.push(q);
  }
  return out.sort((a, b) => (a.closesAt < b.closesAt ? -1 : a.closesAt > b.closesAt ? 1 : a.id < b.id ? -1 : 1));
}

/** La pregunta con ese id, aunque ya no esté en la ventana (para validar pronósticos). */
export function questionById(id: string, events: EconEvent[] = EVENTS): Question | null {
  const m = /^(bcrp|fed|inei|bls|dolar)-(\d{4}-\d{2})(-\d{2})?$/.exec(id);
  if (!m) return null;
  if (m[1] === 'dolar') return m[3] ? null : dollarQuestion(m[2]!);
  for (const e of events) {
    const q = e.kind === m[1] ? eventQuestion(e) : null;
    if (q?.id === id) return q;
  }
  return null;
}

/** Tipo de pregunta según su id (sirve también para las viejas, que ya no salen del calendario). */
export const kindOf = (id: string): ForecastKind | null => {
  const k = id.split('-')[0];
  return k && k in SPECS ? (k as ForecastKind) : null;
};

const decimals = (step: number) => Math.max(0, Math.round(-Math.log10(step)));
const roundTo = (v: number, dec: number) => Math.round(v * 10 ** dec) / 10 ** dec;

/** Lo que mandó el jugador, validado y redondeado al paso de la pregunta (o el motivo si no sirve). */
export function parseForecast(q: KindSpec, raw: unknown): { value: ForecastValue } | { error: string } {
  if (q.type === 'choice') {
    return typeof raw === 'string' && (CHOICES as readonly string[]).includes(raw) ? { value: raw as Choice } : { error: 'Elige si sube, se mantiene o baja.' };
  }
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.replace(',', '.')) : NaN;
  if (!Number.isFinite(v)) return { error: 'Escribe un número.' };
  if ((q.min !== null && v < q.min) || (q.max !== null && v > q.max)) return { error: `El número tiene que estar entre ${q.min} y ${q.max}.` };
  return { value: roundTo(v, decimals(q.step ?? 0.01)) };
}

/** Puntos de un pronóstico (hasta 10, con un decimal). */
export function score(spec: KindSpec, value: ForecastValue, result: ForecastValue): number {
  if (spec.type === 'choice') return value === result ? 10 : 0;
  if (typeof value !== 'number' || typeof result !== 'number' || !spec.perPoint) return 0;
  return Math.max(0, Math.round((10 - Math.abs(value - result) / spec.perPoint) * 10) / 10);
}

/** Choice: cuántos eligió cada opción. Número: la mediana. */
export function consensus(spec: KindSpec, values: ForecastValue[]): Record<Choice, number> | number | null {
  if (!values.length) return null;
  if (spec.type === 'choice') {
    const out = { sube: 0, mantiene: 0, baja: 0 } as Record<Choice, number>;
    for (const v of values) if (typeof v === 'string') out[v]++;
    return out;
  }
  const nums = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
  return roundTo(median, decimals(spec.step ?? 0.01) + 1);
}

// ---------- resolución ----------

/** Datos públicos con los que se resuelven las preguntas (de las cachés de Perú y EE. UU.). */
export interface ResolutionData {
  /** Tasa de referencia del BCRP, diaria. */
  policyRates?: { date: string; value: number }[];
  /** Límite superior del rango objetivo de la Fed, diario. */
  fedTarget?: { date: string; upper: number }[];
  /** Inflación a 12 meses (fechas YYYY-MM-01). */
  inflationLima?: { date: string; value: number }[];
  cpiYoY?: { date: string; value: number }[];
  /** Dólar interbancario del BCRP, diario. */
  fx?: { date: string; sell: number }[];
}

/** Decisión de tasa: el último dato antes del anuncio frente al primero después (sirve haya cambiado el mismo día o al siguiente). */
function decision(series: [string, number][] | undefined, date: string): Choice | null {
  if (!series?.length) return null;
  const before = series.filter(([d]) => d < date).at(-1);
  const after = series.find(([d]) => d > date);
  if (!before || !after) return null;
  const diff = roundTo(after[1] - before[1], 4);
  return diff > 0 ? 'sube' : diff < 0 ? 'baja' : 'mantiene';
}

/** ¿Ya pasó lo que la pregunta pronostica? (Recién ahí vale la pena buscar el dato.) */
export function readyToResolve(q: Question, now: Date): boolean {
  const today = isoDate(now, LIMA);
  if (q.kind === 'bcrp' || q.kind === 'fed') return today > q.date;
  if (q.kind === 'dolar') return today >= addDays(`${addMonths(q.ref!, 1)}-01`, 2);
  return today >= q.date;
}

/** El resultado de la pregunta, o null si el dato todavía no salió. */
export function resolve(q: Question, data: ResolutionData, now: Date): ForecastValue | null {
  if (!readyToResolve(q, now)) return null;
  switch (q.kind) {
    case 'bcrp':
      return decision(data.policyRates?.map((p) => [p.date, p.value]), q.date);
    case 'fed':
      return decision(data.fedTarget?.map((p) => [p.date, p.upper]), q.date);
    case 'inei': {
      const p = data.inflationLima?.find((x) => x.date.slice(0, 7) === q.ref);
      return p ? roundTo(p.value, 2) : null;
    }
    case 'bls': {
      const p = data.cpiYoY?.find((x) => x.date.slice(0, 7) === q.ref);
      return p ? roundTo(p.value, 1) : null;
    }
    case 'dolar': {
      const last = data.fx?.filter((x) => x.date.slice(0, 7) === q.ref).at(-1);
      return last ? roundTo(last.sell, 3) : null;
    }
  }
}
