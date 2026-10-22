# Rueda (antes «Mercados») — notas para Claude

El nombre visible es **Rueda**. Los nombres técnicos (Workers, direcciones, KV, scope OAuth `mercados`, claves `mercados.*` de localStorage) siguen como «mercados» a propósito: no los cambies.

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
- La API del BCRP devuelve las series **ordenadas por código**, no en el orden pedido. `getBcrp` las pide ordenadas y las reacomoda; no mezcles prefijos (PD/PN) en un mismo pedido.
- Noticias: algunos RSS (Gestión, Bloomberg Línea) traen la nota completa y pesan ~1 MB. `fetchRss` lee el stream y corta apenas tiene los titulares; no lo cambies por `res.text()`, porque el plan gratis da 10 ms de procesador por pedido. Nunca guardes ni muestres el texto completo de las notas.
- Tipografía: números, títulos y datos en IBM Plex Mono; frases, etiquetas y ayudas en IBM Plex Sans (`--f-sans`). Nada por debajo de 12 px. Las explicaciones de uso van en el «?» de cada sección, no como texto suelto.
- El calendario económico (`lib/calendar.ts`) se carga a mano, como los feriados de la NYSE: cada fecha se verifica en su fuente oficial. Sin fechas, el panel oculta la sección y el conector no ofrece `calendario`.
- FRED marca con `"."` los días sin dato.
- Finnhub (resultados de empresas en `services/earnings.ts` y datos de empresa en `services/company.ts`): sus términos no permiten mostrar los datos a terceros, así que **solo el dueño** los recibe: `/api/calendar` suma `companies` y los eventos `empresa` solo con rol owner, y el conector solo en el `calendario` y la herramienta `empresa` del dueño; `/api/company` es solo del dueño. Sin `FINNHUB_API_KEY` queda apagado sin error. Plan gratis: 60 pedidos por minuto y 1 mes de historia.
- Los feriados y cierres anticipados de la NYSE están cargados hasta 2027 en `lib/market-hours.ts` (`NYSE_CALENDAR_UNTIL`). **Cada año hay que agregar el siguiente** desde nyse.com/markets/hours-calendars; si no, la app gasta créditos en los feriados.
- El historial guarda 5 años (`hist5:<símbolo>` en KV) por 1 crédito; los rangos se recortan de ahí con `sliceRange`, que empieza en el cierre **anterior** al inicio del rango.
- Los indicadores (`lib/indicators.ts`) se calculan con los 5 años y **después** se recortan al rango; `/api/history` solo los manda con `&ind=1` (pesan más que los cierres). `compare` alinea las series por fecha **antes** de recortar y carga los símbolos uno por uno: el contador de créditos se lee y escribe en KV y en paralelo se perderían sumas.
- Colores de los gráficos con varias líneas: `--s1`…`--s4` en `styles.css`, validados para daltonismo con el validador de la skill `dataviz` sobre `#121212`. Si cambias uno, vuelve a validar (parejas vecinas para Comparar; todas las parejas para precio + MM50 + MM200).
- Si cambias la forma de los datos guardados en KV, lee también el formato anterior (ver `readQuotes`).

## Estado y próximos pasos

**Lo que falta, en orden, está en `ROADMAP.md`**: empieza por ahí en cada sesión nueva.

- **Cuenta propia de Cloudflare** («mercados», `account_id` en `wrangler.jsonc`), con su subdominio y su Zero Trust: la app vive en `https://mercados.mercados.workers.dev`. La cuenta anterior es de otro proyecto del usuario y no se debe tocar. Ahí queda una copia vieja del Worker `mercados` que se borra **solo con confirmación del usuario**.
- **Conector de Claude:** vive en el Worker aparte `mercados-mcp` (`src/mcp-worker.ts`, `wrangler.mcp.jsonc`), con OAuth propio (`@cloudflare/workers-oauth-provider`). Tu correo se confirma en la app, ruta `/conector/identidad`, detrás de Access. Se descartó *Managed OAuth* de Access porque falla en claude.ai web y móvil (anthropics/claude-ai-mcp#410). Por ahora es solo para el dueño. `mercados-mcp` tiene sus propios secretos (`OWNER_EMAILS`, `LOGIN_LINK_SECRET`, que debe ser igual en ambos Workers, `TWELVE_DATA_API_KEY`, `FRED_API_KEY` y el opcional `FINNHUB_API_KEY`). Las pruebas del login completo están en `test/mcp-worker.test.ts`; en Node, `cloudflare:workers` se reemplaza con `test/stubs/`.
- **Compartida con amigos, solo con datos públicos.** Los términos de Twelve Data (plan gratis) no permiten mostrar sus datos a terceros ni compartir la clave. Por eso hay dos roles: el **dueño** (`OWNER_EMAILS`) ve todo y los **amigos** ven solo Perú (BCRP) y EE. UU. (FRED). El bloqueo es del servidor: 403 en precios, historial y lista, y el conector sin esas herramientas. Pendiente:
  - revisar los términos de FRED (su web estaba en mantenimiento); `FRED_API_KEY` ya está cargada;
  - cargar `FINNHUB_API_KEY` en ambos Workers para prender los resultados de empresas;
  - más adelante, que cada amigo use su propia clave gratis de Twelve Data (lista y caché por persona) para que también vea precios.
