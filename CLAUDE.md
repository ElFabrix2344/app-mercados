# Mercados — notas para Claude

App de mercados (Cloudflare Worker + panel web + conector MCP para Claude). El README explica la arquitectura, la API y el despliegue: léelo antes de cambiar algo.

## Cómo trabajar en este proyecto

- Responde siempre en **español**.
- Trabajo por fases. Al cerrar cada una, resume qué quedó, qué se probó y qué falta.
- Antes de cambios grandes o de diseño, propón **opciones concretas con una recomendación** y espera la elección. Muestra una vista previa antes de publicar cambios visuales.
- Verifica contra documentación oficial y con datos reales: compara precios con Google Finance, el BCRP con su API y FRED con su web.
- **Secretos:** nunca en el repo (es público) ni pegados en prompts ocultos de la terminal, porque en Windows Ctrl+V guarda `\u0016`. Se cargan en el panel de Cloudflare: Workers → mercados → Settings → Variables and Secrets, tipo **Secret**. `/api/status` dice si están bien sin mostrarlos.
- **Windows:** usa `npx.cmd`, no `npx`. Para la vista previa local usa las configuraciones `mercados-dev` / `mercados-mcp-dev` de `.claude/launch.json` (con `MOCK_DATA=true` en `.env`) en vez de lanzar `wrangler dev` a mano: deja procesos `workerd` colgados.

## Comandos

- Pruebas: `npx.cmd vitest run`. Tipos: `npx.cmd tsc --noEmit`.
- Publicar: push a `main` (GitHub Actions corre typecheck, pruebas y deploy). Para publicar a mano: `npx.cmd wrangler deploy`.

## Cosas que ya costaron caro

- La Cache API **no funciona detrás de Access**, así que todo va a KV. El plan gratis permite **1.000 escrituras al día por cuenta**: escribe poco y agrupado.
- Twelve Data, plan gratis: 800 créditos al día y 8 por minuto, **compartidos con el conector oficial de Twelve Data** que se usa en claude.ai. La app se frena en 600. Además, el volumen intradía del plan gratis viene de una sola parte de las bolsas: no lo muestres como volumen real.
- El BCRP pega un aviso HTML de PHP después del JSON. `extractJson` lo resuelve: no vuelvas a `res.json()`.
- FRED marca con `"."` los días sin dato.
- Los feriados y cierres anticipados de la NYSE están cargados hasta 2027 en `lib/market-hours.ts` (`NYSE_CALENDAR_UNTIL`). **Cada año hay que agregar el siguiente** desde nyse.com/markets/hours-calendars; si no, la app gasta créditos en los feriados.
- El historial guarda 5 años (`hist5:<símbolo>` en KV) por 1 crédito; los rangos se recortan de ahí con `sliceRange`, que empieza en el cierre **anterior** al inicio del rango.
- Si cambias la forma de los datos guardados en KV, lee también el formato anterior (ver `readQuotes`).

## Estado y próximos pasos

- **Cuenta propia de Cloudflare** («mercados», `account_id` en `wrangler.jsonc`), con su subdominio y su Zero Trust: la app vive en `https://mercados.mercados.workers.dev`. La cuenta anterior es de otro proyecto del usuario y no se debe tocar. Ahí queda una copia vieja del Worker `mercados` que se borra **solo con confirmación del usuario**.
- **Conector de Claude:** vive en el Worker aparte `mercados-mcp` (`src/mcp-worker.ts`, `wrangler.mcp.jsonc`), con OAuth propio (`@cloudflare/workers-oauth-provider`). Tu correo se confirma en la app, ruta `/conector/identidad`, detrás de Access. Se descartó *Managed OAuth* de Access porque falla en claude.ai web y móvil (anthropics/claude-ai-mcp#410). Por ahora es solo para el dueño. `mercados-mcp` tiene sus propios secretos (`OWNER_EMAILS`, `LOGIN_LINK_SECRET`, que debe ser igual en ambos Workers, `TWELVE_DATA_API_KEY` y `FRED_API_KEY`). Las pruebas del login completo están en `test/mcp-worker.test.ts`; en Node, `cloudflare:workers` se reemplaza con `test/stubs/`.
- **Compartida con amigos, solo con datos públicos.** Los términos de Twelve Data (plan gratis) no permiten mostrar sus datos a terceros ni compartir la clave. Por eso hay dos roles: el **dueño** (`OWNER_EMAILS`) ve todo y los **amigos** ven solo Perú (BCRP) y EE. UU. (FRED). El bloqueo es del servidor: 403 en precios, historial y lista, y el conector sin esas herramientas. Pendiente:
  - revisar los términos de FRED (su web estaba en mantenimiento) y cargar `FRED_API_KEY`;
  - más adelante, que cada amigo use su propia clave gratis de Twelve Data (lista y caché por persona) para que también vea precios.
