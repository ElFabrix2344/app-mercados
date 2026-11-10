// Valoración de una acción con los informes de la SEC y un precio (10 nov, fase 2 del rumbo nuevo: «¿cara o barata?»).
// Funciones puras, sin DOM, para probarlas con vitest (como hapi-core.js). Las usa el panel (app.js) y, para el P/S
// histórico del conector, también el servidor (src/services/valuation.ts): así las cuentas son las mismas en los dos.
//
// Los montos de la SEC llegan en la moneda del informe; `k` dice cuántos dólares vale una unidad (1 si reporta en US$).
// Nada de esto recomienda comprar o vender: son múltiplos y cuentas.

const DAY_MS = 86_400_000;
/** Proporciones usuales de un split (2 por 1, 3 por 1… 100 por 1). */
const SPLIT_RATIOS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100];
/** Un salto así entre dos portadas seguidas ya no es una emisión o una recompra: es un split. */
const SPLIT_MIN = 1.9;
/** Cuánto puede alejarse el salto de la proporción exacta (las recompras y emisiones del trimestre). */
const SPLIT_TOLERANCE = 0.06;

/**
 * Por cuánto se multiplicaron las acciones si el salto entre dos portadas seguidas parece un split (2, 3, 10…) o un
 * split inverso (1/2, 1/10…); 1 si no lo parece.
 */
export function splitFactor(before, after) {
  if (!(before > 0) || !(after > 0)) return 1;
  const up = after >= before;
  const r = up ? after / before : before / after;
  if (r < SPLIT_MIN) return 1;
  const n = SPLIT_RATIOS.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), SPLIT_RATIOS[0]);
  if (Math.abs(r / n - 1) > SPLIT_TOLERANCE) return 1;
  return up ? n : 1 / n;
}

/**
 * Las acciones de cada portada (de la más vieja a la más nueva) llevadas a acciones de hoy (`adj`). Los precios
 * históricos vienen ajustados por splits y las portadas viejas no: sin esto, la capitalización de antes de un split
 * de 10 por 1 saldría diez veces más chica.
 */
export function splitAdjusted(shares) {
  const out = new Array(shares.length);
  let factor = 1;
  for (let i = shares.length - 1; i >= 0; i--) {
    if (i < shares.length - 1) factor *= splitFactor(shares[i].value, shares[i + 1].value);
    out[i] = { ...shares[i], adj: shares[i].value * factor };
  }
  return out;
}

/** El último cierre en esa fecha o antes (`points`: [fecha, cierre], del más viejo al más nuevo); null si falta o si queda a más de 10 días. */
export function closeAt(points, date) {
  let found = null;
  for (const p of points) {
    if (p[0] > date) break;
    found = p;
  }
  return found && Date.parse(date) - Date.parse(found[0]) <= 10 * DAY_MS ? found : null;
}

/**
 * Lo más nuevo que hay de una empresa: los últimos 12 meses (`ttm`), si presenta trimestres, con el balance del mismo
 * cierre; si no, su último año fiscal. `prev` es el periodo anterior, para el crecimiento. null si no hay resultados.
 * Sin los fundamentales (todavía no llegaron) van solo los resultados; si llegaron pero su cierre no coincide con el
 * de los 12 meses, se usa el año fiscal para todo, y así no se mezclan fechas.
 */
export function latestOf(fin, fund) {
  const t = fin?.ttm ?? null;
  const lt = fund?.latest ?? null;
  if (t && (!fund || (lt && lt.end === t.end))) return { ttm: true, end: t.end, inc: t, prev: fin.ttmPrev ?? null, bal: lt };
  const last = fin?.years?.at(-1);
  if (!last) return null;
  return { ttm: false, end: last.end, year: last.year, inc: last, prev: fin.years.at(-2) ?? null, bal: fund?.years?.find((y) => y.end === last.end) ?? null };
}

/**
 * Múltiplos con un precio. `inc`: ingresos, utilidad operativa y utilidad neta del periodo; `bal`: flujo operativo,
 * inversión, depreciación, caja, deuda y patrimonio del mismo periodo. Lo que no se puede calcular queda en null
 * (un P/E con pérdidas, un EV sin deuda informada).
 */
export function multiples({ price, shares, adr = 1, k = 1 }, inc, bal) {
  const cap = (price * shares) / adr;
  const usd = (v) => (v == null ? null : v * k);
  const [ni, rev, op] = [usd(inc?.netIncome), usd(inc?.revenue), usd(inc?.operatingIncome)];
  const [eq, debt, cash, ocf, capex, da] = [usd(bal?.equity), usd(bal?.debt), usd(bal?.cash), usd(bal?.ocf), usd(bal?.capex), usd(bal?.da)];
  const ebitda = op != null && da != null ? op + da : null;
  const ev = debt != null && cash != null ? cap + debt - cash : null;
  const fcf = ocf != null && capex != null ? ocf - capex : null;
  return {
    cap,
    ev,
    ebitda,
    fcf,
    pe: ni > 0 ? cap / ni : null,
    ps: rev > 0 ? cap / rev : null,
    pb: eq > 0 ? cap / eq : null,
    evEbitda: ev != null && ebitda > 0 ? ev / ebitda : null,
    fcfYield: fcf != null && cap > 0 ? fcf / cap : null,
    earningsYield: ni != null && cap > 0 ? ni / cap : null,
  };
}

/**
 * Los mismos múltiplos al cierre de cada año fiscal: el precio de ese día (ya ajustado por splits), las acciones de la
 * portada siguiente llevadas a acciones de hoy, y los números de ese año. Solo los años con precio guardado.
 */
export function multiplesHistory(fin, fund, points, k) {
  const shares = splitAdjusted(fin.shares ?? []);
  const out = [];
  for (const y of fin.years ?? []) {
    const c = closeAt(points, y.end);
    const sh = shares.find((s) => s.date >= y.end) ?? shares.at(-1);
    if (!c || !sh) continue;
    const bal = fund?.years?.find((f) => f.end === y.end) ?? null;
    out.push({ year: y.year, end: y.end, price: c[1], ...multiples({ price: c[1], shares: sh.adj, adr: fin.adrRatio ?? 1, k }, y, bal) });
  }
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Dónde está el valor de hoy frente a los de su historia: mediana, mínimo y máximo, cuánto se aleja de la mediana
 * (`rel`, null si la mediana no es positiva) y dónde cae entre el mínimo y el máximo (`at`, de 0 a 1, recortado).
 * null con menos de 3 años: con dos datos no hay «historia».
 */
export function standing(now, values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  if (now == null || xs.length < 3) return null;
  const [min, max, med] = [Math.min(...xs), Math.max(...xs), median(xs)];
  const lo = Math.min(min, now);
  const hi = Math.max(max, now);
  const pos = (v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  return { n: xs.length, median: med, min, max, rel: med > 0 ? now / med - 1 : null, at: pos(now), medianAt: pos(med), minAt: pos(min), maxAt: pos(max) };
}

/**
 * Valor por acción (o por ADR) de un DCF simple: el flujo de caja libre crece `g` % por 5 años y después `gt` % para
 * siempre, todo descontado a `r` %; al valor de la empresa se le resta la deuda neta (`nd`, en millones de US$). null
 * si la tasa no supera al crecimiento perpetuo por al menos medio punto.
 */
export function dcfValue(fcf, sharesAdr, { g, gt, r, nd }) {
  if (!(r > gt + 0.5)) return null;
  let f = fcf;
  let pv = 0;
  for (let t = 1; t <= 5; t++) {
    f *= 1 + g / 100;
    pv += f / (1 + r / 100) ** t;
  }
  const tv = (f * (1 + gt / 100)) / (r / 100 - gt / 100) / (1 + r / 100) ** 5;
  return { perShare: (pv + tv - nd * 1e6) / sharesAdr, pv, tv };
}

/** Los crecimientos entre los que se busca: fuera de ahí, el DCF simple ya no describe nada. */
export const IMPLIED_RANGE = [-30, 60];

/**
 * DCF al revés: el crecimiento anual de los años 1 a 5 con el que el DCF da justo el precio de hoy, o sea, lo que el
 * precio «ya descuenta» con esa tasa y ese crecimiento perpetuo. Devuelve `{ g }` o, si no hay solución en el rango,
 * `{ below: true }` (el precio pide menos que −30 % al año) o `{ above: true }` (más que 60 %). null si no se puede.
 */
export function impliedGrowth(price, fcf, sharesAdr, { gt, r, nd }) {
  if (!(price > 0) || !(fcf > 0) || !(sharesAdr > 0) || !(r > gt + 0.5)) return null;
  const gap = (g) => dcfValue(fcf, sharesAdr, { g, gt, r, nd }).perShare - price;
  let [lo, hi] = IMPLIED_RANGE;
  if (gap(lo) > 0) return { below: true };
  if (gap(hi) < 0) return { above: true };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > 0) hi = mid;
    else lo = mid;
  }
  return { g: Math.round(((lo + hi) / 2) * 10) / 10 };
}

/**
 * Lo que se compara lado a lado entre empresas, con lo más nuevo de cada una (latestOf): tamaño, crecimiento,
 * márgenes, rentabilidad y deuda (sin precio) y, si hay precio y acciones, sus múltiplos. En proporciones (0,25 = 25 %).
 */
export function peerMetrics(fin, fund, k, price) {
  const cur = latestOf(fin, fund);
  if (!cur) return null;
  const { inc, prev, bal } = cur;
  const usd = (v) => (v == null ? null : v * k);
  const div = (a, b) => (a != null && b != null && b > 0 ? a / b : null);
  const ebitda = inc.operatingIncome != null && bal?.da != null ? inc.operatingIncome + bal.da : null;
  const netDebt = bal?.debt != null && bal?.cash != null ? bal.debt - bal.cash : null;
  const fcf = bal?.ocf != null && bal?.capex != null ? bal.ocf - bal.capex : null;
  const sh = fin.shares?.at(-1);
  const m = price > 0 && sh ? multiples({ price, shares: sh.value, adr: fin.adrRatio ?? 1, k }, inc, bal) : null;
  return {
    ttm: cur.ttm,
    end: cur.end,
    revenueUsd: usd(inc.revenue),
    growth: inc.revenue != null && prev?.revenue > 0 && inc.revenue >= 0 ? inc.revenue / prev.revenue - 1 : null,
    opMargin: div(inc.operatingIncome, inc.revenue),
    netMargin: div(inc.netIncome, inc.revenue),
    roe: div(inc.netIncome, bal?.equity ?? null),
    roa: div(inc.netIncome, bal?.assets ?? null),
    debtToEquity: div(bal?.debt ?? null, bal?.equity ?? null),
    debtUsd: usd(bal?.debt ?? null),
    cashUsd: usd(bal?.cash ?? null),
    netDebtToEbitda: netDebt != null && ebitda > 0 ? netDebt / ebitda : null,
    fcfMargin: div(fcf, inc.revenue),
    pe: m?.pe ?? null,
    ps: m?.ps ?? null,
    evEbitda: m?.evEbitda ?? null,
    fcfYield: m?.fcfYield ?? null,
  };
}
