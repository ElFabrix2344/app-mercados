import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyAccess } from '../src/auth/access';
import type { Env } from '../src/env';
import worker from '../src/index';
import { pickPolicy, syncAccessEmails, type Policy } from '../src/lib/access-api';
import { addPerson, canEnter, normalizeEmail, peopleView, removePerson, syncPeople, PEOPLE_KEY } from '../src/services/people';
import { memoryKV } from './helpers';

const AUD = 'a'.repeat(64);
const ACCOUNT = '44ad19052da3858dae65640ed99fcae6';
const now = new Date('2026-10-29T15:00:00Z');

/** API de Cloudflare de mentira: una app con sus políticas; registra cada pedido (método, ruta y cuerpo). */
function fakeCloudflare(policies: Policy[], opts: { status?: number; appScopedOnly?: boolean } = {}) {
  const calls: { method: string; path: string; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace('/client/v4', '');
    calls.push({ method, path, body });
    const reply = (status: number, result: unknown, errors: { message: string }[] = []) =>
      new Response(JSON.stringify({ success: status < 400, result, errors }), { status });
    if (opts.status) return reply(opts.status, null, [{ message: 'Authentication error' }]);
    if (path === `/accounts/${ACCOUNT}/access/apps`) return reply(200, [{ id: 'otra', aud: 'b'.repeat(64) }, { id: 'app1', aud: AUD }]);
    if (path === `/accounts/${ACCOUNT}/access/apps/app1/policies` && method === 'GET') return reply(200, policies);
    if (method === 'PUT' && path.startsWith(`/accounts/${ACCOUNT}/access/policies/`)) {
      return opts.appScopedOnly ? reply(404, null, [{ message: 'policy not found' }]) : reply(200, body);
    }
    if (method === 'PUT' && path.startsWith(`/accounts/${ACCOUNT}/access/apps/app1/policies/`)) return reply(200, body);
    return reply(404, null, [{ message: 'not found' }]);
  }) as typeof fetch;
  return { f, calls };
}

const members = { 'login_method': { id: 'otp' } };
const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 'pol1',
  name: 'mercados - Production',
  decision: 'allow',
  precedence: 1,
  include: [members, { email: { email: 'Yo@Example.com' } }, { email: { email: 'vieja@example.com' } }],
  exclude: [],
  require: [],
  session_duration: '730h',
  created_at: '2026-10-22T00:00:00Z',
  ...over,
});

const envWith = (extra: Partial<Env> = {}) =>
  ({ CACHE: memoryKV().kv, OWNER_EMAILS: 'yo@example.com', ACCESS_AUD: AUD, CF_ACCOUNT_ID: ACCOUNT, ...extra }) as unknown as Env;

describe('correos', () => {
  it('acepta correos comunes en minúsculas y rechaza lo demás', () => {
    expect(normalizeEmail('  Ana.Perez+rueda@Gmail.com ')).toBe('ana.perez+rueda@gmail.com');
    for (const bad of ['', 'ana', 'ana@', '@gmail.com', 'ana@gmail', 'ana gomez@gmail.com', 'a,b@gmail.com', 7, null]) {
      expect(() => normalizeEmail(bad)).toThrow(/correo válido/);
    }
  });
});

describe('quién entra', () => {
  it('sin lista en Rueda se usa ALLOWED_EMAILS; con lista, solo la lista; los dueños siempre', async () => {
    const env = envWith({ ALLOWED_EMAILS: 'yo@example.com, ana@example.com' });
    expect(await canEnter(env, 'ana@example.com')).toBe(true);
    expect(await canEnter(env, 'beto@example.com')).toBe(false);

    await addPerson(env, { email: 'beto@example.com' }, now);
    expect(await canEnter(env, 'beto@example.com')).toBe(true);
    // Ana venía del secreto: el primer cambio la pasó a la lista de Rueda.
    expect(await canEnter(env, 'ana@example.com')).toBe(true);
    await removePerson(env, { email: 'ana@example.com' }, now);
    expect(await canEnter(env, 'ana@example.com')).toBe(false); // aunque siga en ALLOWED_EMAILS
    expect(await canEnter(env, 'yo@example.com')).toBe(true);
  });

  it('si KV falla, solo entran los dueños', async () => {
    const kv = { get: async () => Promise.reject(new Error('KV caído')) } as unknown as KVNamespace;
    const env = envWith({ CACHE: kv, ALLOWED_EMAILS: 'ana@example.com' });
    expect(await canEnter(env, 'ana@example.com')).toBe(false);
    expect(await canEnter(env, 'yo@example.com')).toBe(true);
  });

  it('Access: entra quien está en la lista de Rueda, aunque no esté en ALLOWED_EMAILS', async () => {
    const team = 'https://x.cloudflareaccess.com';
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
    const req = async (email: string) =>
      new Request('https://m.example/', {
        headers: {
          'Cf-Access-Jwt-Assertion': await new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(team).setAudience(AUD).setExpirationTime('10m').sign(privateKey),
        },
      });
    const { kv } = memoryKV({ [PEOPLE_KEY]: { people: [{ email: 'caro@example.com', addedAt: null }], sync: null } });
    const env = { ...envWith({ CACHE: kv }), ACCESS_TEAM_DOMAIN: team } as Env;
    expect(await verifyAccess(await req('caro@example.com'), env, keys)).toEqual({ ok: true, email: 'caro@example.com' });
    expect(await verifyAccess(await req('yo@example.com'), env, keys)).toEqual({ ok: true, email: 'yo@example.com' });
    expect(await verifyAccess(await req('ana@example.com'), env, keys)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('la lista en Rueda', () => {
  it('sin token: se guarda en Rueda y avisa que falta agregarlo en Access', async () => {
    const env = envWith({ ALLOWED_EMAILS: 'Yo@Example.com, ana@example.com' });
    const before = await peopleView(env);
    expect(before).toMatchObject({ fromSecret: true, people: [{ email: 'ana@example.com', addedAt: null }], sync: null });
    expect(before.access).toEqual({ connected: false, url: `https://dash.cloudflare.com/${ACCOUNT}/one/access/apps` });

    const after = await addPerson(env, { email: 'Beto@Example.com' }, now);
    expect(after.fromSecret).toBe(false);
    expect(after.people).toEqual([
      { email: 'ana@example.com', addedAt: null },
      { email: 'beto@example.com', addedAt: now.toISOString() },
    ]);
    expect(after.sync).toBeNull();

    await expect(addPerson(env, { email: 'beto@example.com' }, now)).rejects.toThrow(/ya está/);
    await expect(addPerson(env, { email: 'yo@example.com' }, now)).rejects.toThrow(/dueño/);
    await expect(removePerson(env, { email: 'nadie@example.com' }, now)).rejects.toThrow(/no está/);
  });

  it('con token: deja en la política exactamente los correos (con el dueño) y no toca las otras reglas', async () => {
    const cf = fakeCloudflare([policy()]);
    const env = envWith({ ACCESS_API_TOKEN: 't'.repeat(40) });
    const v = await addPerson(env, { email: 'ana@example.com' }, now, cf.f);
    expect(v.sync).toMatchObject({ ok: true, policy: 'mercados - Production', added: ['ana@example.com'], removed: ['vieja@example.com'] });

    const put = cf.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(`/accounts/${ACCOUNT}/access/policies/pol1`);
    expect(put.body.include).toEqual([members, { email: { email: 'yo@example.com' } }, { email: { email: 'ana@example.com' } }]);
    // Lo demás de la política vuelve igual; lo que pone Cloudflare (fechas) no se manda.
    expect(put.body).toMatchObject({ name: 'mercados - Production', decision: 'allow', session_duration: '730h', exclude: [], require: [] });
    expect(put.body.created_at).toBeUndefined();
    expect(cf.calls[0]!.path).toBe(`/accounts/${ACCOUNT}/access/apps`);
  });

  it('si Access ya está al día no reescribe nada', async () => {
    const cf = fakeCloudflare([policy({ include: [{ email: { email: 'yo@example.com' } }, { email: { email: 'ana@example.com' } }] })]);
    const env = envWith({ ACCESS_API_TOKEN: 't'.repeat(40), ALLOWED_EMAILS: 'ana@example.com' });
    const v = await syncPeople(env, now, cf.f);
    expect(v.sync).toMatchObject({ ok: true, added: [], removed: [] });
    expect(cf.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(v.fromSecret).toBe(false); // la primera copia también pasa la lista a Rueda
  });

  it('una política solo de la app se reescribe por su propia ruta, con su orden', async () => {
    const cf = fakeCloudflare([policy()], { appScopedOnly: true });
    const v = await addPerson(envWith({ ACCESS_API_TOKEN: 't'.repeat(40) }), { email: 'ana@example.com' }, now, cf.f);
    expect(v.sync?.ok).toBe(true);
    const put = cf.calls.filter((c) => c.method === 'PUT').at(-1)!;
    expect(put.path).toBe(`/accounts/${ACCOUNT}/access/apps/app1/policies/pol1`);
    expect(put.body.precedence).toBe(1);
  });

  it('si Cloudflare rechaza el token, el cambio queda en Rueda y se explica qué permiso falta', async () => {
    const env = envWith({ ACCESS_API_TOKEN: 't'.repeat(40) });
    const v = await addPerson(env, { email: 'ana@example.com' }, now, fakeCloudflare([], { status: 403 }).f);
    expect(v.sync).toMatchObject({ ok: false, message: expect.stringContaining('Access: Apps and Policies') });
    expect(await canEnter(env, 'ana@example.com')).toBe(true);
  });

  it('nunca deja la política sin correos', async () => {
    await expect(syncAccessEmails({ token: 't', accountId: ACCOUNT, aud: AUD, emails: [], fetch: fakeCloudflare([policy()]).f })).rejects.toThrow(/No hay correos/);
  });
});

describe('qué política maneja Rueda', () => {
  const allow = (id: string, name: string, emails: string[]) =>
    ({ id, name, decision: 'allow', include: emails.length ? emails.map((email) => ({ email: { email } })) : [members] }) as Policy;

  it('la que se llama «Personas de Rueda»; si no, la única con correos; si no, la única que deja entrar', () => {
    expect(pickPolicy([allow('a', 'Amigos', ['x@y.com']), allow('b', ' personas de rueda ', [])]).id).toBe('b');
    expect(pickPolicy([allow('a', 'Miembros', []), allow('b', 'Amigos', ['x@y.com'])]).id).toBe('b');
    expect(pickPolicy([allow('a', 'Miembros', []), { id: 'n', name: 'Bloqueo', decision: 'deny', include: [] }]).id).toBe('a');
  });

  it('si no está claro, pide ponerle el nombre en vez de adivinar', () => {
    expect(() => pickPolicy([allow('a', 'Uno', ['x@y.com']), allow('b', 'Dos', ['z@y.com'])])).toThrow(/Personas de Rueda/);
    expect(() => pickPolicy([{ id: 'n', name: 'Bloqueo', decision: 'deny', include: [] }])).toThrow(/ninguna política/);
  });
});

describe('rutas de personas', () => {
  const local = (role?: string) =>
    ({
      CACHE: memoryKV().kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      DEV_ROLE: role,
      ALLOWED_EMAILS: 'ana@example.com',
    }) as unknown as Env;
  const call = (env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
    worker.fetch(new Request(`http://localhost${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, {} as ExecutionContext);

  it('el dueño ve, agrega y quita; el correo va en el cuerpo, no en la URL', async () => {
    const env = local();
    expect(((await (await call(env, 'GET', '/api/people')).json()) as any).people).toEqual([{ email: 'ana@example.com', addedAt: null }]);
    const added = (await (await call(env, 'POST', '/api/people', { email: 'beto@example.com' })).json()) as any;
    expect(added.people.map((p: { email: string }) => p.email)).toEqual(['ana@example.com', 'beto@example.com']);
    const removed = (await (await call(env, 'DELETE', '/api/people', { email: 'ana@example.com' })).json()) as any;
    expect(removed.people.map((p: { email: string }) => p.email)).toEqual(['beto@example.com']);
    expect((await call(env, 'POST', '/api/people', { email: 'no-es-correo' })).status).toBe(400);
    expect((await call(env, 'POST', '/api/people', { email: 'caro@example.com' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await call(env, 'POST', '/api/people', { email: 'caro@example.com' }, { 'Content-Type': 'application/json', Origin: 'https://otro.example' })).status).toBe(403);
  });

  it('un amigo no ve ni cambia la lista', async () => {
    const env = local('friend');
    for (const [method, path] of [['GET', '/api/people'], ['POST', '/api/people'], ['DELETE', '/api/people'], ['POST', '/api/people/sync']] as const) {
      const res = await call(env, method, path, method === 'GET' ? undefined : { email: 'zoe@example.com' });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Solo el dueño');
    }
  });
});
