// Lo que la empresa presentó a la SEC (9 nov, «la ficha al día»): informes anuales y trimestrales, hechos (8-K y 6-K),
// la junta y los avisos de atraso, con enlace al documento, más cuántos avisos de compras y ventas de directivos hubo.
// Es la lista pública de EDGAR (`data.sec.gov/submissions`), así que la ven todos, también los amigos. Una consulta por
// empresa (dos si todavía no se buscaron sus resultados); se guarda 12 horas (`secf:<símbolo>`), también cuando la SEC
// no tiene la empresa.

import { companySubmissions, findCik, type Filing, type SecCompany, type Submissions } from '../lib/sec';
import { cached, type Deps, type Fresh, type Stored } from './market';

export const FILINGS_TTL_MS = 12 * 3_600_000;

export interface FilingsData {
  symbol: string;
  /** null si la SEC no tiene la empresa (ETF, fondos, cripto). */
  cik: number | null;
  company: SecCompany | null;
  /** Del más nuevo al más viejo. */
  filings: Filing[];
  insiders: Submissions['insiders'] | null;
  /** Días en que presentó resultados (8-K con el tema 2.02), del más viejo al más nuevo: para el banco de pruebas. */
  earnings: string[];
}

/** La empresa del símbolo: la que ya encontraron los resultados (`sec:`, guardada una semana) o, si no, el buscador de EDGAR. */
async function companyOf(d: Deps, symbol: string): Promise<{ cik: number; name: string } | null> {
  const saved = await d.kv.get<Stored<{ cik?: number | null; name?: string | null }>>(`sec:${symbol}`, 'json');
  if (saved?.data && 'cik' in saved.data) return saved.data.cik ? { cik: saved.data.cik, name: saved.data.name ?? symbol } : null;
  return findCik(symbol, d.fetch);
}

export async function filings(d: Deps, symbol: string): Promise<Fresh<FilingsData>> {
  return cached<FilingsData>(d, `secf:${symbol}`, FILINGS_TTL_MS, async () => {
    const none: FilingsData = { symbol, cik: null, company: null, filings: [], insiders: null, earnings: [] };
    const found = await companyOf(d, symbol);
    if (!found) return none;
    const sub = await companySubmissions(found.cik, d.now, d.fetch);
    if (!sub) return { ...none, cik: found.cik };
    return { symbol, cik: found.cik, company: { ...sub.company, name: found.name }, filings: sub.filings, insiders: sub.insiders, earnings: sub.earnings };
  }, { valid: (x) => Array.isArray(x.earnings) }); // lo guardado antes del 11 nov no traía las fechas de resultados: se renueva una vez
}
