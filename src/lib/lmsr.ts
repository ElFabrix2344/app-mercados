// Creador de mercado automático para el mercado de predicciones (LMSR, «logarithmic market scoring rule», de Robin
// Hanson). Es lo que usan los mercados con poca gente: siempre hay contraparte y el precio se mueve con cada compra.
// Una acción paga 1 si gana su lado (el panel la muestra en fichas: ×100) y el precio de «Sí» es la probabilidad que
// le da el mercado. `b` es la liquidez: con más b, cada compra mueve menos el precio. El creador de mercado puede
// perder como mucho b·ln 2: son fichas que se inventan, no plata.

export type Side = 'si' | 'no';

/** Exponenciales sin desbordar: se resta el mayor antes de elevar. */
function exps(qYes: number, qNo: number, b: number): { m: number; ey: number; en: number } {
  const m = Math.max(qYes, qNo);
  return { m, ey: Math.exp((qYes - m) / b), en: Math.exp((qNo - m) / b) };
}

/** Precio (probabilidad) de «Sí», entre 0 y 1. */
export function priceYes(qYes: number, qNo: number, b: number): number {
  const { ey, en } = exps(qYes, qNo, b);
  return ey / (ey + en);
}

/** Función de costo: lo que costó llegar a estas cantidades de acciones. */
export function cost(qYes: number, qNo: number, b: number): number {
  const { m, ey, en } = exps(qYes, qNo, b);
  return m + b * Math.log(ey + en);
}

/** Acciones de `side` que se compran con `spend` (en acciones: 1 = lo que paga una acción ganadora). */
export function sharesFor(qYes: number, qNo: number, b: number, side: Side, spend: number): number {
  // C(q + Δ) − C(q) = spend  ⇒  e^{(q_lado + Δ)/b} = e^{spend/b}·(e^{q_lado/b} + e^{q_otro/b}) − e^{q_otro/b}
  const [qs, qo] = side === 'si' ? [qYes, qNo] : [qNo, qYes];
  const m = Math.max(qs, qo);
  const es = Math.exp((qs - m) / b);
  const eo = Math.exp((qo - m) / b);
  return m + b * Math.log(Math.exp(spend / b) * (es + eo) - eo) - qs;
}

/** Lo que se recibe al vender `shares` acciones de `side` (en acciones, igual que `spend`). */
export function saleValue(qYes: number, qNo: number, b: number, side: Side, shares: number): number {
  const after = side === 'si' ? cost(qYes - shares, qNo, b) : cost(qYes, qNo - shares, b);
  return cost(qYes, qNo, b) - after;
}
