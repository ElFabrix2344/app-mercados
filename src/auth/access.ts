// Validación del JWT de Cloudflare Access (segunda capa: Access ya filtra en el borde,
// pero así el Worker nunca sirve datos si Access se desactiva o se configura mal).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../env';

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403 | 503; reason: string };

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function teamDomain(env: Env): string | null {
  const raw = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  return raw.startsWith('https://') ? raw : `https://${raw}`;
}

export function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export async function verifyAccess(req: Request, env: Env): Promise<AccessResult> {
  const team = teamDomain(env);
  const aud = (env.ACCESS_AUD ?? '').trim();
  const allowed = allowedEmails(env);
  // Falla cerrado: sin configuración completa (incluida la lista de correos) no se sirve nada.
  if (!team || !aud) return { ok: false, status: 503, reason: 'Cloudflare Access no está configurado (ACCESS_TEAM_DOMAIN / ACCESS_AUD).' };
  if (!allowed.length) return { ok: false, status: 503, reason: 'Falta ALLOWED_EMAILS: sin lista de correos no entra nadie.' };

  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(req, 'CF_Authorization');
  if (!token) return { ok: false, status: 401, reason: 'Falta el token de Cloudflare Access.' };

  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: aud, algorithms: ['RS256'] });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    if (!email || !allowed.includes(email)) {
      return { ok: false, status: 403, reason: 'Este correo no está autorizado.' };
    }
    return { ok: true, email };
  } catch (e) {
    return { ok: false, status: 401, reason: `Token de Access inválido: ${(e as Error).message}` };
  }
}
