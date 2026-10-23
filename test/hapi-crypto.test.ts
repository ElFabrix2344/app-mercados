import { describe, expect, it } from 'vitest';
import { b64, decryptAccount, encryptAccount, keyForBlob, newKey, unb64 } from '../public/hapi-crypto.js';

// Pocas vueltas para que la prueba sea rápida; la app usa 600.000.
const ITER = 1000;
const ACCOUNT = { v: 1, plan: 'standard', ops: [{ id: 'a', kind: 'deposit', date: '2026-09-01', amount: 100, fee: 1.99 }], snapshot: null };

describe('cifrado de la cuenta Hapi', () => {
  it('solo se abre con la misma frase; el texto guardado no deja ver nada', async () => {
    const { key, kdf } = await newKey('una frase larga de prueba', ITER);
    const blob = await encryptAccount(ACCOUNT, key, kdf);
    expect(blob).toMatchObject({ v: 2, kdf: { iterations: ITER } });
    expect(atob(blob.ct)).not.toContain('deposit');
    expect(unb64(blob.iv)).toHaveLength(12);
    // Otro navegador: con la frase vuelve a sacar la misma clave a partir de la sal guardada.
    expect(await decryptAccount(blob, await keyForBlob('una frase larga de prueba', blob))).toEqual(ACCOUNT);
    await expect(decryptAccount(blob, await keyForBlob('otra frase', blob))).rejects.toThrow('La frase no es correcta.');
  });

  it('cada guardado usa un vector nuevo: el mismo contenido no se ve igual dos veces', async () => {
    const { key, kdf } = await newKey('una frase larga de prueba', ITER);
    const a = await encryptAccount(ACCOUNT, key, kdf);
    const b = await encryptAccount(ACCOUNT, key, kdf);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('base64 de textos grandes (miles de movimientos)', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(unb64(b64(big))).toEqual(big);
  });
});
