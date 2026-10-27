'use strict';
// Service worker de Rueda: hace que la app se pueda instalar y, sin internet, muestra un aviso propio en vez del error
// del navegador. No guarda nada (ni páginas ni datos) y, con conexión, no toca ningún pedido: todo sigue yendo a la red,
// detrás de Cloudflare Access, como si no estuviera (así nunca se mete en el ingreso con el código).
// Para quitarlo de todos los equipos: publica un sw.js que solo llame a self.registration.unregister().

const LOGO =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke="#45C8E6" stroke-width="4" stroke-linecap="round"><circle cx="32" cy="32" r="21"/><path d="M32 11v42M11 32h42M17.2 17.2l29.6 29.6M46.8 17.2 17.2 46.8"/></g><circle cx="32" cy="32" r="6.5" fill="#0A0A0A" stroke="#45C8E6" stroke-width="4"/></svg>';

const OFFLINE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0A0A0A">
<title>Rueda · sin conexión</title>
<style>
html{background:#0A0A0A;color-scheme:dark}
body{margin:0;min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#E8E8E8;text-align:center}
main{max-width:22rem}
svg{width:56px;height:56px}
h1{margin:12px 0 8px;color:#45C8E6;font:600 1.05rem ui-monospace,Menlo,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase}
p{margin:0 0 12px;color:#A3A3A3}
a{color:#45C8E6;text-underline-offset:3px}
</style>
</head>
<body>
<main>${LOGO}<h1>Sin conexión</h1><p>Rueda necesita internet para traer los datos. Cuando vuelva la conexión, toca «Reintentar».</p><p><a href="/">Reintentar</a></p></main>
</body>
</html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo la carga de una página y solo si el equipo dice que no tiene red; todo lo demás sigue de largo.
  if (req.mode !== 'navigate' || req.method !== 'GET' || self.navigator.onLine !== false) return;
  event.respondWith(
    new Response(OFFLINE, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Cache-Control': 'no-store',
      },
    }),
  );
});
