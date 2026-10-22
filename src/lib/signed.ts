// Mensajes firmados (HMAC-SHA256) entre la app y el Worker del conector: «este correo inició sesión
// en Access para esta autorización». El secreto (LOGIN_LINK_SECRET) es el mismo en los dos Workers.

const enc = new TextEncoder();
const MIN_SECRET_LENGTH = 32;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Falla cerrado: sin un secreto de al menos 32 caracteres no se firma nada. */
function checkSecret(secret: string | undefined): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error('LOGIN_LINK_SECRET falta o es muy corto.');
  return secret;
}

export async function signPayload(payload: { exp: number } & Record<string, unknown>, secret: string | undefined): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(checkSecret(secret)), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Devuelve el contenido si la firma es válida y no venció; si no, null. */
export async function verifyPayload<T extends { exp: number }>(token: string, secret: string | undefined, now = Date.now()): Promise<T | null> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
    return typeof payload.exp === 'number' && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}
