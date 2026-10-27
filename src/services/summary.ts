// Resumen del día: lo escribe Claude cada mañana (una tarea programada del dueño que usa el conector) con titulares y
// datos públicos, y lo ven todos. Este servidor no llama a ninguna IA: valida lo que llega, arma los enlaces con la
// caché de noticias y guarda los últimos días en un solo registro de KV (una escritura por resumen).

import { ApiError } from '../lib/http';
import { isoDate } from '../lib/num';
import type { NewsItem } from './news';

export const SUMMARY_KEY = 'resumen';
/** Días que se guardan: el panel muestra el último y los anteriores plegados. */
export const SUMMARY_DAYS = 7;

/** Largo permitido de cada parte, en caracteres (mínimo y máximo). */
export const SUMMARY_LIMITS = {
  title: [10, 120],
  text: [80, 1200],
  point: [10, 220],
  points: 4,
  sources: 8,
  sourceTitle: 200,
} as const;

export interface SummarySource {
  title: string;
  url: string;
  /** Medio o institución que publicó el enlace. */
  source: string;
}

export interface DailySummary {
  /** Día al que corresponde, en hora de Lima. */
  date: string;
  title: string;
  text: string;
  points: string[];
  sources: SummarySource[];
  publishedAt: string;
}

export interface SummaryStore {
  /** Del más nuevo al más viejo, uno por día. */
  items: DailySummary[];
}

/** Lo que manda la tarea programada (por la herramienta `publicar_resumen` del conector). */
export interface SummaryDraft {
  title: string;
  text: string;
  points?: string[];
  sources: { url: string; title?: string }[];
}

/**
 * Medios de las noticias de Rueda y fuentes oficiales: sus enlaces se aceptan aunque el titular ya no esté en la caché
 * de noticias (se renueva cada 30 minutos). Cualquier otro dominio se rechaza, para que nadie publique enlaces raros.
 */
const SOURCE_DOMAINS: [string, string][] = [
  ['gestion.pe', 'Gestión'],
  ['bloomberglinea.com', 'Bloomberg Línea'],
  ['wsj.com', 'WSJ'],
  ['marketwatch.com', 'MarketWatch'],
  ['cnbc.com', 'CNBC'],
  ['bloomberg.com', 'Bloomberg'],
  ['finance.yahoo.com', 'Yahoo Finance'],
  ['news.google.com', 'Google News'],
  ['bcrp.gob.pe', 'BCRP'],
  ['inei.gob.pe', 'INEI'],
  ['smv.gob.pe', 'SMV'],
  ['federalreserve.gov', 'Reserva Federal'],
  ['bls.gov', 'BLS'],
  ['stlouisfed.org', 'FRED'],
  ['sec.gov', 'SEC'],
];

/** Una línea limpia: sin caracteres de control ni marcas de Markdown, con los espacios juntos. */
export function cleanLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkLength(what: string, s: string, [min, max]: readonly [number, number]): string {
  if (s.length < min || s.length > max) {
    throw new ApiError('bad_request', 400, `${what} debe tener entre ${min} y ${max} caracteres (tiene ${s.length}).`);
  }
  return s;
}

/** El enlace de una fuente: el titular de la caché de noticias si está ahí; si no, un medio o una fuente oficial conocidos. */
function sourceOf(raw: { url: string; title?: string }, news: NewsItem[]): SummarySource {
  let url: URL;
  try {
    url = new URL(raw.url.trim());
  } catch {
    throw new ApiError('bad_request', 400, `«${raw.url.slice(0, 80)}» no es un enlace.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ApiError('bad_request', 400, 'Los enlaces deben empezar con https://.');
  const href = url.href;
  const item = news.find((n) => n.url === href || n.url === raw.url.trim());
  if (item) return { title: item.title, url: item.url, source: item.source };
  const host = url.hostname.toLowerCase();
  const known = SOURCE_DOMAINS.find(([d]) => host === d || host.endsWith(`.${d}`));
  if (!known) {
    throw new ApiError(
      'bad_request',
      400,
      `${host} no es uno de los medios de las noticias de Rueda ni una fuente oficial (BCRP, INEI, SMV, Fed, BLS, FRED o SEC). Usa los enlaces de la herramienta noticias.`,
    );
  }
  const title = cleanLine(raw.title ?? '').slice(0, SUMMARY_LIMITS.sourceTitle);
  return { title: title || `Nota de ${known[1]}`, url: href, source: known[1] };
}

/** Valida el borrador y arma el resumen de hoy (hora de `timeZone`). Lanza ApiError con un mensaje que Claude puede corregir. */
export function buildSummary(draft: SummaryDraft, news: NewsItem[], now: Date, timeZone: string): DailySummary {
  const title = checkLength('El título', cleanLine(draft.title), SUMMARY_LIMITS.title);
  const text = checkLength('El texto', cleanLine(draft.text), SUMMARY_LIMITS.text);
  const rawPoints = draft.points ?? [];
  if (rawPoints.length > SUMMARY_LIMITS.points) throw new ApiError('bad_request', 400, `Como mucho ${SUMMARY_LIMITS.points} puntos.`);
  // Los puntos llegan a veces con su viñeta («- », «• »): la pone el panel.
  const points = rawPoints.map((p, i) => checkLength(`El punto ${i + 1}`, cleanLine(p).replace(/^[-•*·]\s*/, ''), SUMMARY_LIMITS.point));
  if (!draft.sources.length) throw new ApiError('bad_request', 400, 'Falta al menos una fuente: los enlaces de los titulares que usaste.');
  if (draft.sources.length > SUMMARY_LIMITS.sources) throw new ApiError('bad_request', 400, `Como mucho ${SUMMARY_LIMITS.sources} fuentes.`);
  const sources: SummarySource[] = [];
  for (const s of draft.sources) {
    const src = sourceOf(s, news);
    if (!sources.some((x) => x.url === src.url)) sources.push(src);
  }
  return { date: isoDate(now, timeZone), title, text, points, sources, publishedAt: now.toISOString() };
}

export async function readSummaries(kv: KVNamespace): Promise<SummaryStore> {
  const stored = (await kv.get(SUMMARY_KEY, 'json')) as SummaryStore | null;
  return { items: Array.isArray(stored?.items) ? stored.items : [] };
}

/** Guarda el resumen: reemplaza el del mismo día y deja los últimos `SUMMARY_DAYS` días. */
export async function publishSummary(kv: KVNamespace, s: DailySummary): Promise<SummaryStore> {
  const { items } = await readSummaries(kv);
  const next = [s, ...items.filter((x) => x.date !== s.date)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, SUMMARY_DAYS);
  const store = { items: next };
  await kv.put(SUMMARY_KEY, JSON.stringify(store));
  return store;
}
