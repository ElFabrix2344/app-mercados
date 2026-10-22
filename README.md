# Mercados

Panel personal y privado de mercados: precios de **Twelve Data**, datos de Perú del **BCRP** y de EE. UU. de **FRED**, en un **Cloudflare Worker** protegido con **Cloudflare Access**. Diseño «Terminal» (solo modo oscuro).

```
Navegador ─► Cloudflare Access (login con tu correo) ─► Worker «mercados» ─► Twelve Data / BCRP / FRED
                                                            │  ▲                     │
Claude ─► Worker «mercados-mcp» (OAuth propio) ─────────────┘  └─ /conector/identidad └─► KV (caché y freno, compartida)
```

## Cómo funciona

- **Worker en TypeScript** que sirve el frontend estático (JS sin framework, en `public/`) y una API pequeña. Valida el JWT de Access en cada petición; si falta configuración no sirve nada (falla cerrado), también si `ALLOWED_EMAILS` está vacío.
- **Fuentes**
  - Twelve Data: `/quote` y `/time_series` (1 crédito por símbolo; plan gratis: 800/día y 8/min).
  - BCRP (BCRPData, sin clave): `PD04637PD`/`PD04638PD` (dólar interbancario compra/venta), `PD12301MD` (tasa de referencia), `PN01273PM` (inflación de Lima a 12 meses).
  - FRED: `DGS10` (bono del Tesoro a 10 años), `DFF` (tasa de la Fed), `CPIAUCSL` con `units=pc1` (inflación anual).
- **Caché en KV.** La Cache API no funciona en Workers detrás de Access, así que todo se guarda en KV (plan gratis: 1.000 escrituras/día).
  - Precios: el panel pide cada 10 min y cada símbolo se renueva por separado. Acciones y ETF solo con la bolsa de Nueva York abierta (lunes a viernes, 9:30–16:00 hora de NY, sin los feriados ni los cierres a la 1:00 p. m. del calendario oficial de la NYSE, cargado hasta 2027 en `lib/market-hours.ts`) y una vez más tras el cierre. Divisas y cripto, siempre. «Actualizar» renueva si el dato tiene más de 30 s.
  - Historial de **5 años** por símbolo, cada 12 h: Twelve Data cobra 1 crédito por consulta sin importar cuántos días traiga. Los rangos 1M, 3M, 6M, YTD, 1A, 3A y 5A se recortan de esa misma caché y miden el rendimiento desde el cierre anterior al inicio (YTD, desde el 31 de diciembre). BCRP y FRED: cada 6 h.
- **Exportar a Excel:** los botones «CSV» arman el archivo en el navegador (comas, punto decimal y BOM UTF-8, como lo lee Excel con la configuración es-PE). Son los cierres y rendimientos diarios del rango, en la ficha, y las series de Perú y EE. UU., que también ven los amigos.
  - **Freno:** la app gasta como máximo 600 créditos de Twelve Data al día; el resto queda para el conector de Claude. Pasado el freno se muestran los últimos precios guardados.
- **Lista de seguimiento:** hasta 8 símbolos (8 créditos por minuto del plan gratis).

## Quién ve qué

| Rol | Quién | Qué ve |
|---|---|---|
| Dueño | Los correos de `OWNER_EMAILS` | Todo: precios, historial y lista (Twelve Data), Perú y EE. UU. |
| Amigo | El resto de `ALLOWED_EMAILS` (y de la política de Access) | Solo datos públicos: Perú (BCRP) y EE. UU. (FRED) |

La licencia gratis de Twelve Data no permite mostrar sus datos a otras personas ni compartir la clave (§2.2 y §2.3 de sus [términos](https://twelvedata.com/terms)). Por eso el servidor responde **403** a los amigos en `/api/quotes`, `/api/history` y `/api/watchlist`, y el conector solo les ofrece `peru_bcrp` y `eeuu_fred`; no es solo un ocultamiento en pantalla. Si `OWNER_EMAILS` está vacío, nadie ve los precios (falla cerrado).

**Agregar un amigo:** su correo va en la política de Access de la app (regla *Allow* → *Emails*) **y** en `ALLOWED_EMAILS`. Al editar ese secreto hay que volver a escribir toda la lista, incluido tu correo: el panel no muestra el valor anterior.

## API

Todas las rutas exigen sesión de Cloudflare Access. Las marcadas con 🔒 son solo para el dueño.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/status` | Tu rol. Al dueño además: si cada secreto está cargado y con formato correcto (sin mostrar valores) y créditos usados hoy |
| GET / PUT | `/api/watchlist` 🔒 | Lee o guarda la lista (`{"symbols": ["BAP", "USD/PEN"]}`) |
| GET | `/api/quotes` 🔒 | Precios de la lista (`?refresh=1` = botón «Actualizar») y estado de la bolsa |
| GET | `/api/history?symbol=BAP&range=1A` 🔒 | Cierres diarios del rango (1M, 3M, 6M, YTD, 1A, 3A, 5A) y sus estadísticas |
| GET | `/api/peru` | Dólar interbancario, tasa de referencia e inflación (BCRP) |
| GET | `/api/usa` | Bono a 10 años, tasa de la Fed e inflación (FRED) |
| GET | `/conector/identidad?state=…` 🔒 | Paso del login del conector: firma tu correo y vuelve a `mercados-mcp` |

## Conector de Claude (MCP)

Vive en un **Worker aparte, `mercados-mcp`** (`src/mcp-worker.ts`, `wrangler.mcp.jsonc`), en `https://mercados-mcp.mercados.workers.dev/mcp`: un servidor MCP remoto (Streamable HTTP, sin estado; SDK `@modelcontextprotocol/server`) para usar Mercados desde claude.ai, el celular o Claude Code. Herramientas, todas de solo lectura:

| Herramienta | Qué devuelve |
|---|---|
| `precios` | Precios de la lista de seguimiento (todos o los símbolos pedidos) |
| `historial` | Cierres de un símbolo de la lista en el rango pedido (hasta 5 años) y sus estadísticas |
| `peru_bcrp` | Dólar interbancario, tasa de referencia e inflación de Lima (BCRP) |
| `eeuu_fred` | Bono del Tesoro a 10 años, tasa de la Fed e inflación (FRED) |

- **Mismos datos y reglas que el panel:** lee la misma caché de KV, renueva solo lo vencido con las mismas reglas (acciones solo con la bolsa abierta) y cuenta para el mismo freno de 600 créditos. Solo responde por los símbolos de la lista; para otros, Claude debe usar el conector oficial de Twelve Data.
- **Por qué un Worker aparte:** Access no deja pasar a los servidores de Claude, y su login para conectores (*Managed OAuth*) falla en claude.ai web y móvil ([anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410)). `mercados-mcp` no está detrás de Access: es su propio servidor OAuth 2.1, con la librería oficial `@cloudflare/workers-oauth-provider` (DCR, CIMD, PKCE, tokens guardados como hash en la KV `OAUTH_KV`).
- **Login:** Claude abre `/authorize` → página de permiso (cliente y destino a la vista; solo destinos `claude.ai`/`claude.com` o apps locales) → **Permitir** lleva a la app, `/conector/identidad`, donde Access confirma tu correo → la app lo firma (HMAC con `LOGIN_LINK_SECRET`, 2 min) y vuelve a `/callback` → código → `/token`. El `state` queda atado al navegador que empezó (cookie `__Host-`), así que un enlace robado no sirve en otro.
- **Quién puede:** por ahora solo el dueño (`OWNER_EMAILS`), en el login y en **cada** pedido a `/mcp`: si sacas un correo de la lista, su token deja de servir.
- **Agregarlo en Claude:** claude.ai → Customize → Connectors → **+ Add** → **Add custom connector** → URL `https://mercados-mcp.mercados.workers.dev/mcp`. En el plan gratis de Claude solo se permite un conector personalizado.
- **Secretos de `mercados-mcp`:** `OWNER_EMAILS`, `LOGIN_LINK_SECRET` (**el mismo** que en la app), `TWELVE_DATA_API_KEY` y `FRED_API_KEY`. Si cambias una clave en la app, cámbiala también aquí.

## Estructura

```
src/
  index.ts              app: router, validación de Access, cabeceras de seguridad
  mcp-worker.ts         Worker del conector: OAuth propio (permiso, login, tokens) y /mcp
  mcp.ts                servidor MCP y sus 4 herramientas (lo usa mcp-worker.ts)
  lib/signed.ts         mensajes firmados (HMAC) entre la app y el conector
  auth/access.ts        verificación del JWT de Cloudflare Access (jose)
  services/market.ts    caché en KV, freno de créditos y qué símbolos renovar
  lib/twelvedata.ts     cliente de Twelve Data
  lib/bcrp.ts           cliente del BCRP (tolera el aviso HTML que agrega tras el JSON)
  lib/fred.ts           cliente de FRED
  lib/market-hours.ts   horario de la bolsa de Nueva York
  lib/stats.ts          rendimiento, volatilidad, mayor caída, peor/mejor día
  mock.ts               datos ficticios para desarrollo local
public/                 index.html, app.js (gráficos en SVG propios), styles.css
test/                   pruebas con vitest
```

## Desarrollo local

```bash
npm install
cp .env.example .env    # DEV_MODE=true y MOCK_DATA=true: datos ficticios, sin Access
npm run dev
```

Con `DEV_MODE=true` la validación de Access se salta **solo** si la petición llega a `localhost`/`127.0.0.1`. Pruebas: `npm test` y `npm run typecheck`.

## Despliegue

Cada push a `main` ejecuta GitHub Actions: typecheck, pruebas y `wrangler deploy` de los **dos** Workers (`mercados` y `mercados-mcp`). Los pull requests solo ejecutan las pruebas.

- **Secretos del repo** (GitHub → Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (plantilla «Edit Cloudflare Workers») y `CLOUDFLARE_ACCOUNT_ID`.
- **Secretos de `mercados`** (panel de Cloudflare → Workers → mercados → Settings → Variables and Secrets, tipo **Secret**): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, `OWNER_EMAILS`, `TWELVE_DATA_API_KEY`, `FRED_API_KEY`, `LOGIN_LINK_SECRET`. El despliegue los conserva. Para comprobarlos: `/api/status` → `config`.
- **Secretos de `mercados-mcp`:** ver la sección del conector.

## Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| «Acceso restringido» / 503 | Falta `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` o `ALLOWED_EMAILS` | Cárgalos en el panel de Cloudflare |
| Un secreto con `formatOk: false` | Pegado con Ctrl+V en un prompt oculto de la terminal (guarda `\u0016`) | Cárgalo desde el panel de Cloudflare |
| Precios «Guardado hace…» | Se alcanzó el freno de créditos o Twelve Data no respondió | Esperar al día siguiente (UTC) o revisar `/api/status` |
| Desde 2028, gasto de créditos en feriados de EE. UU. | El calendario de la NYSE está cargado hasta `NYSE_CALENDAR_UNTIL` (2027; `/api/status` → `marketCalendarUntil`) | Agregar el año nuevo en `lib/market-hours.ts`, desde nyse.com/markets/hours-calendars |
| Claude no logra conectar el conector | `LOGIN_LINK_SECRET` distinto en los dos Workers, o tu correo no está en `OWNER_EMAILS` de `mercados-mcp` | Vuelve a cargar el secreto igual en ambos; revisa `OWNER_EMAILS` |
| El conector responde «Falta TWELVE_DATA_API_KEY» | `mercados-mcp` tiene sus propios secretos | Carga la clave también en `mercados-mcp` |
| El freno cuenta unos créditos de menos | El panel (desde Lima) y Claude (desde EE. UU.) escriben el contador en KV, que tarda hasta 60 s en propagarse | Aceptado: el margen de 200 créditos lo cubre |
