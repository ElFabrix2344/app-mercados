// Hechos de importancia de la SMV (lib/smv.ts): públicos, los ven todos. La API tarda (unos 10 s por dos meses), así
// que los trae la tarea programada cada 3 horas y el panel solo lee lo guardado: un registro en KV (`smv-hechos`,
// hasta 8 escrituras al día).
//
// Se guardan los últimos 14 días de todas las empresas, sin los avisos de información financiera que no dicen nada
// (son la mayoría: 150 de 265 en la semana al 4 nov), y los últimos 60 días completos de las empresas peruanas que
// cotizan en EE. UU., para su ficha.

import { addDays, isoDate } from '../lib/num';
import { getHechos, type Hecho } from '../lib/smv';
import type { Stored } from './market';

export const SMV_KEY = 'smv-hechos';
const LIMA = 'America/Lima';
/** Algo menos de 3 horas: la tarea programada corre cada 10 minutos y solo intenta en los primeros 10 de cada hora. */
export const SMV_REFRESH_MS = 165 * 60_000;
const FEED_DAYS = 14;
const ISSUER_DAYS = 60;
/** La primera vez se traen 30 días; después, desde dos días antes de lo último traído. */
const FIRST_DAYS = 30;
/** Lo que se manda a la lista general y a cada ficha. */
const FEED_MAX = 60;
const ISSUER_MAX = 12;

/** Empresas peruanas (o con filial en el Perú) que cotizan en EE. UU.: su nombre corto y cómo aparecen en la SMV. */
export const SMV_ISSUERS: Record<string, { name: string; match: string[] }> = {
  BAP: { name: 'Credicorp', match: ['CREDICORP LTD'] },
  BVN: { name: 'Buenaventura', match: ['COMPAÑIA DE MINAS BUENAVENTURA'] },
  SCCO: { name: 'Southern Copper', match: ['SOUTHERN COPPER CORPORATION', 'SOUTHERN PERU COPPER CORPORATION'] },
  CPAC: { name: 'Cementos Pacasmayo', match: ['CEMENTOS PACASMAYO'] },
  IFS: { name: 'Intercorp Financial Services', match: ['INTERCORP FINANCIAL SERVICES'] },
};

/** Mayúsculas, sin tildes (la SMV escribe «COMPAÑIA» sin tilde y a veces con) y sin espacios de más. */
const norm = (s: string) =>
  s
    .toLocaleUpperCase('es-PE')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** El símbolo en EE. UU. de una empresa de la SMV, si es una de SMV_ISSUERS. */
export function issuerSymbol(empresa: string): string | null {
  const e = norm(empresa);
  for (const [sym, x] of Object.entries(SMV_ISSUERS)) if (x.match.some((m) => e.startsWith(norm(m)))) return sym;
  return null;
}

// Con al menos un espacio o una coma antes: si no, «ALICORP» quedaría en «ALI».
const SUFFIX = /[\s,]+(S\.?\s?A\.?\s?A\.?|S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|S\.?\s?R\.?\s?L\.?|INC\.?|LTD\.?|CORP\.?|SOCIEDAD ANONIMA ABIERTA|SOCIEDAD ANONIMA)$/i;
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'en', 'el', 'para', 'por', 'a']);
const ACRONYMS = new Set(['BBVA', 'BCP', 'BIF', 'GR', 'MAPFRE', 'UNACEM', 'SEDAPAL', 'COFIDE', 'PETROPERU', 'ENEL', 'ENGIE', 'AFP', 'BTG', 'SAB', 'SAF', 'IFS', 'SURA', 'BNP', 'GNB', 'ICBC']);

/** «COMPAÑIA DE MINAS BUENAVENTURA S.A.A.» → «Buenaventura»; «SERVICIO DE AGUA … - SEDAPAL» → «SEDAPAL». */
export function prettyName(empresa: string): string {
  const sym = issuerSymbol(empresa);
  if (sym) return SMV_ISSUERS[sym]!.name;
  // Después de « - » suele venir el nombre corto (SEDAPAL, COFIDE, PETROPERU S.A.).
  const parts = empresa.split(' - ');
  let s = (parts.length > 1 ? parts.at(-1)! : parts[0]!).trim();
  for (let i = 0; i < 3 && SUFFIX.test(s); i++) s = s.replace(SUFFIX, '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      // Siglas («BBVA») y abreviaturas con punto en medio del nombre («S.A.»), en mayúsculas.
      if (ACRONYMS.has(norm(w)) || w.includes('.')) return w.toLocaleUpperCase('es-PE');
      const low = w.toLocaleLowerCase('es-PE');
      return i > 0 && SMALL.has(low) ? low : low[0]!.toLocaleUpperCase('es-PE') + low.slice(1);
    })
    .join(' ');
}

/** Aviso de información financiera sin texto: solo dice que la empresa presentó sus estados. */
const isBareFiling = (h: Hecho) => !h.texto && /^informaci[oó]n financiera/i.test(h.tipo);

export interface SmvData {
  /** Hechos guardados, del más nuevo al más viejo. */
  items: Hecho[];
  /** Último día consultado (fecha de Lima). */
  through: string;
}

/** Junta lo nuevo con lo guardado: sin repetidos y solo lo que se usa (14 días de todos, 60 de las de EE. UU.). */
export function mergeHechos(prev: Hecho[], fresh: Hecho[], today: string): Hecho[] {
  const feedFrom = addDays(today, -FEED_DAYS);
  const issuerFrom = addDays(today, -ISSUER_DAYS);
  const seen = new Set<string>();
  const out: Hecho[] = [];
  const all = [...fresh, ...prev].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const h of all) {
    // Un mismo aviso con varios tipos llega repetido: queda el primero.
    const k = `${h.id}|${h.empresa}|${h.texto}|${h.at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const day = h.at.slice(0, 10);
    if (issuerSymbol(h.empresa) ? day >= issuerFrom : day >= feedFrom && !isBareFiling(h)) out.push(h);
  }
  return out;
}

/**
 * Tarea programada: cada 3 horas trae lo nuevo y lo junta con lo guardado. Intenta solo en los primeros 10 minutos de
 * cada hora, así una SMV caída no se consulta cada 10 minutos. Devuelve si guardó algo.
 */
export async function refreshSmv(d: { kv: KVNamespace; now: Date; fetch?: typeof fetch }): Promise<boolean> {
  const prev = await d.kv.get<Stored<SmvData>>(SMV_KEY, 'json');
  const due = !prev || d.now.getTime() - Date.parse(prev.fetchedAt) >= SMV_REFRESH_MS;
  if (!due || d.now.getUTCMinutes() >= 10) return false;
  const today = isoDate(d.now, LIMA);
  const from = prev ? addDays(prev.data.through, -2) : addDays(today, -FIRST_DAYS);
  const fresh = await getHechos(from, today, d.fetch);
  const data: SmvData = { items: mergeHechos(prev?.data.items ?? [], fresh, today), through: today };
  await d.kv.put(SMV_KEY, JSON.stringify({ fetchedAt: d.now.toISOString(), data } satisfies Stored<SmvData>));
  return true;
}

export type SmvItem = Hecho & { nombre: string; symbol: string | null };

export interface SmvView {
  /** Cuándo se trajeron (null: todavía no los trae la tarea programada). */
  fetchedAt: string | null;
  items: SmvItem[];
  /** Con `?symbol=`: la empresa de ese símbolo (null si no es una de las que cotizan en EE. UU.). */
  issuer?: { symbol: string; name: string } | null;
}

const withName = (h: Hecho): SmvItem => ({ ...h, nombre: prettyName(h.empresa), symbol: issuerSymbol(h.empresa) });

/** Lo guardado: la lista general (14 días, sin avisos vacíos) o, con un símbolo, los 60 días de esa empresa. */
export function shapeSmv(stored: Stored<SmvData> | null, now: Date, symbol?: string): SmvView {
  const items = stored?.data.items ?? [];
  const fetchedAt = stored?.fetchedAt ?? null;
  if (symbol !== undefined) {
    const issuer = SMV_ISSUERS[symbol];
    return {
      fetchedAt,
      issuer: issuer ? { symbol, name: issuer.name } : null,
      items: issuer ? items.filter((h) => issuerSymbol(h.empresa) === symbol).slice(0, ISSUER_MAX).map(withName) : [],
    };
  }
  const from = addDays(isoDate(now, LIMA), -FEED_DAYS);
  return { fetchedAt, items: items.filter((h) => h.at.slice(0, 10) >= from && !isBareFiling(h)).slice(0, FEED_MAX).map(withName) };
}

export async function smvView(kv: KVNamespace, now: Date, symbol?: string): Promise<SmvView> {
  return shapeSmv(await kv.get<Stored<SmvData>>(SMV_KEY, 'json'), now, symbol);
}
