// Cifrado de la cuenta Hapi en el navegador. La frase de cada uno nunca sale de su equipo y Rueda solo guarda texto
// ilegible: ni el dueño de la app puede leer la cuenta de otro. La clave sale de la frase con PBKDF2-SHA-256 y cifra
// con AES-GCM de 256 bits (Web Crypto). Sin la frase no hay forma de recuperar la cuenta.

export const KDF_ITERATIONS = 600_000;
/** Ata el texto cifrado a este uso: no sirve para descifrar otra cosa con la misma clave. */
const AAD = new TextEncoder().encode('rueda-hapi-v2');
const te = new TextEncoder();
const td = new TextDecoder();

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Clave AES no exportable sacada de la frase (tarda un poco a propósito: así adivinarla cuesta caro). */
export async function deriveKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Clave nueva (con sal nueva) para una frase: al crear la cuenta o al cambiar la frase. */
export async function newKey(passphrase, iterations = KDF_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(passphrase, salt, iterations), kdf: { salt: b64(salt), iterations } };
}

/** La clave de una cuenta ya guardada, a partir de la frase. */
export const keyForBlob = (passphrase, blob) => deriveKey(passphrase, unb64(blob.kdf.salt), blob.kdf.iterations);

export async function encryptAccount(account, key, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, te.encode(JSON.stringify(account))));
  return { v: 2, kdf, iv: b64(iv), ct: b64(ct) };
}

export async function decryptAccount(blob, key) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: AAD }, key, unb64(blob.ct));
  } catch {
    throw new Error('La frase no es correcta.');
  }
  return JSON.parse(td.decode(plain));
}

// ---------- recordar la clave en este equipo ----------
// IndexedDB guarda la clave como objeto no exportable: queda en este navegador y ni el código de la página puede leer
// sus bytes. Se identifica por la sal de la cuenta. Sin IndexedDB (navegación privada) no se recuerda y ya.

const DB = 'rueda-hapi';
const STORE = 'keys';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }).finally(() => d.close());
}

export async function rememberKey(id, key) {
  try {
    await tx('readwrite', (s) => s.put(key, id));
    return true;
  } catch {
    return false;
  }
}

export async function recallKey(id) {
  try {
    return (await tx('readonly', (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetKeys() {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* sin IndexedDB no había nada guardado */
  }
}
