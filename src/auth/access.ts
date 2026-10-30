// Validación del JWT de Cloudflare Access (segunda capa: Access ya filtra en el borde,
// pero así el Worker nunca sirve datos si Access se desactiva o se configura mal).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../env';
import { canEnter, emailList } from '../services/people';

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function teamDomain(env: Env): string | null {
  const raw = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  return raw.startsWith('https://') ? raw : `https://${raw}`;
}

/** «owner» ve todo; «friend» solo los datos públicos (BCRP y FRED). */
export type Role = 'owner' | 'friend';

/** Falla cerrado: si OWNER_EMAILS está vacío, nadie ve los precios de Twelve Data. */
export function roleFor(email: string | null, env: Pick<Env, 'OWNER_EMAILS'>): Role {
  return email && emailList(env.OWNER_EMAILS).includes(email.toLowerCase()) ? 'owner' : 'friend';
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/** `keys`: las llaves con que Access firma (por defecto, las de su equipo; las pruebas pasan unas locales). */
export async function verifyAccess(req: Request, env: Env, keys?: JWTVerifyGetKey): Promise<AccessResult> {
  const team = teamDomain(env);
  const aud = (env.ACCESS_AUD ?? '').trim();
  // Falla cerrado: sin configuración completa (y sin dueño ni lista vieja de correos) no se sirve nada.
  if (!team || !aud) return { ok: false, status: 503, reason: 'Cloudflare Access no está configurado (ACCESS_TEAM_DOMAIN / ACCESS_AUD).' };
  if (!emailList(env.OWNER_EMAILS).length && !emailList(env.ALLOWED_EMAILS).length) {
    return { ok: false, status: 503, reason: 'Falta OWNER_EMAILS: sin dueño no entra nadie.' };
  }

  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(req, 'CF_Authorization');
  if (!token) return { ok: false, status: 401, reason: 'Falta el token de Cloudflare Access.' };

  let jwks = keys ?? jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: aud, algorithms: ['RS256'] });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    if (!email) return { ok: false, status: 403, reason: 'Access no informó con qué correo entraste.' };
    // Access dejó pasar el correo (le llegó el código), pero no está en la lista de Rueda: que sepa cuál usó.
    if (!(await canEnter(env, email))) {
      return { ok: false, status: 403, reason: `Entraste con ${email}, pero ese correo no está en la lista de Rueda. Pídele al dueño de la app que lo agregue, o sal y vuelve a entrar con el correo que le diste.` };
    }
    return { ok: true, email };
  } catch (e) {
    return { ok: false, status: 401, reason: `Token de Access inválido: ${(e as Error).message}` };
  }
}
