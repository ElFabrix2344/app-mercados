# Mercados

Panel personal y privado de mercados: precios de **Twelve Data**, datos de Perú del **BCRP** y de EE. UU. de **FRED**, en un **Cloudflare Worker** protegido con **Cloudflare Access**. Diseño «Terminal» (solo modo oscuro).

```
Navegador ─────────► Cloudflare Access (login con tu correo) ──► Worker ──► Twelve Data / BCRP / FRED
Claude (conector) ─► Access con Managed OAuth (token de Claude) ──┘   └──► KV (caché y freno de créditos)
```

## Cómo funciona

- **Worker en TypeScript** que sirve el frontend estático (JS sin framework, en `public/`) y una API pequeña. Valida el JWT de Access en cada petición; si falta configuración no sirve nada (falla cerrado), también si `ALLOWED_EMAILS` está vacío.
- **Fuentes**
  - Twelve Data: `/quote` y `/time_series` (1 crédito por símbolo; plan gratis: 800/día y 8/min).
  - BCRP (BCRPData, sin clave): `PD04637PD`/`PD04638PD` (dólar interbancario compra/venta), `PD12301MD` (tasa de referencia), `PN01273PM` (inflación de Lima a 12 meses).
  - FRED: `DGS10` (bono del Tesoro a 10 años), `DFF` (tasa de la Fed), `CPIAUCSL` con `units=pc1` (inflación anual).
- **Caché en KV.** La Cache API no funciona en Workers detrás de Access, así que todo se guarda en KV (plan gratis: 1.000 escrituras/día).
  - Precios: el panel pide cada 10 min y cada símbolo se renueva por separado. Acciones y ETF solo con la bolsa de Nueva York abierta (lunes a viernes, 9:30–16:00 hora de NY; no contempla feriados) y una vez más tras el cierre. Divisas y cripto, siempre. «Actualizar» renueva si el dato tiene más de 30 s.
  - Historial de 1 año: cada 12 h. BCRP y FRED: cada 6 h.
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
| GET | `/api/history?symbol=BAP` 🔒 | Cierres diarios del último año y estadísticas |
| GET | `/api/peru` | Dólar interbancario, tasa de referencia e inflación (BCRP) |
| GET | `/api/usa` | Bono a 10 años, tasa de la Fed e inflación (FRED) |
| POST | `/mcp` | Conector de Claude (MCP), ver abajo |

## Conector de Claude (MCP)

`/mcp` es un servidor MCP remoto (Streamable HTTP, sin estado; SDK `@modelcontextprotocol/server`) para usar Mercados desde cualquier chat de claude.ai. Herramientas, todas de solo lectura:

| Herramienta | Qué devuelve |
|---|---|
| `precios` | Precios de la lista de seguimiento (todos o los símbolos pedidos) |
| `historial` | Cierres del último año de un símbolo de la lista y sus estadísticas |
| `peru_bcrp` | Dólar interbancario, tasa de referencia e inflación de Lima (BCRP) |
| `eeuu_fred` | Bono del Tesoro a 10 años, tasa de la Fed e inflación (FRED) |

- **Mismos datos y reglas que el panel:** lee la misma caché de KV, renueva solo lo vencido con las mismas reglas (acciones solo con la bolsa abierta) y cuenta para el mismo freno de 600 créditos. Solo responde por los símbolos de la lista; para otros, Claude debe usar el conector oficial de Twelve Data.
- **Autenticación:** la hace Cloudflare Access con **Managed OAuth** (beta abierta). Access registra a Claude, te pide el mismo login del panel y le da a Claude un token. Con ese token, Access deja pasar la petición con su JWT y el Worker lo valida igual que en el panel (firma, AUD y `ALLOWED_EMAILS`). Sin JWT válido, `/mcp` no entrega nada.
- **Configuración en Access** (Zero Trust → Access controls → Applications → app de `mercados…workers.dev` → Edit → Advanced settings): **Managed OAuth** activado; **Allowed redirect URIs** `https://claude.ai/api/mcp/auth_callback` y `https://claude.com/api/mcp/auth_callback`; localhost y loopback apagados; token de 15 min y sesión de 2 semanas.
- **Agregarlo en Claude:** claude.ai → Customize → Connectors → **+ Add** → **Add custom connector**. URL: `https://mercados.mercados.workers.dev/mcp`. En el plan gratis de Claude solo se permite un conector personalizado.
- **Probarlo en local:** con `npm run dev`, `POST http://localhost:8788/mcp` responde con datos ficticios y sin Access.

## Estructura

```
src/
  index.ts              router, validación de Access, cabeceras de seguridad
  mcp.ts                conector de Claude: servidor MCP y sus 4 herramientas
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

Cada push a `main` ejecuta GitHub Actions: typecheck, pruebas y `wrangler deploy`. Los pull requests solo ejecutan las pruebas.

- **Secretos del repo** (GitHub → Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (plantilla «Edit Cloudflare Workers») y `CLOUDFLARE_ACCOUNT_ID`.
- **Secretos del Worker** (panel de Cloudflare → Workers → mercados → Settings → Variables and Secrets, tipo **Secret**): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, `OWNER_EMAILS`, `TWELVE_DATA_API_KEY`, `FRED_API_KEY`. El despliegue los conserva. Para comprobarlos: `/api/status` → `config`.

## Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| «Acceso restringido» / 503 | Falta `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` o `ALLOWED_EMAILS` | Cárgalos en el panel de Cloudflare |
| Un secreto con `formatOk: false` | Pegado con Ctrl+V en un prompt oculto de la terminal (guarda `\u0016`) | Cárgalo desde el panel de Cloudflare |
| Precios «Guardado hace…» | Se alcanzó el freno de créditos o Twelve Data no respondió | Esperar al día siguiente (UTC) o revisar `/api/status` |
| Gasto de créditos en feriados de EE. UU. | El horario no contempla feriados | Aceptado: son pocos créditos |
| Claude no logra conectar el conector | Falta Managed OAuth o la URL de regreso de Claude en la app de Access | Revisa la configuración de Access de la sección del conector |
| El freno cuenta unos créditos de menos | El panel (desde Lima) y Claude (desde EE. UU.) escriben el contador en KV, que tarda hasta 60 s en propagarse | Aceptado: el margen de 200 créditos lo cubre |
