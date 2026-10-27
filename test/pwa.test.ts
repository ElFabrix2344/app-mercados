import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// App instalable: manifiesto, íconos y service worker (public/).
const read = (path: string) => readFileSync(new URL(`../public${path}`, import.meta.url));
const text = (path: string) => new TextDecoder().decode(read(path));

/** Lado de un PNG, leído de su cabecera. */
function pngSize(path: string): string {
  const b = read(path);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return `${v.getUint32(16)}x${v.getUint32(20)}`;
}

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

describe('manifiesto', () => {
  const manifest = JSON.parse(text('/manifest.webmanifest')) as { icons: Icon[] } & Record<string, unknown>;

  it('tiene lo que pide Chrome para ofrecer la instalación', () => {
    expect(manifest).toMatchObject({ id: '/', name: 'Rueda', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.prefer_related_applications).toBeUndefined();
    const any = manifest.icons.filter((i) => i.type === 'image/png' && (i.purpose ?? 'any').split(' ').includes('any'));
    expect(any.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('cada PNG existe y mide lo que dice', () => {
    for (const i of manifest.icons.filter((x) => x.type === 'image/png')) expect(pngSize(i.src), i.src).toBe(i.sizes);
  });
});

describe('index.html', () => {
  const html = text('/index.html');

  it('pide el manifiesto con la sesión de Access y tiene el ícono de iPhone', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">');
    const touch = /<link rel="apple-touch-icon" href="([^"]+)">/.exec(html)?.[1];
    expect(touch).toBeDefined();
    expect(pngSize(touch!)).toBe('180x180');
  });
});

describe('service worker', () => {
  type Listener = (event: unknown) => void;

  /** Carga public/sw.js con un `self` falso y devuelve sus manejadores. */
  function load(onLine: boolean): Record<string, Listener> {
    const listeners: Record<string, Listener> = {};
    const self = {
      navigator: { onLine },
      addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    };
    new Function('self', text('/sw.js'))(self);
    return listeners;
  }

  /** Despacha un pedido y devuelve lo que respondió el service worker (null si lo dejó pasar a la red). */
  function dispatch(listeners: Record<string, Listener>, request: { mode: string; method: string }): Response | null {
    let res: Response | null = null;
    listeners.fetch!({ request, respondWith: (r: Response) => (res = r) });
    return res;
  }

  it('sin conexión, una página muestra el aviso en vez del error del navegador', async () => {
    const res = dispatch(load(false), { mode: 'navigate', method: 'GET' });
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toContain('text/html');
    expect(res!.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const body = await res!.text();
    expect(body).toContain('Sin conexión');
    expect(body).toContain('<a href="/">Reintentar</a>');
  });

  it('con conexión no toca nada: el ingreso de Access y la API van directo a la red', () => {
    const online = load(true);
    expect(dispatch(online, { mode: 'navigate', method: 'GET' })).toBeNull();
    expect(dispatch(online, { mode: 'cors', method: 'GET' })).toBeNull();
    const offline = load(false);
    expect(dispatch(offline, { mode: 'cors', method: 'GET' })).toBeNull();
    expect(dispatch(offline, { mode: 'navigate', method: 'POST' })).toBeNull();
  });
});
