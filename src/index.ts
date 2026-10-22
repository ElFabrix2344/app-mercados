import { allowedEmails, roleFor, verifyAccess, type Role } from './auth/access';
import { isLocalDev, isMock, trimSecrets, type Env } from './env';
import { CALENDAR_UNTIL, EVENTS, SOURCES, upcoming } from './lib/calendar';
import { ApiError, errorResponse, escapeHtml, htmlPage, json } from './lib/http';
import { NYSE_CALENDAR_UNTIL, usMarketOpen } from './lib/market-hours';
import { signPayload } from './lib/signed';
import { mockCompare, mockHistory, mockNews, mockPeru, mockPeruMarkets, mockPriceSource, mockQuotes, mockSymbolNews, mockUsa } from './mock';
import { marketNews, quoteName, symbolNews } from './services/news';
import { addTrade, deleteTrade, kvSource, readTrades, valuePortfolio } from './services/portfolio';
import {
  DAILY_CREDIT_CAP,
  DEFAULT_RANGE,
  MAX_SYMBOLS,
  RANGES,
  compare,
  compareSymbols,
  creditsUsed,
  getWatchlist,
  history,
  isRange,
  peru,
  peruMarkets,
  quotes,
  saveWatchlist,
  usa,
  validateWatchlist,
  type Deps,
  type Range,
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

    // En local no hay JWT: se entra como dueño, salvo DEV_ROLE=friend para probar la vista de amigos.
    let role: Role = env.DEV_ROLE === 'friend' ? 'friend' : 'owner';
    let email: string | null = local ? 'dev@localhost' : null;
    if (!local) {
      const auth = await verifyAccess(req, env);
      if (!auth.ok) {
        return withSecurityHeaders(htmlPage('Acceso restringido', `<p>${escapeHtml(auth.reason)}</p>`, auth.status));
      }
      role = roleFor(auth.email, env);
      email = auth.email;
    }

    let res: Response;
    try {
      res = (await route(req, env, url, role, email)) ?? (await env.ASSETS.fetch(req));
    } catch (e) {
      res = errorResponse(e);
    }
    return withSecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;

/** Precios de Twelve Data: su licencia gratis no permite mostrarlos a otras personas. */
const OWNER_ONLY = new Set(['/api/watchlist', '/api/quotes', '/api/history', '/api/compare', '/api/portfolio', '/api/news/symbol']);

async function route(req: Request, env: Env, url: URL, role: Role, email: string | null): Promise<Response | null> {
  const p = url.pathname;
  // Paso del login del conector de Claude (el conector vive en el Worker mercados-mcp).
  if (p === '/conector/identidad' && req.method === 'GET') return connectorIdentity(url, env, role, email);
  if (!p.startsWith('/api/')) return null;

  const now = new Date();
  const mock = isMock(url, env);
  const deps: Deps = { kv: env.CACHE, now, twelveKey: env.TWELVE_DATA_API_KEY, fredKey: env.FRED_API_KEY };

  if (OWNER_ONLY.has(p) && role !== 'owner') {
    throw new ApiError(
      'forbidden',
      403,
      'Los precios de mercado son solo para el dueño de la app: la licencia gratis de Twelve Data no permite mostrarlos a otras personas.',
    );
  }

  if (req.method === 'GET') {
    switch (p) {
      case '/api/status':
        // A los amigos no se les muestra la configuración ni el consumo de créditos. El estado de la bolsa
        // («Rueda abierta / cerrada») sale del horario de la NYSE, no de Twelve Data: lo ven todos.
        if (role !== 'owner') return json({ role, now: now.toISOString(), market: { open: usMarketOpen(now) } });
        return json({
          role,
          market: { open: usMarketOpen(now) },
          config: configStatus(env),
          credits: { used: await creditsUsed(env.CACHE, now), cap: DAILY_CREDIT_CAP, plan: 800 },
          // Hasta cuándo están cargados los feriados de la NYSE (después solo se excluyen fines de semana).
          marketCalendarUntil: NYSE_CALENDAR_UNTIL,
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
        const range = rangeParam(url);
        const r = mock ? mockHistory(symbol, now, range) : await history(deps, symbol, range);
        // Los indicadores pesan más que los cierres: van solo si se piden (la ficha sí, los minigráficos no).
        return json(url.searchParams.get('ind') === '1' ? r : { ...r, indicators: undefined });
      }

      case '/api/compare': {
        const list = await getWatchlist(env.CACHE);
        const symbols = compareSymbols((url.searchParams.get('symbols') ?? '').split(','));
        const outside = symbols.filter((s) => !list.includes(s));
        if (outside.length) throw new ApiError('bad_request', 400, `${outside.join(', ')} no está en la lista de seguimiento.`);
        const range = rangeParam(url);
        return json(mock ? mockCompare(symbols, now, range) : await compare(deps, symbols, range));
      }

      case '/api/portfolio': {
        const src = mock ? mockPriceSource(await getWatchlist(env.CACHE), now) : kvSource(deps);
        return json(await valuePortfolio(await readTrades(env.CACHE), src));
      }

      // Titulares públicos (RSS): también para los amigos.
      case '/api/news':
        return json(mock ? mockNews(now) : await marketNews(deps));

      // Titulares de un símbolo de la lista (la lista es del dueño).
      case '/api/news/symbol': {
        const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
        if (!(await getWatchlist(env.CACHE)).includes(symbol)) {
          throw new ApiError('bad_request', 400, 'Solo hay noticias por acción para los símbolos de la lista.');
        }
        const items = mock ? mockSymbolNews(symbol, now) : await symbolNews(deps, symbol, await quoteName(env.CACHE, symbol));
        return json({ symbol, items, fetchedAt: now.toISOString() });
      }

      case '/api/peru':
        return json(mock ? mockPeru(now) : await peru(deps));

      case '/api/peru-markets':
        return json(mock ? mockPeruMarkets(now) : await peruMarkets(deps));

      case '/api/usa':
        return json(mock ? mockUsa(now) : await usa(deps));

      case '/api/calendar': {
        // Fechas oficiales cargadas en el código: no llama a ninguna API.
        const days = Math.min(366, Math.max(1, Math.round(Number(url.searchParams.get('days'))) || 120));
        return json({
          loaded: EVENTS.length > 0,
          events: upcoming(EVENTS, now, days, env.TIMEZONE || 'America/Lima'),
          coverage: CALENDAR_UNTIL,
          sources: SOURCES,
          now: now.toISOString(),
        });
      }
    }
  }

  // Cartera simulada: agregar (POST con la operación) o borrar (DELETE ?id=…); responde la cartera ya valorizada.
  if (p === '/api/portfolio' && (req.method === 'POST' || req.method === 'DELETE')) {
    sameOrigin(req, url);
    const list = await getWatchlist(env.CACHE);
    const src = mock ? mockPriceSource(list, now) : kvSource(deps);
    if (req.method === 'POST') await addTrade(deps, src, await req.json().catch(() => null), list);
    else await deleteTrade(deps, url.searchParams.get('id') ?? '');
    return json(await valuePortfolio(await readTrades(env.CACHE), src));
  }

  if (p === '/api/watchlist' && req.method === 'PUT') {
    sameOrigin(req, url);
    const symbols = validateWatchlist(await req.json().catch(() => null));
    await saveWatchlist(env.CACHE, symbols);
    return json({ symbols, max: MAX_SYMBOLS });
  }

  return json({ error: { code: 'not_found', message: 'Ruta desconocida', provider: null } }, { status: 404 });
}

/**
 * Login del conector: el Worker mercados-mcp manda aquí al navegador con un `state`. Access ya
 * confirmó el correo, así que se lo devolvemos firmado y con 2 minutos de validez. El `state` solo
 * sirve en el navegador que empezó el login (cookie del conector), y el destino es fijo (MCP_URL).
 */
async function connectorIdentity(url: URL, env: Env, role: Role, email: string | null): Promise<Response> {
  const state = url.searchParams.get('state') ?? '';
  const mcpUrl = (env.MCP_URL ?? '').replace(/\/+$/, '');
  if (!mcpUrl || (env.LOGIN_LINK_SECRET ?? '').length < 32) {
    return htmlPage('Conector sin configurar', '<p>Falta MCP_URL o LOGIN_LINK_SECRET en la app.</p>', 503);
  }
  if (!state || state.length > 1024) {
    return htmlPage('No se pudo conectar Claude', '<p>El enlace está incompleto. Vuelve a conectar desde Claude.</p>', 400);
  }
  if (role !== 'owner' || !email) {
    return htmlPage('Conector solo para el dueño', '<p>Por ahora el conector de Claude solo está disponible para el dueño de la app.</p>', 403);
  }
  const target = new URL('/callback', mcpUrl);
  target.searchParams.set('state', state);
  target.searchParams.set('identidad', await signPayload({ state, email, exp: Date.now() + 2 * 60_000 }, env.LOGIN_LINK_SECRET));
  return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
}

function rangeParam(url: URL): Range {
  const range = url.searchParams.get('range') ?? DEFAULT_RANGE;
  if (!isRange(range)) throw new ApiError('bad_request', 400, `Rango no válido. Usa uno de: ${RANGES.join(', ')}.`);
  return range;
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
    OWNER_EMAILS: info(env.OWNER_EMAILS, (s) => clean(s) && s.includes('@')),
    LOGIN_LINK_SECRET: info(env.LOGIN_LINK_SECRET, (s) => clean(s) && s.length >= 32),
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
