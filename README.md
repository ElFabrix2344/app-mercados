# Mercados

Panel personal y privado de mercados: precios de **Twelve Data**, datos de Perú del **BCRP** y de EE. UU. de **FRED**, en un **Cloudflare Worker** protegido con **Cloudflare Access**. Diseño «Terminal» (solo modo oscuro).

```
Navegador ──► Cloudflare Access (login con tu correo) ──► Worker ──► Twelve Data / BCRP / FRED
                                                            └──► KV (caché y freno de créditos)
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

## API

Todas las rutas exigen sesión de Cloudflare Access.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/status` | Si cada secreto está cargado y con formato correcto (sin mostrar valores) y créditos usados hoy |
| GET / PUT | `/api/watchlist` | Lee o guarda la lista (`{"symbols": ["BAP", "USD/PEN"]}`) |
| GET | `/api/quotes` | Precios de la lista (`?refresh=1` = botón «Actualizar») y estado de la bolsa |
| GET | `/api/history?symbol=BAP` | Cierres diarios del último año y estadísticas |
| GET | `/api/peru` | Dólar interbancario, tasa de referencia e inflación (BCRP) |
| GET | `/api/usa` | Bono a 10 años, tasa de la Fed e inflación (FRED) |

## Estructura

```
src/
  index.ts              router, validación de Access, cabeceras de seguridad
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
- **Secretos del Worker** (panel de Cloudflare → Workers → mercados → Settings → Variables and Secrets, tipo **Secret**): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, `TWELVE_DATA_API_KEY`, `FRED_API_KEY`. El despliegue los conserva. Para comprobarlos: `/api/status` → `config`.

## Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| «Acceso restringido» / 503 | Falta `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` o `ALLOWED_EMAILS` | Cárgalos en el panel de Cloudflare |
| Un secreto con `formatOk: false` | Pegado con Ctrl+V en un prompt oculto de la terminal (guarda `\u0016`) | Cárgalo desde el panel de Cloudflare |
| Precios «Guardado hace…» | Se alcanzó el freno de créditos o Twelve Data no respondió | Esperar al día siguiente (UTC) o revisar `/api/status` |
| Gasto de créditos en feriados de EE. UU. | El horario no contempla feriados | Aceptado: son pocos créditos |
