// Comisiones de Hapi (el bróker que usa el grupo) para acciones y ETF en horario regular, según su centro de ayuda
// (help.hapi.trade, octubre de 2026). Hapi no tiene API: son el valor por defecto al anotar una operación, y cada
// una se corrige con lo que diga la confirmación de Hapi.

export type HapiPlan = 'standard' | 'prime';
export const HAPI_PLANS: readonly HapiPlan[] = ['standard', 'prime'];

/** Cargo de compensación por orden, en US$: acciones enteras o fracciones (con Prime, lo mismo para ambas). */
const CLEARING: Record<HapiPlan, { whole: number; fraction: number }> = {
  standard: { whole: 0.1, fraction: 0.15 },
  prime: { whole: 0.05, fraction: 0.05 },
};
/** Cargo de la SEC en las ventas: US$ 20,60 por millón vendido, vigente desde el 4 de abril de 2026. */
export const SEC_FEE_RATE = 20.6 / 1_000_000;
/** FINRA TAF en las ventas: por acción vendida, con tope por orden. */
export const TAF_PER_SHARE = 0.000195;
export const TAF_MAX = 9.79;
/** FINRA no cobra el TAF por las ventas del 1 de octubre al 31 de diciembre de 2026. */
const TAF_PAUSE = { from: '2026-10-01', to: '2026-12-31' };
/** Depósito en soles (Cross Payments, el más barato desde el Perú) y retiro en soles, en US$. */
export const DEPOSIT_FEE = 1.99;
export const WITHDRAWAL_FEE = 4.99;
/** EE. UU. retiene el 30 % de los dividendos a los no residentes: el Perú no tiene convenio con EE. UU. */
export const DIVIDEND_WITHHOLDING = 0.3;

const centsUp = (x: number) => Math.ceil(x * 100 - 1e-7) / 100;
const cents = (x: number) => Math.round(x * 100) / 100;

export interface OrderFee {
  clearing: number;
  sec: number;
  taf: number;
  total: number;
}

/** Costos de una orden de Hapi; los de la SEC y FINRA solo en las ventas, al centavo hacia arriba. */
export function orderFee(side: 'buy' | 'sell', qty: number, price: number, date: string, plan: HapiPlan): OrderFee {
  const whole = Math.abs(qty - Math.round(qty)) < 1e-9;
  const clearing = CLEARING[plan][whole ? 'whole' : 'fraction'];
  let sec = 0;
  let taf = 0;
  if (side === 'sell') {
    sec = centsUp(qty * price * SEC_FEE_RATE);
    taf = date >= TAF_PAUSE.from && date <= TAF_PAUSE.to ? 0 : Math.min(TAF_MAX, centsUp(qty * TAF_PER_SHARE));
  }
  return { clearing, sec, taf, total: cents(clearing + sec + taf) };
}
