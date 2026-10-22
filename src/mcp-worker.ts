// Worker «mercados-mcp»: el conector de Claude con su propio login OAuth (claude.ai y celular).
// La app principal está detrás de Cloudflare Access, que no deja pasar a los servidores de Claude
// y cuyo login para conectores (Managed OAuth) falla en claude.ai. Por eso este Worker es su propio
// servidor OAuth (librería oficial de Cloudflare) y usa la app solo para confirmar quién eres:
//
//   Claude → /authorize (página de permiso) → app /conector/identidad (Access confirma tu correo)
//          → /callback (correo firmado) → código para Claude → /token → /mcp con el token.
//
// Por ahora el conector es solo para el dueño (OWNER_EMAILS): ve todo, igual que en el panel.

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { roleFor } from './auth/access';
import { escapeHtml } from './lib/http';
import { verifyPayload } from './lib/signed';
import { handleMcp } from './mcp';

/** URL pública de este Worker. El recurso OAuth debe ser exactamente la URL que se escribe en Claude. */
export const MCP_ORIGIN = 'https://mercados-mcp.mercados.workers.dev';
export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const SCOPE = 'mercados';

export interface McpEnv {
  CACHE: KVNamespace;
  OAUTH_KV: KVNamespace;
  /** Lo inyecta OAuthProvider en el defaultHandler. */
  OAUTH_PROVIDER: OAuthHelpers;
  TIMEZONE: string;
  /** Origen de la app principal (detrás de Access), donde se confirma el correo. */
  APP_URL: string;
  OWNER_EMAILS?: string;
  TWELVE_DATA_API_KEY?: string;
  FRED_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  LOGIN_LINK_SECRET?: string;
}

interface Props {
  email: string;
}

/**
 * Valor de un secreto sin espacios, saltos de línea ni comillas alrededor: al cargarlos con
 * `wrangler secret put` por tubería o pegándolos en el panel se cuelan (la app hace lo mismo con
 * `trimSecrets`). Si no, la firma del correo no coincide entre la app y el conector.
 */
export const secret = (v: string | undefined): string | undefined => v?.trim().replace(/^["']|["']$/g, '') || undefined;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#0a0a0a;color:#e8e8e8;font:15px/1.5 ui-monospace,Menlo,Consolas,monospace}
main{max-width:34rem;margin:3rem auto;padding:0 16px}h1{color:#45c8e6;font-size:1.1rem;letter-spacing:.06em;text-transform:uppercase}
p{color:#c8c8c8}.muted{color:#8f8f8f;font-size:.85rem}.warn{color:#f85149}strong{color:#fff}
button{font:inherit;padding:8px 16px;margin-right:8px;border-radius:4px;border:1px solid #2a2a2a;background:#121212;color:#e8e8e8;cursor:pointer}
button.ok{border-color:#45c8e6;color:#45c8e6}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers });
}

/** Solo Claude (claude.ai / claude.com) o una app local, como Claude Code. */
export function allowedRedirect(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    if (u.protocol === 'https:' && (u.hostname === 'claude.ai' || u.hostname === 'claude.com')) return true;
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return loopback && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

function consentPage(d: ConsentDescription, handle: string): string {
  const who = d.clientDomain
    ? `<strong>${escapeHtml(d.clientName)}</strong> (publicado por <strong>${escapeHtml(d.clientDomain)}</strong>)`
    : `<strong>${escapeHtml(d.clientName)}</strong> <span class="muted">(se registró solo; su nombre no está verificado)</span>`;
  const loopback = d.redirectIsLoopback
    ? '<p class="warn">El acceso irá a una app de tu computadora. Continúa solo si acabas de conectar desde ella (por ejemplo, Claude Code).</p>'
    : '';
  return `<p>${who} quiere leer los datos de tu panel Rueda: precios e historial de tu lista, Perú (BCRP) y EE. UU. (FRED). Solo lectura.</p>
<p>El acceso se enviará a <strong>${escapeHtml(d.redirectHost)}</strong>.</p>${loopback}
<p class="muted">Si permites, se abrirá el inicio de sesión de tu app Rueda para confirmar tu correo.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="ok" name="decision" value="approve">Permitir</button><button name="decision" value="deny">Cancelar</button></form>`;
}

async function showConsent(request: Request, env: McpEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  if (!allowedRedirect(details.redirectUri)) {
    return page('Cliente no permitido', '<p>Este conector solo funciona con Claude.</p>', 400);
  }
  const consent = await oauth.beginConsent(authRequest);
  return page('Conectar Claude', consentPage(details, consent.handle), 200, consent.headers);
}

async function decideConsent(request: Request, env: McpEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set('Location', denied.redirectTo);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  // El correo lo confirma la app (Access). `state` queda atado a este navegador con una cookie.
  const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
  const target = new URL('/conector/identidad', env.APP_URL);
  target.searchParams.set('state', state);
  headers.set('Location', target.toString());
  return new Response(null, { status: 302, headers });
}

async function finishLogin(request: Request, env: McpEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  // Recupera la autorización aprobada; exige la cookie de este navegador y funciona una sola vez.
  const { request: original, headers } = await oauth.finishUpstream(request);
  const claims = await verifyPayload<{ state: string; email: string; exp: number }>(
    url.searchParams.get('identidad') ?? '',
    secret(env.LOGIN_LINK_SECRET),
  );
  if (!claims || claims.state !== url.searchParams.get('state')) {
    console.warn('Login del conector: identidad inválida', { firmada: !!claims, mismoState: claims?.state === url.searchParams.get('state') });
    return page('No se pudo confirmar tu correo', '<p>El enlace venció o no es válido. Vuelve a conectar desde Claude.</p>', 400);
  }
  if (roleFor(claims.email, env) !== 'owner') {
    return page('Conector solo para el dueño', '<p>Por ahora el conector de Claude solo está disponible para el dueño de la app.</p>', 403);
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: claims.email,
    metadata: { label: claims.email },
    scope: original.scope,
    props: { email: claims.email } satisfies Props,
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

export const defaultHandler: ExportedHandler<McpEnv> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/authorize' && request.method === 'GET') return await showConsent(request, env);
      if (pathname === '/authorize' && request.method === 'POST') return await decideConsent(request, env);
      if (pathname === '/callback' && request.method === 'GET') return await finishLogin(request, env);
      if (pathname === '/') {
        return page('Rueda · conector de Claude', `<p>Agrégalo en claude.ai → Conectores → Agregar conector personalizado, con la URL:</p><p><strong>${MCP_RESOURCE}</strong></p>`);
      }
      return new Response('No encontrado', { status: 404, headers: SECURITY_HEADERS });
    } catch (e) {
      // Errores que llevan a Claude se redirigen; los demás se muestran aquí (nunca redirigir a un cliente no validado).
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) {
        return page('No se pudo conectar Claude', `<p>${escapeHtml(e.description)}</p><p class="muted">Vuelve a conectar desde Claude.</p>`, 400);
      }
      if (e instanceof CimdFetchError) {
        return page('No se pudo verificar la app', '<p>No se pudo leer la información de la app que pide acceso.</p>', 400);
      }
      throw e;
    }
  },
};

export const apiHandler = {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    const email = (ctx as unknown as { props?: Props }).props?.email ?? null;
    // Se revisa en cada pedido: si el correo deja de estar en OWNER_EMAILS, el conector deja de responder.
    if (roleFor(email, env) !== 'owner') {
      return Response.json({ error: 'forbidden', message: 'Esta cuenta ya no tiene acceso al conector.' }, { status: 403 });
    }
    return handleMcp(request, {
      deps: { kv: env.CACHE, now: new Date(), twelveKey: secret(env.TWELVE_DATA_API_KEY), fredKey: secret(env.FRED_API_KEY), finnhubKey: secret(env.FINNHUB_API_KEY) },
      mock: false,
      timeZone: env.TIMEZONE || 'America/Lima',
      role: 'owner',
    });
  },
};

export default new OAuthProvider<McpEnv>({
  apiRoute: '/mcp',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: [SCOPE, 'offline_access'],
  requiredScopes: [SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
    resource_name: 'Rueda',
  },
  clientIdMetadataDocumentEnabled: true,
});
