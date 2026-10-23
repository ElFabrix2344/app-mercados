// Cuenta de Hapi de cada persona, cifrada en su navegador con su frase (public/hapi-crypto.js): aquí solo se guarda y
// se devuelve texto ilegible. Ni el dueño de la app puede leer la cuenta de otro; lo único que se ve es que existe, su
// tamaño y cuándo cambió. Las cuentas, los cálculos y el lector del estado de cuenta corren en el navegador
// (public/hapi-core.js, public/hapi-statement.js). Un registro por persona en KV (`hapi:<jugador>`, el id del juego de
// pronósticos): cada cambio es una escritura.

import { ApiError } from '../lib/http';
import { playerId } from './forecasts';
import type { PriceSource } from './portfolio';

export interface HapiBlob {
  v: 2;
  /** Cómo se sacó la clave de la frase (PBKDF2-SHA-256): sal en base64 y vueltas. */
  kdf: { salt: string; iterations: number };
  iv: string;
  ct: string;
}

/** Cuenta de la primera versión (21 oct, sin cifrar): se cifra la primera vez que su dueño pone una frase. */
export interface LegacyAccount {
  plan?: string;
  ops: unknown[];
  snapshot?: unknown;
}

export interface HapiStore {
  blob: HapiBlob | null;
  /** Versión guardada (opaca): el navegador la devuelve al guardar para no pisar un cambio hecho en otro equipo. */
  version: string | null;
  legacy: LegacyAccount | null;
}

/** ~1,1 MB de texto cifrado: alcanza para miles de movimientos. */
export const MAX_CT = 1_500_000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const keyOf = async (email: string) => `hapi:${await playerId(email)}`;

export function validateBlob(input: unknown): HapiBlob {
  const b = (input ?? {}) as Record<string, unknown>;
  const kdf = (b.kdf ?? {}) as Record<string, unknown>;
  const b64 = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && B64_RE.test(v);
  const iterations = kdf.iterations;
  if (
    b.v !== 2 ||
    !b64(kdf.salt, 64) ||
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 10_000_000 ||
    !b64(b.iv, 32) ||
    !b64(b.ct, MAX_CT)
  ) {
    throw new ApiError('bad_request', 400, 'La cuenta cifrada no tiene el formato esperado.');
  }
  return { v: 2, kdf: { salt: kdf.salt, iterations }, iv: b.iv, ct: b.ct };
}

export async function readStore(kv: KVNamespace, email: string): Promise<HapiStore> {
  const rec = await kv.get<Record<string, unknown>>(await keyOf(email), 'json');
  if (rec?.blob) return { blob: rec.blob as HapiBlob, version: typeof rec.version === 'string' ? rec.version : null, legacy: null };
  if (rec && Array.isArray(rec.ops)) return { blob: null, version: null, legacy: rec as unknown as LegacyAccount };
  return { blob: null, version: null, legacy: null };
}

/**
 * Guarda la cuenta cifrada. `base` es la versión que tenía el navegador: si otro equipo guardó antes, responde 409 y
 * el navegador recarga (KV tarda hasta un minuto en propagarse entre regiones: es una protección, no una garantía).
 */
export async function saveStore(kv: KVNamespace, email: string, now: Date, input: unknown): Promise<{ version: string }> {
  const body = (input ?? {}) as { blob?: unknown; base?: unknown };
  const blob = validateBlob(body.blob);
  const current = await readStore(kv, email);
  const base = typeof body.base === 'string' ? body.base : null;
  if (current.version !== base) {
    throw new ApiError('bad_request', 409, 'Tu cuenta cambió en otro equipo: ya se recargó, vuelve a hacer el último cambio.');
  }
  const version = `${now.toISOString()}~${crypto.randomUUID().slice(0, 8)}`;
  await kv.put(await keyOf(email), JSON.stringify({ blob, version }));
  return { version };
}

/** Borra la cuenta (por ejemplo, si se olvidó la frase: sin ella no hay cómo recuperarla). */
export async function deleteStore(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(await keyOf(email));
}

/**
 * Precios guardados del panel para valorizar la cuenta (solo el dueño: `src` null para los demás, cuyo navegador ni
 * siquiera manda sus símbolos) y el dólar del BCRP, que es público.
 */
export async function hapiMarket(
  src: PriceSource | null,
  symbols: string[],
  usdPen: () => Promise<{ rate: number; date: string } | null>,
): Promise<{ prices: Record<string, number> | null; fx: { rate: number; date: string } | null }> {
  let prices: Record<string, number> | null = null;
  if (src) {
    prices = {};
    const quotes = await src.quotes();
    for (const s of symbols) {
      const p = quotes?.quotes.find((q) => q.symbol === s)?.price ?? (await src.closes(s, false))?.at(-1)?.[1] ?? null;
      if (p !== null) prices[s] = p;
    }
  }
  return { prices, fx: await usdPen() };
}
