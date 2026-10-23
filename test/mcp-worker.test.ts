// Recorre el login del conector como lo hará claude.ai: registro del cliente (DCR), página de permiso,
// paso por la app (Access) para confirmar el correo, código, token y consulta a /mcp con el token.

import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import app from '../src/index';
import { signPayload } from '../src/lib/signed';
import worker, { MCP_ORIGIN, MCP_RESOURCE, allowedRedirect, type McpEnv } from '../src/mcp-worker';
import { EVENTS } from '../src/lib/calendar';
import { DEFAULT_WATCHLIST } from '../src/services/market';
import { memoryKV } from './helpers';

/** La herramienta de calendario solo aparece cuando hay fechas cargadas. */
const CALENDAR_TOOL = EVENTS.length ? ['calendario'] : [];

const SECRET = 'x'.repeat(40);
const OWNER = 'yo@example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const APP = 'https://mercados.example';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** Precios guardados hace un momento: /mcp responde sin llamar a Twelve Data. */
function storedQuotes() {
  const at = new Date().toISOString();
  return {
    fetchedAt: at,
    data: {
      quotes: DEFAULT_WATCHLIST.map((s) => ({ symbol: s, name: s, exchange: 'NYSE', currency: 'USD', price: 1, changePct: 0.5, asOf: at })),
      errors: {},
      symbols: DEFAULT_WATCHLIST,
      fetched: Object.fromEntries(DEFAULT_WATCHLIST.map((s) => [s, at])),
    },
  };
}

function mcpEnv(extra: Partial<McpEnv> = {}): McpEnv {
  return {
    CACHE: memoryKV({ quotes: storedQuotes() }).kv,
    OAUTH_KV: memoryKV().kv,
    TIMEZONE: 'America/Lima',
    APP_URL: APP,
    OWNER_EMAILS: OWNER,
    LOGIN_LINK_SECRET: SECRET,
    ...extra,
  } as McpEnv;
}

/** Guarda las cookies que pone el Worker, como un navegador. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function register(env: McpEnv) {
  const res = await worker.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorizeUrl(clientId: string, verifier: string) {
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const u = new URL(`${MCP_ORIGIN}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'estado-de-claude',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mercados offline_access',
    resource: MCP_RESOURCE,
  }).toString();
  return u.toString();
}

describe('conector: descubrimiento OAuth', () => {
  it('/mcp sin token responde 401 con el desafío que lee claude.ai', async () => {
    const res = await worker.fetch(new Request(MCP_RESOURCE, { method: 'POST', body: '{}' }), mcpEnv(), ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('publica los metadatos del recurso y del servidor de autorización', async () => {
    const pr = (await (await worker.fetch(new Request(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`), mcpEnv(), ctx)).json()) as Record<string, unknown>;
    expect(pr.resource).toBe(MCP_RESOURCE);
    expect(pr.authorization_servers).toEqual([MCP_ORIGIN]);
    const as = (await (await worker.fetch(new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`), mcpEnv(), ctx)).json()) as Record<string, unknown>;
    expect(as.authorization_endpoint).toBe(`${MCP_ORIGIN}/authorize`);
    expect(as.registration_endpoint).toBe(`${MCP_ORIGIN}/register`);
  });
});

describe('conector: login completo', () => {
  it('registro → permiso → app (correo) → código → token → /mcp con sus herramientas', async () => {
    const env = mcpEnv();
    const jar = new Jar();
    const clientId = await register(env);
    const verifier = crypto.randomUUID() + crypto.randomUUID();

    // 1. Página de permiso
    const consent = await worker.fetch(new Request(await authorizeUrl(clientId, verifier)), env, ctx);
    expect(consent.status).toBe(200);
    jar.take(consent);
    const html = await consent.text();
    expect(html).toContain('claude.ai');
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;

    // 2. Permitir → va a la app a confirmar el correo
    const approve = await worker.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
        body: new URLSearchParams({ handle, decision: 'approve' }),
      }),
      env,
      ctx,
    );
    expect(approve.status).toBe(302);
    jar.take(approve);
    const toApp = new URL(approve.headers.get('Location')!);
    expect(toApp.origin + toApp.pathname).toBe(`${APP}/conector/identidad`);
    const state = toApp.searchParams.get('state')!;

    // 3. La app (ya con Access) firma el correo y vuelve al conector
    const appRes = await app.fetch(
      new Request(`http://localhost/conector/identidad?state=${encodeURIComponent(state)}`),
      { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MCP_URL: MCP_ORIGIN, LOGIN_LINK_SECRET: SECRET } as unknown as Env,
      ctx,
    );
    expect(appRes.status).toBe(302);
    const back = new URL(appRes.headers.get('Location')!);
    expect(back.origin + back.pathname).toBe(`${MCP_ORIGIN}/callback`);
    // En local la app entra como «dev@localhost»; para esta prueba se firma como el dueño.
    back.searchParams.set('identidad', await signPayload({ state, email: OWNER, exp: Date.now() + 60_000 }, SECRET));

    // 4. Callback → código para Claude
    const done = await worker.fetch(new Request(back, { headers: { Cookie: jar.header() } }), env, ctx);
    expect(done.status).toBe(302);
    const toClaude = new URL(done.headers.get('Location')!);
    expect(toClaude.origin + toClaude.pathname).toBe(CALLBACK);
    expect(toClaude.searchParams.get('state')).toBe('estado-de-claude');
    const code = toClaude.searchParams.get('code')!;

    // 5. Token
    const tokenRes = await worker.fetch(
      new Request(`${MCP_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: MCP_RESOURCE }),
      }),
      env,
      ctx,
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    expect(tokens.refresh_token).toBeTruthy();

    // 6. /mcp con el token
    const list = await worker.fetch(
      new Request(MCP_RESOURCE, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      env,
      ctx,
    );
    expect(list.status).toBe(200);
    // Los clientes con protocolo 2025 reciben la respuesta como evento SSE; los nuevos, como JSON.
    const text = await list.text();
    const raw = (list.headers.get('Content-Type') ?? '').includes('text/event-stream')
      ? text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)
      : text;
    const body = JSON.parse(raw) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['precios', 'historial', 'comparar', 'cartera', 'empresa', 'lista_diaria', 'peru_bcrp', 'eeuu_fred', 'resultados_anuales', 'noticias', 'pronosticos', ...CALENDAR_TOOL]);

    // 7. Si el correo deja de ser dueño, el mismo token ya no sirve
    const revoked = await worker.fetch(
      new Request(MCP_RESOURCE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      { ...env, OWNER_EMAILS: 'otro@example.com' },
      ctx,
    );
    expect(revoked.status).toBe(403);
  });

  it('acepta la clave compartida aunque en el conector se haya guardado con un salto de línea al final', async () => {
    // Así queda al cargarla con `wrangler secret put` por tubería desde PowerShell; la app la limpia al leerla.
    const env = mcpEnv({ LOGIN_LINK_SECRET: `${SECRET}\r\n`, OWNER_EMAILS: `${OWNER}\r\n` });
    const jar = new Jar();
    const clientId = await register(env);
    const consent = await worker.fetch(new Request(await authorizeUrl(clientId, 'z'.repeat(50))), env, ctx);
    jar.take(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const approve = await worker.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
        body: new URLSearchParams({ handle, decision: 'approve' }),
      }),
      env,
      ctx,
    );
    jar.take(approve);
    const state = new URL(approve.headers.get('Location')!).searchParams.get('state')!;
    const firma = await signPayload({ state, email: OWNER, exp: Date.now() + 60_000 }, SECRET);
    const res = await worker.fetch(
      new Request(`${MCP_ORIGIN}/callback?state=${encodeURIComponent(state)}&identidad=${firma}`, { headers: { Cookie: jar.header() } }),
      env,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!).origin).toBe('https://claude.ai');
  });

  it('rechaza un correo firmado con otra clave o para otro state', async () => {
    const env = mcpEnv();
    const jar = new Jar();
    const clientId = await register(env);
    const consent = await worker.fetch(new Request(await authorizeUrl(clientId, 'v'.repeat(50))), env, ctx);
    jar.take(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const approve = await worker.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
        body: new URLSearchParams({ handle, decision: 'approve' }),
      }),
      env,
      ctx,
    );
    jar.take(approve);
    const state = new URL(approve.headers.get('Location')!).searchParams.get('state')!;
    const forged = await signPayload({ state, email: OWNER, exp: Date.now() + 60_000 }, 'y'.repeat(40));
    const res = await worker.fetch(
      new Request(`${MCP_ORIGIN}/callback?state=${encodeURIComponent(state)}&identidad=${forged}`, { headers: { Cookie: jar.header() } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('sin la cookie del navegador que empezó el login, el callback no sirve', async () => {
    const env = mcpEnv();
    const res = await worker.fetch(
      new Request(`${MCP_ORIGIN}/callback?state=robado&identidad=x`),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('cancelar devuelve access_denied a Claude', async () => {
    const env = mcpEnv();
    const jar = new Jar();
    const clientId = await register(env);
    const consent = await worker.fetch(new Request(await authorizeUrl(clientId, 'w'.repeat(50))), env, ctx);
    jar.take(consent);
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1]!;
    const deny = await worker.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
        body: new URLSearchParams({ handle, decision: 'deny' }),
      }),
      env,
      ctx,
    );
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe('conector: reglas', () => {
  it('solo acepta destinos de Claude o apps locales', () => {
    expect(allowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(allowedRedirect('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(allowedRedirect('http://localhost:33418/callback')).toBe(true);
    expect(allowedRedirect('https://evil.example/callback')).toBe(false);
    expect(allowedRedirect('http://claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('la app no firma correos de amigos ni sin configuración', async () => {
    const base = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true' };
    const call = (extra: Record<string, string>) =>
      app.fetch(new Request('http://localhost/conector/identidad?state=abc'), { ...base, ...extra } as unknown as Env, ctx);
    expect((await call({ MCP_URL: MCP_ORIGIN, LOGIN_LINK_SECRET: SECRET, DEV_ROLE: 'friend' })).status).toBe(403);
    expect((await call({ MCP_URL: MCP_ORIGIN })).status).toBe(503);
  });
});
