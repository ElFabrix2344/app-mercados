import { describe, expect, it } from 'vitest';
import type { Quote } from '../src/lib/twelvedata';
import { playerId } from '../src/services/forecasts';
import { deleteStore, hapiMarket, readStore, saveStore, validateBlob } from '../src/services/hapi';
import type { PriceSource } from '../src/services/portfolio';
import { memoryKV } from './helpers';

const NOW = new Date('2026-10-23T15:00:00Z');
const ME = 'yo@example.com';
const FRIEND = 'amigo@example.com';
const BLOB = { v: 2, kdf: { salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iterations: 600_000 }, iv: 'aXZpdml2aXZpdml2', ct: 'Y2lmcmFkbw==' };

describe('cuenta de Hapi cifrada en el servidor', () => {
  it('solo acepta texto cifrado con la forma esperada', () => {
    expect(validateBlob(BLOB)).toEqual(BLOB);
    expect(() => validateBlob({ ...BLOB, v: 1 })).toThrow('formato');
    expect(() => validateBlob({ ...BLOB, ct: 'no es base64 {}' })).toThrow('formato');
    expect(() => validateBlob({ ...BLOB, kdf: { ...BLOB.kdf, iterations: 1000 } })).toThrow('formato');
    expect(() => validateBlob({ ops: [] })).toThrow('formato');
  });

  it('cada persona guarda la suya; el servidor nunca ve el contenido', async () => {
    const mem = memoryKV();
    const saved = await saveStore(mem.kv, ME, NOW, { blob: BLOB, base: null });
    const mine = await readStore(mem.kv, ME);
    expect(mine).toEqual({ blob: BLOB, version: saved.version, legacy: null });
    expect(await readStore(mem.kv, FRIEND)).toEqual({ blob: null, version: null, legacy: null });
    // Lo guardado es solo el texto cifrado y la versión.
    expect([...mem.store.values()].join()).not.toMatch(/deposit|buy|VOO/);
  });

  it('no pisa un cambio hecho en otro equipo', async () => {
    const mem = memoryKV();
    const first = await saveStore(mem.kv, ME, NOW, { blob: BLOB, base: null });
    await expect(saveStore(mem.kv, ME, NOW, { blob: BLOB, base: null })).rejects.toMatchObject({ status: 409 });
    const second = await saveStore(mem.kv, ME, NOW, { blob: BLOB, base: first.version });
    expect(second.version).not.toBe(first.version);
    await expect(saveStore(mem.kv, ME, NOW, { blob: BLOB, base: first.version })).rejects.toMatchObject({ status: 409 });
  });

  it('la cuenta sin cifrar de la primera versión se entrega para cifrarla, y el cifrado la reemplaza', async () => {
    const legacy = { plan: 'standard', ops: [{ id: 'a', kind: 'deposit', date: '2026-10-01', amount: 100, fee: 1.99 }], snapshot: null };
    // Misma clave que usaba la versión sin cifrar: `hapi:<jugador>`.
    const mem = memoryKV({ [`hapi:${await playerId(FRIEND)}`]: legacy });
    expect(await readStore(mem.kv, FRIEND)).toEqual({ blob: null, version: null, legacy });
    await saveStore(mem.kv, FRIEND, NOW, { blob: BLOB, base: null });
    expect(await readStore(mem.kv, FRIEND)).toMatchObject({ blob: BLOB, legacy: null });
    expect([...mem.store.values()].join()).not.toContain('deposit');
  });

  it('se puede borrar (si se olvidó la frase)', async () => {
    const mem = memoryKV();
    await saveStore(mem.kv, ME, NOW, { blob: BLOB, base: null });
    await deleteStore(mem.kv, ME);
    expect((await readStore(mem.kv, ME)).blob).toBeNull();
  });
});

describe('hapiMarket', () => {
  const quote = (symbol: string, price: number): Quote => ({
    symbol,
    name: symbol,
    exchange: 'NYSE',
    currency: 'USD',
    price,
    prevClose: price,
    change: 0,
    changePct: 0,
    isMarketOpen: true,
    low52: null,
    high52: null,
    asOf: NOW.toISOString(),
  });
  const src: PriceSource = {
    quotes: async () => ({ quotes: [quote('VOO', 450)], errors: {}, symbols: ['VOO'], fetched: {} }),
    closes: async (s) => (s === 'SCCO' ? [['2026-10-22', 150]] : null),
    usdPen: async () => null,
  };
  const fx = async () => ({ rate: 3.8, date: '2026-10-22' });

  it('el dueño recibe los precios guardados (lista o cierres); los demás, solo el dólar', async () => {
    expect(await hapiMarket(src, ['VOO', 'SCCO', 'ZZZ'], fx)).toEqual({ prices: { VOO: 450, SCCO: 150 }, fx: { rate: 3.8, date: '2026-10-22' } });
    expect(await hapiMarket(null, [], fx)).toEqual({ prices: null, fx: { rate: 3.8, date: '2026-10-22' } });
  });
});
