// P/S (precio ÷ ventas por acción, o sea, capitalización ÷ ventas), pedido del usuario el 4 nov: «facilita con alguna
// herramienta el método P/S». Eligió las tres opciones: una calculadora en la ficha, un comparador con pares y la
// herramienta `valorar_ps` del conector. Las ventas (último año fiscal) y las acciones en circulación (portada del
// informe más nuevo) salen de la SEC; el dólar, del BCRP, si la empresa reporta en soles. El precio lo pone quien
// mira. El panel hace estas mismas cuentas en el navegador (public/app.js, «P/S»): si cambias una, cambia la otra.

import type { FinancialsData } from './financials';

const round = (v: number, dec: number) => Math.round(v * 10 ** dec) / 10 ** dec;

export interface PsRow {
  symbol: string;
  name: string | null;
  price: number;
  /** Año fiscal y cierre de las ventas usadas (el último que tiene ventas). */
  year: number;
  end: string;
  /** Ventas del año en la moneda del informe y en dólares. */
  revenue: number;
  currency: string;
  revenueUsd: number;
  /** Acciones de la portada más nueva y cuántas vale cada ADR. */
  shares: number;
  sharesDate: string;
  adrRatio: number;
  foreign: boolean;
  marketCapUsd: number;
  ps: number;
}

export type PsResult = PsRow | { symbol: string; error: string };

export const isPsRow = (r: PsResult): r is PsRow => !('error' in r);

/** Cuántos dólares vale una unidad de la moneda del informe (null si no se puede pasar a dólares). */
function toUsd(currency: string | null, usdPen: number | null): number | null {
  if (currency === 'USD') return 1;
  if (currency === 'PEN' && usdPen) return 1 / usdPen;
  return null;
}

/** El P/S de hoy con el último año fiscal que tiene ventas. `usdPen`: soles por dólar, si reporta en soles. */
export function psRow(fin: FinancialsData, price: number, usdPen: number | null): PsResult {
  const symbol = fin.symbol;
  if (!fin.cik) return { symbol, error: 'No reporta a la SEC (ETF, fondo o empresa que no cotiza en EE. UU.).' };
  const last = [...fin.years].reverse().find((y) => y.revenue != null && y.revenue > 0);
  if (!last) return { symbol, error: 'La SEC no tiene sus ventas (los bancos y las aseguradoras no informan «ventas»: el P/S no les sirve).' };
  const sh = fin.shares.at(-1);
  if (!sh) return { symbol, error: 'La SEC no tiene sus acciones en circulación.' };
  const k = toUsd(fin.currency, usdPen);
  if (k === null) return { symbol, error: `Reporta en ${fin.currency ?? '¿?'} y no hay tipo de cambio para pasarlo a dólares.` };
  if (!(price > 0)) return { symbol, error: 'Falta el precio.' };
  const revenueUsd = last.revenue! * k;
  const marketCapUsd = (price * sh.value) / fin.adrRatio;
  return {
    symbol,
    name: fin.name,
    price,
    year: last.year,
    end: last.end,
    revenue: last.revenue!,
    currency: fin.currency!,
    revenueUsd: Math.round(revenueUsd),
    shares: sh.value,
    sharesDate: sh.date,
    adrRatio: fin.adrRatio,
    foreign: fin.foreign,
    marketCapUsd: Math.round(marketCapUsd),
    ps: round(marketCapUsd / revenueUsd, 2),
  };
}

/** Precio por acción (o por ADR) al que tendría ese P/S, con sus ventas y sus acciones. */
export function priceAtPs(r: PsRow, ps: number): number {
  return round((ps * r.revenueUsd * r.adrRatio) / r.shares, 2);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Último cierre en o antes de una fecha (los cierres, del más viejo al más nuevo). */
function closeOnOrBefore(closes: [string, number][], date: string): [string, number] | null {
  let found: [string, number] | null = null;
  for (const c of closes) {
    if (c[0] > date) break;
    found = c;
  }
  return found;
}

/**
 * P/S al cierre de cada año fiscal: el precio de ese día, las acciones de la portada siguiente más cercana (la que
 * cuenta las acciones de entonces) y las ventas de ese año. En soles se usa el dólar de hoy: es una aproximación.
 */
export function psHistory(fin: FinancialsData, closes: [string, number][], usdPen: number | null): { year: number; end: string; price: number; ps: number }[] {
  const k = toUsd(fin.currency, usdPen);
  if (k === null || !closes.length || !fin.shares.length) return [];
  const out: { year: number; end: string; price: number; ps: number }[] = [];
  for (const y of fin.years) {
    if (!y.revenue || y.revenue <= 0) continue;
    const c = closeOnOrBefore(closes, y.end);
    // Sin precio de ese día (antes de los 5 años guardados), o con un hueco de más de 10 días, no se cuenta.
    if (!c || Date.parse(y.end) - Date.parse(c[0]) > 10 * 86_400_000) continue;
    const sh = fin.shares.find((s) => s.date >= y.end) ?? fin.shares.at(-1)!;
    out.push({ year: y.year, end: y.end, price: c[1], ps: round((c[1] * sh.value) / fin.adrRatio / (y.revenue * k), 2) });
  }
  return out;
}
