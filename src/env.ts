export interface Env {
  ASSETS: Fetcher;
  CACHE: KVNamespace;

  // vars (wrangler.jsonc)
  TIMEZONE: string;
  /** Origen del Worker del conector de Claude (mercados-mcp), destino fijo del login del conector. */
  MCP_URL?: string;
  /** Commit publicado (lo pone GitHub Actions al desplegar): se muestra al pie para que cualquiera revise el código. */
  VERSION?: string;
  /** Cuenta de Cloudflare de Rueda (no es secreta): para escribir en Access y enlazar su panel. */
  CF_ACCOUNT_ID?: string;

  // secretos (panel de Cloudflare → Variables and Secrets, o `.env` en local)
  /** https://<equipo>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /**
   * Lista vieja de quién entra (correos separados por comas). Ahora la lista vive en Rueda («Personas»): este secreto
   * solo se usa mientras esa lista no exista, y el primer cambio lo pasa a Rueda.
   */
  ALLOWED_EMAILS?: string;
  /**
   * Correos del dueño (separados por comas): solo ellos ven los precios de Twelve Data, porque la licencia
   * gratis no permite mostrarlos a otras personas. El resto ve solo datos públicos. Vacío = nadie los ve.
   */
  OWNER_EMAILS?: string;
  TWELVE_DATA_API_KEY?: string;
  FRED_API_KEY?: string;
  /** Clave gratis de Finnhub para las fechas de resultados de la lista (solo las ve el dueño: así lo piden sus términos). */
  FINNHUB_API_KEY?: string;
  /** Clave compartida con mercados-mcp para firmar «este correo inició sesión» (32+ caracteres). */
  LOGIN_LINK_SECRET?: string;
  /** Token de Cloudflare con un solo permiso («Access: Apps and Policies → Edit»): copia «Personas» a Access. */
  ACCESS_API_TOKEN?: string;

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
  'FINNHUB_API_KEY',
  'LOGIN_LINK_SECRET',
  'ACCESS_API_TOKEN',
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
