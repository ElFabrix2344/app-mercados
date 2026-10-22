// Lector de RSS liviano para Workers (no hay DOMParser). Lee el cuerpo como stream y corta apenas tiene los
// primeros `max` ítems: algunos medios (Gestión, Bloomberg Línea) mandan la nota completa en cada ítem y el
// archivo pesa ~1 MB, que no queremos ni descargar entero ni guardar. Solo se toman título, enlace, fecha,
// medio y un resumen corto: nunca el texto de la nota.

import { ApiError } from './http';

export interface RssItem {
  title: string;
  url: string;
  /** Fecha de publicación (ISO), si el feed la trae y se entiende. */
  publishedAt: string | null;
  /** Resumen corto del propio feed (sin HTML, máximo ~240 caracteres). */
  summary: string | null;
  /** Medio original cuando el feed agrega varios (Google News trae <source>). */
  source: string | null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Texto limpio: sin CDATA, sin etiquetas HTML, entidades decodificadas y espacios colapsados. */
export function cleanText(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<![CDATA[')) s = s.slice(9, s.endsWith(']]>') ? -3 : undefined);
  s = decodeEntities(s.replace(/<[^>]*>/g, ' '));
  // Algunos medios escapan el HTML dos veces: lo que queda de etiquetas se quita otra vez.
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Contenido de la primera etiqueta `name` del ítem (sin confundir <title> con <media:title>). */
function tag(xml: string, name: string): string | null {
  let from = 0;
  for (;;) {
    const open = xml.indexOf(`<${name}`, from);
    if (open === -1) return null;
    const next = xml[open + name.length + 1];
    if (next !== '>' && next !== ' ' && next !== '\n' && next !== '\t' && next !== '\r' && next !== '/') {
      from = open + 1;
      continue;
    }
    const gt = xml.indexOf('>', open);
    if (gt === -1) return null;
    if (xml[gt - 1] === '/') return '';
    const close = xml.indexOf(`</${name}>`, gt);
    return close === -1 ? null : xml.slice(gt + 1, close);
  }
}

export function parseItem(xml: string): RssItem | null {
  const title = cleanText(tag(xml, 'title') ?? '');
  const url = cleanText(tag(xml, 'link') ?? '');
  if (!title || !/^https?:\/\//.test(url)) return null;
  const date = tag(xml, 'pubDate');
  const t = date ? Date.parse(cleanText(date)) : NaN;
  let summary = cleanText(tag(xml, 'description') ?? '') || null;
  if (summary && summary.length > 240) summary = `${summary.slice(0, 237).replace(/\s+\S*$/, '')}…`;
  const source = cleanText(tag(xml, 'source') ?? '') || null;
  return { title, url, publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString(), summary, source };
}

/** Los primeros `max` ítems de un RSS, leyendo el stream solo hasta donde hace falta. */
export async function fetchRss(url: string, max: number, f: typeof fetch = fetch): Promise<RssItem[]> {
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Mozilla/5.0 (compatible; rueda-panel-personal)' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `RSS no respondió: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new ApiError('upstream_error', 502, `RSS: HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const items: RssItem[] = [];
  let buf = '';
  try {
    while (items.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let end = buf.indexOf('</item>');
      while (end !== -1 && items.length < max) {
        const start = buf.lastIndexOf('<item', end);
        if (start !== -1) {
          const item = parseItem(buf.slice(start, end));
          if (item) items.push(item);
        }
        buf = buf.slice(end + 7);
        end = buf.indexOf('</item>');
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return items;
}
