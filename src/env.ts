export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;

  // vars (wrangler.jsonc)
  TIMEZONE: string;

  // secretos (panel de Cloudflare → Variables and Secrets, o `.env` en local)
  /** https://<equipo>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Correos autorizados separados por comas. Vacío = no entra nadie. */
  ALLOWED_EMAILS?: string;
  /**
   * Correos del dueño (separados por comas): solo ellos ven los precios de Twelve Data, porque la licencia
   * gratis no permite mostrarlos a otras personas. El resto ve solo datos públicos. Vacío = nadie los ve.
   */
  OWNER_EMAILS?: string;
  TWELVE_DATA_API_KEY?: string;
  FRED_API_KEY?: string;

  // solo desarrollo local (se ignoran fuera de localhost)
  DEV_MODE?: string;
  MOCK_DATA?: string;
  /** "friend" simula a un amigo en local; si no, en local se entra como dueño. */
  DEV_ROLE?: string;
}

export const SECRET_KEYS = [
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'ALLOWED_EMAILS',
  'OWNER_EMAILS',
  'TWELVE_DATA_API_KEY',
  'FRED_API_KEY',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** true solo si DEV_MODE=true Y la petición llega a localhost. En Cloudflare el host nunca es localhost. */
export function isLocalDev(url: URL, env: Env): boolean {
  return env.DEV_MODE === 'true' && LOCAL_HOSTS.has(url.hostname);
}

export function isMock(url: URL, env: Env): boolean {
  return isLocalDev(url, env) && env.MOCK_DATA === 'true';
}

/** Quita espacios y comillas alrededor de los secretos (errores típicos al pegarlos). */
export function trimSecrets(env: Env): Env {
  const out: Env = { ...env };
  for (const k of SECRET_KEYS) if (typeof out[k] === 'string') out[k] = out[k]!.trim().replace(/^["']|["']$/g, '');
  return out;
}
