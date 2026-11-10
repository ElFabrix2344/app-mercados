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

  it('tiene las hojas por tema («Hoy», «Acciones», «Mercados» y «Cartera»), cada sección en la suya', () => {
    expect(html).toContain('role="tablist"');
    const sheets = [
      ['hoy', 'sheet-hoy', ['dia', 'milista', 'summary', 'news', 'cal', 'pmk', 'people', 'welcome']],
      ['acciones', 'sheet-acciones', ['keycard', 'watchlist', 'eod', 'detail', 'compare', 'fin', 'ps']],
      ['mercados', 'sheet-mercados', ['thermo', 'cmd', 'cg', 'macro', 'pm']],
      ['cartera', 'sheet-cartera', ['hapi', 'portfolio']],
    ] as const;
    // Después de la última hoja viene el juego, que ya no es una hoja.
    const starts = [...sheets.map(([, panel]) => html.indexOf(`id="${panel}"`)), html.indexOf('id="game"')];
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    sheets.forEach(([tab, panel, ids], i) => {
      expect(html).toMatch(new RegExp(`id="tab-${tab}"[^>]*aria-controls="${panel}"`));
      expect(html).toMatch(new RegExp(`id="${panel}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${tab}"`));
      for (const id of ids) {
        const at = html.indexOf(`id="${id}"`);
        expect(at, id).toBeGreaterThan(starts[i]!);
        expect(at, id).toBeLessThan(starts[i + 1]!);
      }
    });
  });

  it('la ficha de una acción: resultados y calidad en «Negocio»; múltiplos, P/S y DCF en «Valor»; los reportes de la SEC, en «Empresa»', () => {
    const [negocio, valor, empresa, noticias] = ['dp-negocio', 'dp-valor', 'dp-empresa', 'dp-noticias'].map((id) => html.indexOf(`id="${id}"`)) as [number, number, number, number];
    for (const id of ['d-fin', 'd-qual']) expect(html.slice(negocio, valor), id).toContain(`id="${id}"`);
    for (const id of ['d-mult', 'd-ps', 'd-val']) expect(html.slice(valor, empresa), id).toContain(`id="${id}"`);
    for (const id of ['d-co', 'd-filings', 'd-smv']) expect(html.slice(empresa, noticias), id).toContain(`id="${id}"`);
    // Cada pestaña de la ficha tiene su panel.
    for (const t of ['resumen', 'negocio', 'valor', 'empresa', 'noticias']) expect(html, t).toMatch(new RegExp(`id="dt-${t}"[^>]*aria-controls="dp-${t}"`));
    // Las cuentas de valoración son un módulo aparte, servido tal cual (el panel lo importa al empezar).
    expect(text('/valuation-core.js')).toContain('export function multiplesHistory');
    expect(text('/app.js')).toContain("import('/valuation-core.js')");
    // Lo mismo, sin precios, para quien no tiene clave: en «Resultados de empresas».
    const fin = html.indexOf('id="fin"');
    for (const id of ['fin-qual', 'fin-filings']) expect(html.indexOf(`id="${id}"`), id).toBeGreaterThan(fin);
  });

  it('el juego del grupo quedó aparte (9 nov): sin pestaña, se entra por el pie, y nada se borró', () => {
    expect(html).not.toContain('id="tab-juego"');
    expect(html).not.toContain('id="lg-teaser"');
    expect(html).toMatch(/<footer class="foot">[\s\S]*<a href="#juego">Juego del grupo<\/a>/);
    expect(html).toMatch(/id="game"[^>]*role="region"[^>]*aria-labelledby="game-h"/);
    const at = html.indexOf('id="game"');
    for (const id of ['game-back', 'league', 'chart-day', 'k23', 'forecasts', 'fc-rank', 'fc-history']) expect(html.indexOf(`id="${id}"`), id).toBeGreaterThan(at);
  });

  it('la liga de acciones es lo primero del juego, con su tutorial aparte; el mercado de predicciones ya no está', () => {
    const game = html.indexOf('id="game"');
    const league = html.indexOf('id="league"');
    expect(league).toBeGreaterThan(game);
    expect(html.slice(game, html.lastIndexOf('<section', league))).not.toContain('<section');
    expect(html).toMatch(/<dialog class="tutorial" id="lg-tutorial"/);
    expect(html).not.toContain('id="predict"');
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
