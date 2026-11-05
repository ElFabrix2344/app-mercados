// Hechos de importancia de la SMV (Superintendencia del Mercado de Valores del Perú): lo que las empresas que emiten
// valores en el Perú tienen que comunicar al mercado (dividendos, juntas, cambios en el directorio, emisiones,
// resultados…). API de datos abiertos, pública y sin clave. Es lenta (unos 10 s por dos meses), así que la consulta la
// tarea programada y el panel solo lee lo guardado (services/smv.ts).
//
// Respuesta: { ResponseCode, Message, Resultado: [{ Numero_Expediente, Empresa, Tipo_Hecho, Fecha_Presentacion
// («04/11/2026 17:02», hora de Lima), Descripcion_Hecho, Sector, RUC… }] }. Las empresas extranjeras (Credicorp Ltd.,
// Southern Copper) vienen con RUC «0»: se reconocen por el nombre.

import { ApiError } from './http';

const BASE = 'https://mvnet.smv.gob.pe/SMV.OData.Api/api/registro/HechosSMVEmisor';
/** Lo más largo que se guarda de cada descripción. */
const MAX_TEXT = 280;

export interface Hecho {
  /** Número de expediente: un mismo aviso puede venir repetido con varios tipos. */
  id: string;
  empresa: string;
  /** Tipo de hecho, sin su número y en minúsculas («Distribución o aplicación de utilidades»). */
  tipo: string;
  /** Fecha y hora de presentación, en Lima («2026-11-04T17:02»). */
  at: string;
  /** Lo que dice el aviso (vacío en muchos de información financiera). */
  texto: string;
  sector: string;
}

/** «04/11/2026 17:02» → «2026-11-04T17:02». */
export function isoOf(v: unknown): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(String(v ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}` : null;
}

/** «10. INFORMACIÓN FINANCIERA Y MEMORIA ANUAL.» → «Información financiera y memoria anual». */
export function tipoOf(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-PE');
  return s ? s[0]!.toLocaleUpperCase('es-PE') + s.slice(1) : '';
}

/** «2026-11-04» → «04/11/2026», como lo pide la API. */
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function parseHechos(body: unknown): Hecho[] {
  const rows = (body as { Resultado?: unknown } | null)?.Resultado;
  if (!Array.isArray(rows)) throw new ApiError('bad_response', 502, 'SMV: respuesta sin hechos de importancia.', 'smv');
  const out: Hecho[] = [];
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const at = isoOf(r.Fecha_Presentacion);
    const empresa = String(r.Empresa ?? '').trim();
    if (!at || !empresa) continue;
    const texto = String(r.Descripcion_Hecho ?? '').replace(/\s+/g, ' ').trim();
    out.push({
      id: String(r.Numero_Expediente ?? ''),
      empresa,
      tipo: tipoOf(r.Tipo_Hecho),
      at,
      texto: texto.length > MAX_TEXT ? `${texto.slice(0, MAX_TEXT - 1).trimEnd()}…` : texto,
      sector: String(r.Sector ?? '').trim(),
    });
  }
  return out;
}

/** Hechos presentados entre dos fechas (YYYY-MM-DD, ambas incluidas). */
export async function getHechos(from: string, to: string, f: typeof fetch = fetch): Promise<Hecho[]> {
  const url = `${BASE}?sFechaInicio=${dmy(from)}&sFechaFin=${dmy(to)}`;
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError('upstream_error', 502, `SMV no respondió: ${(e as Error).message}`, 'smv');
  }
  if (!res.ok) throw new ApiError('upstream_error', 502, `SMV: HTTP ${res.status}`, 'smv');
  return parseHechos(await res.json().catch(() => null));
}
