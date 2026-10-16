import { allowedEmails, verifyAccess } from './auth/access';
import { isLocalDev, isMock, trimSecrets, type Env } from './env';
import { ApiError, errorResponse, escapeHtml, htmlPage, json } from './lib/http';
import { handleMcp } from './mcp';
import { mockHistory, mockPeru, mockQuotes, mockUsa } from './mock';
import {
  DAILY_CREDIT_CAP,
  MAX_SYMBOLS,
  creditsUsed,
  getWatchlist,
  history,
  peru,
  quotes,
  saveWatchlist,
  usa,
  validateWatchlist,
  type Deps,
} from './services/market';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export default {
  async fetch(req: Request, rawEnv: Env, _ctx: ExecutionContext): Promise<Response> {
    const env = trimSecrets(rawEnv);
    const url = new URL(req.url);
    const local = isLocalDev(url, env);

    if (!local) {
      const auth = await verifyAccess(req, env);
      if (!auth.ok) {
        return withSecurityHeaders(htmlPage('Acceso restringido', `<p>${escapeHtml(auth.reason)}</p>`, auth.status));
      }
    }

    let res: Response;
    try {
      res = (await route(req, env, url)) ?? (await env.ASSETS.fetch(req));
    } catch (e) {
      res = errorResponse(e);
    }
    return withSecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p !== '/mcp' && !p.startsWith('/api/')) return null;

  const now = new Date();
  const mock = isMock(url, env);
  const deps: Deps = { kv: env.CACHE, now, twelveKey: env.TWELVE_DATA_API_KEY, fredKey: env.FRED_API_KEY };

  // Conector de Claude. Llega aquí solo con un JWT de Access válido (Managed OAuth le da el token a Claude).
  if (p === '/mcp') return handleMcp(req, { deps, mock, timeZone: env.TIMEZONE || 'America/Lima' });

  if (req.method === 'GET') {
    switch (p) {
      case '/api/status':
        return json({
          config: configStatus(env),
          credits: { used: await creditsUsed(env.CACHE, now), cap: DAILY_CREDIT_CAP, plan: 800 },
          mock,
          now: now.toISOString(),
        });

      case '/api/watchlist':
        return json({ symbols: await getWatchlist(env.CACHE), max: MAX_SYMBOLS });

      case '/api/quotes': {
        const symbols = await getWatchlist(env.CACHE);
        const res = mock ? mockQuotes(symbols, now) : await quotes(deps, symbols, url.searchParams.get('refresh') === '1');
        return json({ ...res, credits: { used: await creditsUsed(env.CACHE, now), cap: DAILY_CREDIT_CAP } });
      }

      case '/api/history': {
        const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
        if (!(await getWatchlist(env.CACHE)).includes(symbol)) {
          throw new ApiError('bad_request', 400, 'Solo se piden historiales de la lista de seguimiento.');
        }
        return json(mock ? mockHistory(symbol, now) : await history(deps, symbol));
      }

      case '/api/peru':
        return json(mock ? mockPeru(now) : await peru(deps));

      case '/api/usa':
        return json(mock ? mockUsa(now) : await usa(deps));
    }
  }

  if (p === '/api/watchlist' && req.method === 'PUT') {
    sameOrigin(req, url);
    const symbols = validateWatchlist(await req.json().catch(() => null));
    await saveWatchlist(env.CACHE, symbols);
    return json({ symbols, max: MAX_SYMBOLS });
  }

  return json({ error: { code: 'not_found', message: 'Ruta desconocida', provider: null } }, { status: 404 });
}

/** Las escrituras solo se aceptan desde la propia app (además de Access). */
function sameOrigin(req: Request, url: URL): void {
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) throw new ApiError('bad_request', 403, 'Origen no permitido.');
  if (!(req.headers.get('Content-Type') ?? '').includes('application/json')) {
    throw new ApiError('bad_request', 415, 'Usa Content-Type: application/json.');
  }
}

type SecretInfo = { loaded: false } | { loaded: true; length: number; formatOk: boolean };

/** Solo dice si cada secreto está cargado y si su formato parece correcto; nunca muestra valores. */
export function configStatus(env: Env): Record<string, SecretInfo | number> {
  const info = (v: string | undefined, ok: (s: string) => boolean): SecretInfo =>
    v ? { loaded: true, length: v.length, formatOk: ok(v) } : { loaded: false };
  // \u0016 aparece cuando Ctrl+V falla en un prompt oculto de la terminal.
  const clean = (s: string) => !/[\u0000-\u001f]/.test(s);
  return {
    ACCESS_TEAM_DOMAIN: info(env.ACCESS_TEAM_DOMAIN, (s) => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(s)),
    ACCESS_AUD: info(env.ACCESS_AUD, (s) => /^[0-9a-f]{64}$/.test(s)),
    ALLOWED_EMAILS: info(env.ALLOWED_EMAILS, (s) => clean(s) && s.includes('@')),
    allowedEmailCount: allowedEmails(env).length,
    TWELVE_DATA_API_KEY: info(env.TWELVE_DATA_API_KEY, (s) => /^[A-Za-z0-9]{16,64}$/.test(s)),
    FRED_API_KEY: info(env.FRED_API_KEY, (s) => /^[a-z0-9]{32}$/.test(s)),
  };
}

function withSecurityHeaders(res: Response): Response {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  // Todo es privado: nada en cachés compartidas; el HTML/JS se revalida siempre.
  if (!h.has('Cache-Control') || !h.get('Cache-Control')!.includes('no-store')) h.set('Cache-Control', 'private, no-cache');
  return r;
}
