import { describe, expect, it } from 'vitest';
import { roleFor } from '../src/auth/access';
import type { Env } from '../src/env';
import worker from '../src/index';
import { memoryKV } from './helpers';

describe('roleFor', () => {
  const env = (OWNER_EMAILS?: string) => ({ OWNER_EMAILS }) as Env;

  it('solo los correos de OWNER_EMAILS son dueños (sin importar mayúsculas)', () => {
    expect(roleFor('Yo@Example.com', env('yo@example.com, otro@example.com'))).toBe('owner');
    expect(roleFor('amigo@example.com', env('yo@example.com'))).toBe('friend');
  });

  it('falla cerrado: sin OWNER_EMAILS nadie es dueño', () => {
    expect(roleFor('yo@example.com', env(''))).toBe('friend');
    expect(roleFor('yo@example.com', env())).toBe('friend');
    expect(roleFor(null, env('yo@example.com'))).toBe('friend');
  });
});

describe('rutas según el rol (local, con datos de prueba)', () => {
  const env = (role?: string) =>
    ({
      CACHE: memoryKV().kv,
      ASSETS: { fetch: async () => new Response('asset') },
      TIMEZONE: 'America/Lima',
      DEV_MODE: 'true',
      MOCK_DATA: 'true',
      DEV_ROLE: role,
    }) as unknown as Env;
  const get = (path: string, role?: string) => worker.fetch(new Request(`http://localhost${path}`), env(role), {} as ExecutionContext);

  it('un amigo no puede ver precios, historial ni la lista', async () => {
    for (const path of ['/api/quotes', '/api/history?symbol=BAP', '/api/watchlist']) {
      const res = await get(path, 'friend');
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Twelve Data');
    }
  });

  it('un amigo tampoco puede cambiar la lista', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: ['BAP'] }),
      }),
      env('friend'),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('un amigo sí ve Perú y EE. UU., y su estado no muestra configuración ni créditos', async () => {
    expect((await get('/api/peru', 'friend')).status).toBe(200);
    expect((await get('/api/usa', 'friend')).status).toBe(200);
    const status = (await (await get('/api/status', 'friend')).json()) as Record<string, unknown>;
    expect(status.role).toBe('friend');
    expect(status.config).toBeUndefined();
    expect(status.credits).toBeUndefined();
  });

  it('el dueño ve todo', async () => {
    expect((await get('/api/quotes')).status).toBe(200);
    const status = (await (await get('/api/status')).json()) as Record<string, unknown>;
    expect(status.role).toBe('owner');
    expect(status.config).toBeDefined();
  });
});
