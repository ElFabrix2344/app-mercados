// Cifrado de las claves de Twelve Data que conecta cada jugador de la liga de acciones: AES-GCM con una llave derivada
// (HKDF) de LOGIN_LINK_SECRET, con su propia etiqueta, así no hace falta otro secreto. Aunque alguien leyera el
// almacenamiento del juego, no vería las claves; solo el servidor las abre, para valorizar la cartera de cada uno.

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface Sealed {
  iv: string;
  ct: string;
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('Falta LOGIN_LINK_SECRET (32 caracteres o más) para cifrar las claves.');
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('rueda'), info: enc.encode('liga-de-acciones:claves-twelve-data') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(secret: string, plain: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(secret), enc.encode(plain)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function unseal(secret: string, box: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await keyFrom(secret), unb64(box.ct));
  return new TextDecoder().decode(plain);
}
