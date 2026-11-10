# Rueda (antes «Mercados») — notas para Claude

El nombre visible es **Rueda**. Los nombres técnicos (Workers, direcciones, KV, scope OAuth `mercados`, claves `mercados.*` de localStorage) siguen como «mercados» a propósito: no los cambies.

App de mercados (Cloudflare Worker + panel web + conector MCP para Claude). El README explica la arquitectura, la API y el despliegue: léelo antes de cambiar algo.

## Rumbo (9 nov)

El usuario: «intentemos desviarnos del aspecto juego del app, parece que nadie lo está usando mucho, la idea es que rueda sea una herramienta completa para poder tomar las decisiones de inversión más informadas posibles».

- **Lo que se construye ahora es análisis para decidir**, no juegos. El plan va en cuatro fases (ROADMAP.md, sección 8i): 1) la ficha al día (hecha el 9 nov); 2) ¿cara o barata? (hecha el 10 nov); 3) tu cartera real; 4) decidir y seguir.
- **Datos públicos primero** (SEC, BCRP, FRED): así le sirve a todo el grupo, también a quien no conectó su clave. Lo que no necesita precio va también en «Resultados de empresas» (`#fin`), que ven todos.
- **Rueda muestra datos y cuentas, no dice qué comprar o vender.** Un puntaje (Piotroski) o una etiqueta («sobre su historia») describe; no recomienda. Explica cada indicador en su «?».
- **El juego quedó aparte, no borrado:** sin pestaña ni avisos; se entra por el enlace del pie (`#juego`). No propongas juegos nuevos ni le sumes cosas salvo que el usuario lo pida.

## Cómo trabajar en este proyecto

- Responde siempre en **español**.
- Trabajo por fases. Al cerrar cada una, resume qué quedó, qué se probó y qué falta.
- Antes de cambios grandes o de diseño, propón **opciones concretas con una recomendación** y espera la elección. Muestra una vista previa antes de publicar cambios visuales.
- Verifica contra documentación oficial y con datos reales: compara precios con Google Finance, el BCRP con su API y FRED con su web.
- **Secretos:** nunca en el repo (es público) ni pegados en prompts ocultos de la terminal, porque en Windows Ctrl+V guarda `\u0016`. Se cargan en el panel de Cloudflare: Workers → mercados → Settings → Variables and Secrets, tipo **Secret**. `/api/status` dice si están bien sin mostrarlos.
- **Windows:** usa `npx.cmd`, no `npx`. Para la vista previa local usa las configuraciones `mercados-dev` / `mercados-mcp-dev` de `.claude/launch.json` (con `MOCK_DATA=true` en `.env`) en vez de lanzar `wrangler dev` a mano: deja procesos `workerd` colgados.

## Comandos

- Pruebas: `npx.cmd vitest run`. Tipos: `npx.cmd tsc --noEmit`.
- Íconos de la app (si cambia el dibujo de `icon.svg`): `npm run icons`.
- Publicar: push a `main` (GitHub Actions corre typecheck, pruebas y deploy). Para publicar a mano: `npx.cmd wrangler deploy`.

## Cosas que ya costaron caro

- La Cache API **no funciona detrás de Access**, así que todo va a KV. El plan gratis permite **1.000 escrituras al día por cuenta**: escribe poco y agrupado.
- Twelve Data, plan gratis: 800 créditos al día y 8 por minuto, **compartidos con el conector oficial de Twelve Data** que se usa en claude.ai. La app se frena en 600.
  - **Límite por minuto** (5 nov, el usuario vio el error al buscar): el cupo se repone al empezar cada minuto. Con un 429 por minuto el servidor manda `retryAfter` (`secondsToNextMinute`), y el panel espera con una cuenta regresiva y vuelve a pedir solo (`waitMinute`): no muestres ese error. El 429 por los 800 del día no lleva `retryAfter`.
  - **Pedidos del historial:** los de un mismo símbolo van de a uno hasta que el servidor lo tiene guardado (`historyApi` en `app.js`). Si salen dos a la vez, Twelve Data cobra los dos. Usa `historyApi` para cualquier pedido nuevo de `/api/history`.
  - **Otras fuentes de precios** (revisadas el 5 nov): ninguna gratis deja mostrar sus precios a otros. Para el dueño quedan Finnhub (`/quote`, 60 por minuto, ya conectada) y Alpaca (200 por minuto; pide cuenta con verificación de identidad). Tiingo da 50 consultas por hora y es de uso personal. Stooq pide una verificación de navegador y la API de Yahoo no es oficial. Además, el volumen intradía del plan gratis viene de una sola parte de las bolsas: no lo muestres como volumen real.
- El BCRP pega un aviso HTML de PHP después del JSON. `extractJson` lo resuelve: no vuelvas a `res.json()`.
- La API del BCRP devuelve las series **ordenadas por código**, no en el orden pedido. `getBcrp` las pide ordenadas y las reacomoda; no mezcles prefijos (PD/PN) en un mismo pedido.
- Noticias: algunos RSS (Gestión, Bloomberg Línea) traen la nota completa y pesan ~1 MB. `fetchRss` lee el stream y corta apenas tiene los titulares; no lo cambies por `res.text()`, porque el plan gratis da 10 ms de procesador por pedido. Nunca guardes ni muestres el texto completo de las notas.
- **Estilo «A · Limpio»** (5 nov, elegido por el usuario entre tres maquetas: «siento que puede mejorar bastante»):
  - **Tipografía:** títulos, etiquetas, botones y frases en IBM Plex Sans (`--f-sans`) y en letra normal, sin mayúsculas. Números, precios, símbolos y periodos (1M, 1A) en IBM Plex Mono. Nada por debajo de 12 px.
  - **Tarjetas sin bordes:** las separa el fondo (`.screen` en `--panel`, radio `--r-card`; adentro, `--raise`). Las filas, con líneas finas (`--hair`).
  - **El cian**, para lo que se toca (enlaces, la pestaña y la opción elegidas, el botón principal `.cta`), la marca, los gráficos y «tú» en la liga. No para títulos ni símbolos.
  - **Botones:** sin borde y con fondo `--raise`. Los grupos de opciones (`.ranges`) son un selector de una pieza.
  - Las explicaciones de uso van en el «?» de cada sección, no como texto suelto.
- **SEC, trimestres y últimos 12 meses** (9 nov, `lib/quarters.ts`):
  - Un 10-Q trae el trimestre y el acumulado del año en los resultados, pero **solo el acumulado en el flujo de caja**, y el cuarto trimestre no sale en ningún informe. `quarterValues` saca los trimestres sueltos restando acumulados que empiezan el mismo día; los 12 meses son cuatro trimestres seguidos (`contiguous`). No sumes periodos sin esa comprobación.
  - **Las que presentan 20-F** (BVN, Credicorp, IFS) no tienen trimestres con datos: `quarters` viene vacío, `ttm` y `latest` en `null`, y el panel cae al año fiscal. No lo trates como error.
  - **`companyfacts` no:** pesa varios MB y no entra en los 10 ms de procesador. Se lee concepto por concepto (`companyConcept`), con los pedidos repartidos en cuatro rutas para no pasar de 50 por pedido: resultados (8), fundamentales (16), calidad (13) y reportes (2). El panel pide la calidad recién cuando llegaron los fundamentales (`qualityFor`), para no repetir consultas.
  - **Acciones y splits:** el promedio diluido de años viejos no viene ajustado por splits; solo los tres años del informe más nuevo son comparables. Por eso la dilución se mide con esos tres.
  - **Enlaces a los reportes:** van a `www.sec.gov` y los abre el navegador de quien mira. Desde el Worker ese dominio responde 403 sin un correo en el User-Agent: no lo leas desde el servidor.
- **Columnas** (29 oct, pedido del usuario: «datos en los costados y en el medio, para no scrollear tanto»): las secciones van dentro de `.col-left`, `.col-center` o `.col-right` de su hoja (`#sheet-hoy`, `#sheet-acciones`, `#sheet-mercados` o `#sheet-cartera`) en `index.html`.
  - **Al agregar una sección:** ponla en la hoja y la columna que le toca, y dale su `order` del celular en `styles.css` (cada hoja tiene su propia lista de `order`).
  - **Columna vacía:** si en una hoja una columna no tiene nada a la vista (un amigo sin clave no ve el termómetro), `fitColumns` en `app.js` la cierra con `.sin-left` o `.sin-right`. Mira la regla de cada sección (`display`), no la columna.
  - **Diseño que depende del ancho de la sección:** `.screen` es un contenedor, así que va con `@container`, no con `@media` (una sección puede ser angosta en una pantalla ancha).
  - **Columnas parejas:** si una crece mucho, la página entera se alarga. Mira la altura de cada una antes de mover algo.
- **Termómetro del S&P 500** (`services/thermometer.ts`, 4 nov): describe la volatilidad del SPY frente a sus últimas 500 sesiones. **No agregues predicciones de dirección** sin que el usuario lo pida: la evaluación con esos 500 movimientos mostró que no hay un patrón aprovechable, y el panel lo dice en su «?». Con la clave de Rueda lo ve solo el dueño (`OWNER_ONLY`); un amigo lo ve con su propia clave (`FRIEND_KEYED`, ver «Precios con la clave de cada uno»).
- **Materias primas y «Más del Perú»** (4 nov, pedido del usuario: «los datos de Perú muévelos a un espacio un poco más escondido y pon en su lugar datos de commodities»): `#cmd` (cobre, oro, plata, zinc y petróleo WTI del BCRP) va en la columna izquierda donde estaba lo del Perú; BVL, reservas, bonos y riesgo país quedaron en `#pm`, plegado (`#pm-fold`) debajo de Perú y EE. UU., y sus gráficos se dibujan recién al abrirlo. Todo sale del mismo pedido (`peruMarkets`, KV `peru-markets3`). Para sumar materias primas a la vista de los amigos usa solo fuentes públicas (BCRP o series de dominio público de FRED, como las de la EIA); las de Twelve Data no.
- **Hojas** (5 nov: «que la UI sea lo más fácil de usar posible, en PC y celular»; 9 nov: «Cartera» en lugar de «Juego»). Son cuatro, por tema:
  - **Hoy:** resumen, noticias, agenda y Polymarket.
  - **Acciones:** tu lista, la ficha, comparar, SEC y P/S.
  - **Mercados:** termómetro, materias primas, cripto, Perú y EE. UU.
  - **Cartera** (`#sheet-cartera`): lo tuyo. Tu cuenta Hapi y, para el dueño, la cartera simulada al costado. Aquí va lo que mida la cartera real (fase 3).
  - **El juego** (`#game`) no es una hoja: no tiene pestaña ni contador, se entra por el enlace del pie o con `#juego`, y «← Volver a Rueda» regresa a la hoja de antes. No se recuerda como hoja de inicio. `VIEWS` son las hojas más el juego; `SHEETS`, solo las hojas.
  - **Cómo cambian:** cada panel lleva `hidden` cuando no se ve (`showSheet`, `body[data-hoja]`), y la dirección es `#acciones`, `#mercados` o `#cartera` («Hoy» no lleva nada). Se recuerda en cada equipo (`mercados.hoja2`) y cada hoja vuelve a donde bajaste.
  - **Gráficos:** al cambiar de hoja se redibujan, porque con la hoja oculta se dibujan con el ancho de reserva.
  - **La clave de un amigo** se conecta desde «Acciones» (`#keycard`, que abre el tutorial) y se quita al pie de su lista (`#wl-key-off`). Antes eso solo estaba en la liga.
- **Celular** (5 nov, elegido por el usuario):
  - **Arriba**, una sola barra fija (`.top`): logo, ↻, ↓ y la lupa, con la hora y «Actualizado» en una línea chica.
  - **Abajo**, las hojas, como en una app (el mismo `nav.sheets`, fijo).
  - **Sin `transform`, `filter` ni `backdrop-filter` en `.top`:** lo fijo de adentro (la barra de hojas y el buscador abierto) se ubicaría respecto de ella y no de la pantalla.
  - **La ficha** se abre a pantalla completa (`body.ficha-abierta`, `openDetail` y `closeDetail`): «← Volver» y el botón atrás del teléfono (`history.pushState`) dejan la hoja donde estaba. Si agregas algo que abra la ficha, usa `openDetail`.
- **«Hoy» empieza con «Tu día» y «Tu lista»** (`renderDia` y `renderMiLista`, con lo que el panel ya cargó: no piden nada nuevo).
  - **Tu día:** S&P 500, dólar, cobre y bitcoin. Si el SPY no está en tu lista, se usa su último cierre del termómetro (`state.thermo`). El dólar sale del BCRP y bitcoin de CoinGecko.
  - **Tu lista:** las tres que más se movieron. En «Hoy» no va la cinta.
- **La ficha** (5 nov): el precio en grande (`#d-price`), el selector de periodos a lo ancho, el gráfico y lo largo en pestañas (`D_TABS`, se recuerda la última). Desde el 10 nov son cinco:
  - **Resumen:** estadísticas del precio, estacionalidad y probar una estrategia.
  - **Negocio** (¿es buen negocio?): resultados y calidad. No usa precios.
  - **Valor** (¿cara o barata?): múltiplos frente a su historia, P/S y DCF. Necesita precio.
  - **Empresa:** datos de Finnhub (solo el dueño), reportes de la SEC y hechos de la SMV.
  - **Noticias.**
  - Una pestaña sin nada se esconde (`renderDetailTabs`). Los bloques de «Negocio» y «Valor» se piden al abrirlos y en su pestaña se abren solos (`D_TAB_BLOCKS`).
  - **Si agregas un bloque a la ficha,** ponlo en el panel de su pestaña (`dp-…`) y, si se pide al abrirlo, en `D_TAB_BLOCKS`.
- **La ficha al día** (9 nov, fase 1 del rumbo nuevo). Todo de la SEC y público:
  - **Resultados** (`#d-fin`, `financialsView`): arriba, los últimos 12 meses y el último trimestre; el gráfico y la tabla, por año o por trimestre (`finMode`, se recuerda en `mercados.sec-vista`).
  - **Lo más nuevo** (`latestOf` en `valuation-core.js`): los últimos 12 meses y el balance del último 10-Q (`fundamentals.latest`) si su fecha coincide con la de los resultados; si no, el año fiscal para todo. Úsalo siempre que mezcles resultados y balance, y di en el texto con qué periodo se calculó.
  - **Calidad del negocio** (`#d-qual`, `services/quality.ts`), en tres grupos: rentabilidad (ROIC, ROE, márgenes, flujo libre), deuda, y lo que devuelve o diluye; después, Piotroski. Lo anual lo calcula el servidor; ROE, márgenes y deuda con lo más nuevo los saca el panel de `peerMetrics`.
  - **Reportes a la SEC** (`#d-filings`, en «Empresa»; `services/filings.ts`): los que importan, con su tema en castellano (`ITEMS_8K`) y enlace al documento.
  - **Sin clave:** resultados, calidad y reportes están también en `#fin` (`renderFinExtras`), sin lo que necesita precio. Si sumas un bloque de datos públicos a la ficha, ponlo ahí también.
- **¿Cara o barata?** (10 nov, fase 2 del rumbo nuevo):
  - **Las cuentas de valoración viven en `public/valuation-core.js`**: un módulo sin DOM, con pruebas (`test/valuation-core.test.ts`). Lo importan el panel (`V`, cargado al empezar) y el servidor (`services/valuation.ts`). **Una cuenta nueva de valoración va ahí, con su prueba,** no escrita dos veces.
  - **Múltiplos frente a su historia** (`#d-mult`, `renderDetailMult`): P/E, EV/EBITDA, P/S, P/B y rendimiento del flujo libre de hoy, frente a los de cada cierre fiscal de los 5 años con precio guardado (`multiplesHistory`, `standing`). Con menos de 3 años no se compara.
  - **Splits:** los precios guardados vienen ajustados y las portadas viejas de la SEC no. `splitAdjusted` lleva las acciones de antes a las de hoy cuando el salto entre dos portadas es de 2, 3, 10… (comprobado con NVDA, AMZN, TSLA y WMT). Úsalo siempre que multipliques un precio histórico por acciones de entonces.
  - **Sin verde ni rojo:** estar sobre la mediana no es bueno ni malo. Se dice «sobre», «bajo» o «cerca de su mediana», nunca «cara» o «barata» como veredicto.
  - **DCF** (`#d-val`, `renderDetailVal`): el DCF simple y, al revés, el crecimiento que ya descuenta el precio (`impliedGrowth`, entre −30 % y 60 %).
  - **Pares lado a lado** (`peersSide`, dentro de «Comparar con pares», `#ps`): para todos; se pide al abrirlo y los múltiplos salen si hay precio.
  - **Pedidos a la SEC de a uno** (`secQueue`): resultados, fundamentales, calidad y reportes pasan por una sola cola en el panel. Un pedido nuevo que termine en la SEC va por ahí.
- **Más fácil de usar** (5 nov, elegido por el usuario):
  - **Botones de unos 40 px** en el celular y en pantallas táctiles (`pointer:coarse`). Los enlaces dentro de una frase quedan como están.
  - **Secciones plegables:** tocar el título las pliega (`setupFolds`, se recuerda en `mercados.plegadas`). No se pliegan las de `NO_FOLD`: la ficha, la bienvenida, el aviso de la clave y la liga.
  - **Títulos de sección:** no les cambies el texto por código, porque se borraría el botón que los pliega.
- **Juegos que no son de pronosticar** (`game/minijuegos.ts`): gráfico del día, 2/3 del promedio y liga de acciones, en el mismo Durable Object que el mercado. El usuario pidió el 2 nov «separarse de la idea de pronósticos solamente». Reglas:
  - **Liga de acciones** (`game/acciones.ts`): el usuario pidió carteras «de verdad» y que entrar fuera «lo más fácil posible».
    - Cada amigo juega con su propia clave gratis de Twelve Data. **Nunca uses la clave de Rueda para los amigos:** su licencia no permite mostrarles esos datos.
    - Lo que ven los demás son solo porcentajes y símbolos, nunca precios ni montos.
    - Las claves van cifradas (`lib/secretbox.ts`).
    - La tarea programada pide pocos símbolos por pasada y por clave, por el límite de 8 por minuto.
  - **Solo datos públicos** (BCRP y FRED, por `game/series.ts`). Nada de Twelve Data ni de Finnhub, porque los ven los amigos.
  - **Liga:** cada orden se cumple con el cierre del primer día hábil después de darla, para que no se pueda comprar a precio de ayer sabiendo lo de hoy.
  - **2/3 del promedio:** no muestra lo de los demás antes del cierre.
  - **Gráfico del día:** no manda la respuesta antes de que contesten. La serie del día se guarda la primera vez y no cambia aunque cambien los datos.
- **Liga de acciones, lo principal de «Juego»** (2 nov, pedido del usuario: «tiene que ser la atracción principal» y «el tutorial aparte para que se pueda meter la gente»):
  - Va arriba y a todo el ancho (`.hero`). El tutorial es un `<dialog>` paso a paso (`openLeagueTutorial`), y el enlace `/#liga` lo abre. No vuelvas a meter los pasos dentro de la tarjeta.
  - **Diseño «Carrera»** (4 nov; el usuario: «puede ser más llamativo» y «que la UI sea más intuitiva»; se le mostraron tres maquetas y pidió publicar la recomendada): titular con quién lidera y tu puesto, barra de cierres de la temporada, gráfico de la carrera (tú en cian, quien lidera en blanco, los demás en gris), ranking, campeones, y abajo tu cartera y «Comprar» en dos pasos. La carrera se dibuja al ancho de su sección (`drawRace`) y se rehace al cambiar el tamaño de la ventana.
  - **Temporadas de quincena** (4 nov, idea del usuario): del 1 al 15 y del 16 a fin de mes, en fechas de sesión de NY (`seasonOf`). La cartera no se reinicia. El resultado de cada temporada lo guarda la tarea programada (`closeSeasons`, claves `ls:`) y no se recalcula después: si cambias cómo se calcula el rendimiento, las temporadas ya guardadas quedan como estaban.
  - **El mercado de predicciones se quitó** el mismo 2 nov («puede ser droppeado»). No lo vuelvas a agregar sin que lo pida.
  - Sin plata real ni premios en ningún juego: con plata sería una apuesta, que en el Perú necesita licencia.
- El calendario económico (`lib/calendar.ts`) se carga a mano, como los feriados de la NYSE: cada fecha se verifica en su fuente oficial. Sin fechas, el panel oculta la sección y el conector no ofrece `calendario`.
- **Resumen del día** (`services/summary.ts`): lo publica una tarea programada del dueño, en la nube de Anthropic y con su plan Max, por la herramienta `publicar_resumen` del conector. **El Worker no llama a ninguna IA ni guarda claves de Anthropic:** los términos de Claude no permiten usar la cuenta de Max desde un programa propio, y la API se cobra aparte.
  - Lo ven los amigos, así que la tarea solo usa titulares y datos públicos, nunca precios de Twelve Data ni datos de Finnhub. Por eso pide `calendario` con `publico: true`: sin ese parámetro el calendario del dueño trae los resultados de empresas de Finnhub, y en la primera prueba se coló uno.
  - `publicar_resumen` es la única herramienta que escribe: solo para el dueño, con largos acotados y enlaces solo de los medios de las noticias o de fuentes oficiales.
  - **Corto a propósito** (28 oct, el usuario sintió el panel «demasiado junto»): título de hasta 100 caracteres, texto de 2 o 3 frases (máximo 450), sin puntos y sin repetir las cifras de la cinta. El servidor rechaza lo más largo. No agregues una fila de cifras a la tarjeta: ya están en la cinta.
  - Si cambias las reglas, actualiza la descripción de la herramienta y el prompt de la tarea (en ROADMAP.md, sección 8g).
- FRED marca con `"."` los días sin dato. Sus términos permiten mostrar sus datos a los amigos solo si la app muestra el aviso exacto («This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.»), el enlace a sus términos y una política de privacidad: están al pie y en `public/terminos.html`. **Si una función nueva guarda algo de los usuarios, actualiza esa página.** Además, cada serie de FRED tiene su etiqueta de derechos. Las de dominio público o de la propia Fed de St. Louis se pueden mostrar citando la fuente. Las de terceros (NFCI, VIX, S&P 500, ICE) necesitan permiso de su dueño para mostrarlas a otros, así que serían solo para el dueño.
- **Hapi** (`public/hapi-*.js`, `services/hapi.ts`): el bróker del grupo no tiene API ni exporta CSV; solo entrega PDF (estado de cuenta mensual que emite Apex Clearing y confirmaciones por operación). **No leas la cuenta con usuario y contraseña** (API interna): va contra sus términos y obligaría a guardar contraseñas.
  - La cuenta de cada persona va **cifrada en su navegador** con su frase, por decisión del usuario: que ni el dueño pueda verla. El servidor solo guarda texto cifrado; **no agregues nada que necesite leerla en el servidor** (ni en el conector), ni vistas o rankings sobre cuentas ajenas sin preguntarle. Toda la lógica (comisiones, libro, lector del PDF) vive en `public/hapi-core.js` y `public/hapi-statement.js`, sin DOM, y se prueba con vitest (`allowJs` en tsconfig; tipos con JSDoc).
  - El estado de cuenta se lee con pdf.js (copia en `public/vendor/pdfjs`, 4.10.38 legacy; `isEvalSupported: false` por la CSP). **No la subas a la 5 o 6 sin revisar Safari:** desde la 5 el build legacy pide Safari 18 y no trae el reemplazo de `Promise.withResolvers`, así que en un iPad con iPadOS anterior a 17.4 no funciona: es la causa más probable de que un amigo no pudiera importar en iPad (26 oct). La 4.10.38 trae ese reemplazo y funciona desde Safari 16.4; los iPads más viejos ven un aviso claro. Las pruebas usan un estado de cuenta **inventado**: nunca pongas en el repo (público) datos de un estado real. El de setiembre de 2026 solo traía dividendos: las filas de compras, ventas y depósitos se reconocen por el tipo («BOUGHT», «SOLD», «JOURNAL», «ACH»…) pero falta verlas en un estado real.
  - Los precios de mercado, solo para el dueño (Twelve Data). Las comisiones están fechadas (oct. 2026): revisarlas en help.hapi.trade si cambian. `VERSION` (el commit) lo pone GitHub Actions al desplegar y se muestra al pie.
- **App instalable** (`public/manifest.webmanifest`, `public/sw.js`, `public/icons/`): el `id` del manifiesto (`/`) identifica la app ya instalada en los equipos; no lo cambies. El manifiesto se pide con `crossorigin="use-credentials"` porque todo está detrás de Access. El service worker **no guarda nada y no responde nada mientras haya conexión**, a propósito: así nunca se mete en el ingreso de Access ni deja datos de una sesión en el equipo. Si algún día guarda algo o manda notificaciones, prueba el ingreso con código en la app instalada y actualiza `/terminos.html`. Para sacarlo de todos los equipos: publica un `sw.js` que solo llame a `self.registration.unregister()`.
- SEC (`lib/sec.ts`, `services/financials.ts`): datos públicos, también para los amigos. Solo se usan `efts.sec.gov` (buscar el CIK) y `data.sec.gov` (`companyconcept`, respuestas chicas; `companyfacts` pesa varios MB y no entra en los 10 ms de CPU). `www.sec.gov` responde 403 sin un correo en el User-Agent: **no pongas el correo del usuario ni finjas un navegador**. La SEC pide no pasar de 10 pedidos por segundo: se piden de a 6 como mucho. Cada símbolo nuevo es una escritura de KV (`sec:<símbolo>`, 7 días), y los amigos pueden escribir cualquier símbolo. En octubre de 2026 la API de la SEC aún no tenía los 20-F en NIIF del año fiscal 2025 (de esos informes solo traía la portada, `dei`): no es un error de Rueda, y el panel avisa cuando falta el último año.
- **Resumen rápido, ratios y DCF, y «Analizar con Claude»** (4 nov; el usuario pidió que analizar sea «accesible, rápido» y después «añade las estrellas»). Reglas:
  - El resumen describe lo que ya está en la ficha: no le agregues predicciones ni palabras de compra o venta.
  - Los fundamentales de la SEC (`services/fundamentals.ts`, `secx:`) van aparte de `sec:` a propósito: el P/S y `valorar_ps` cargan varias empresas por pedido, y juntos pasarían de las 50 consultas del plan gratis.
  - Algunas empresas informan su deuda con etiquetas propias (Buenaventura desde 2019): por eso la deuda neta del DCF se puede escribir a mano.
  - «Analizar con Claude» es un enlace con la pregunta escrita, igual que «Profundiza en Claude». **El Worker no llama a Claude.** La pregunta siempre termina pidiendo que no recomiende comprar o vender.
- **Buscador de acciones** (`services/lookup.ts`, 5 nov; el usuario pidió «una sección para poder buscar acciones específicas» y eligió la ficha completa, «en la barra de arriba»). Va a la derecha de las pestañas, porque en la fila del logo no entraba. Reglas:
  - **Las sugerencias son de la SEC** (públicas, para todos) y no se guardan en KV: cada búsqueda sería una escritura. Solo la memoria de cada instancia, 10 minutos.
  - **Abrir una acción fuera de las listas gasta créditos** (precio e historial, unos 2): solo con la clave de Rueda para el dueño, o con la del amigo en su parte del Durable Object. Nunca con la de Rueda para un amigo.
  - **Tope de 20 nuevas al día por persona** (`LOOKUP_DAILY_MAX`) y registro `buscadas`. Fuera de las listas, historial, titulares y Finnhub solo se piden de las anotadas con precio (`lookedUp`). No saques ese control: es lo que impide gastar créditos y escrituras con cualquier símbolo.
  - **Si Twelve Data no tiene el símbolo**, se anota sin precio y no se pide su historial. Si el pedido falla (límite por minuto, freno del día), no se anota.
  - **El precio de las buscadas del dueño sale de Finnhub** (5 nov, pedido del usuario: «conecta finnhub a la búsqueda de precios»).
    - `finnhubFirst` usa `/quote` y el nombre de `/stock/profile2`, sin créditos de Twelve Data. Así una acción nueva cuesta 1 crédito (el historial).
    - Divisas, cripto, o si Finnhub falla o responde ceros (no tiene el símbolo): Twelve Data.
    - **Nunca para los amigos:** los términos de Finnhub no permiten mostrar sus datos a otros. Ellos siguen con `twelveSource` y su propia clave.
    - La moneda es siempre US$: la del perfil de Finnhub es la de los informes (Credicorp informa en soles).
  - **Comparar sigue siendo con las listas.**
- **Lo que espera el mercado** (`lib/polymarket.ts`, `services/polymarket.ts`, 4 nov; el usuario preguntó por «Polymarket o Kalshi»). Eligió tarjetas con el diseño de Rueda más el widget oficial, y los temas «Bolsa y empresas» y «Política y mundo». El dueño fija eventos pegando su enlace. Reglas:
  - **Kalshi, no:** sus términos de datos solo permiten uso personal y no comercial, y prohíben guardar en caché y usar con IA (también lo que genere).
  - **Polymarket:** sus términos dan una licencia personal y prohíben revender los datos a empresas financieras o distribuidores de datos. El usuario aceptó la zona gris de mostrarlos con diseño propio a los chicos.
  - **No los pases al conector de Claude:** no se eligió y sus términos no dicen nada sobre IA.
  - **El widget** (`embed.polymarket.com`, permitido en `frame-src` de la CSP) se carga solo al tocar «Ver en vivo», sin botones de compra. Que no se cargue solo: es contenido de terceros.
  - **No es el mercado de predicciones del grupo** (se quitó el 2 nov): aquí solo se muestran precios de otro sitio.
- **Hechos de importancia de la SMV** (`services/smv.ts`, 4 nov): su API tarda unos 10 s por dos meses. **Nunca la llames desde un pedido del panel**: la trae la tarea programada (`refreshSmv`, cada 3 horas y solo en los primeros 10 minutos de la hora, para no insistir si está caída). Las empresas extranjeras vienen con RUC «0»: el vínculo con su símbolo va por nombre (`SMV_ISSUERS`), y en el panel se repite la lista de símbolos (`SMV_SYMBOLS`).
- **Cripto** (`services/crypto.ts`, CoinGecko Demo): se puede mostrar a todos **citando la fuente cerca de los datos** (su guía de atribución), por eso el enlace va debajo de las tarjetas. La clave va en el encabezado, nunca en la dirección. No subas la frecuencia de una vez por hora sin mirar el cupo mensual del plan ni las escrituras de KV.
- **Posición de los fondos** (`lib/cftc.ts`, `services/cot.ts`, 6 nov; el usuario la eligió al revisar OpenBB): el informe COT de la CFTC (*Disaggregated, Futures Only*; los fondos son «managed money»). Es de dominio público, así que la ven todos, **citando a la CFTC** (lo pide su política, cftc.gov/WebPolicy). Reglas:
  - **Contratos:** cobre (085692), oro (088691) y plata (084691) de COMEX, y WTI de NYMEX (067651). El zinc no tiene, porque se negocia en Londres. Sus claves son las de `COMMODITIES` en `app.js`.
  - **Frecuencia:** sale los viernes a las 15:30 de Nueva York, con las posiciones del martes. Un registro en KV (`cot`), cada 3 horas como mucho.
  - **Sin clave:** la API (Socrata) no la pide. Si algún día responde 429 seguido, se puede sumar un *app token* gratis como secreto, en el encabezado `X-App-Token`.
  - **Describe, no predice:** como el termómetro, no le agregues señales de compra o venta.
- **P/S** (4 nov, pedido del usuario: «facilita con alguna herramienta el método P/S»; eligió la calculadora de la ficha, el comparador y `valorar_ps`). Las cuentas del P/S de hoy están **dos veces**: en `services/valuation.ts` (conector) y en el bloque «P/S» de `app.js` (panel). Si cambias una, cambia la otra. Desde el 10 nov usan las ventas de los últimos 12 meses si la empresa presenta trimestres (`psBase`, `psRow`), y el ajuste por splits de la historia es compartido (`valuation-core.js`). Las acciones salen de la portada de la SEC (`shareCounts` suma las clases de un mismo informe); en los ADR se divide por `ADR_RATIO` (solo cargar proporciones verificadas en la SEC). `valorar_ps` acepta hasta 3 comparables: cada empresa nueva son unas 8 consultas a la SEC, y el plan gratis de Workers permite 50 por pedido.
- Finnhub (resultados de empresas en `services/earnings.ts` y datos de empresa en `services/company.ts`): sus términos no permiten mostrar los datos a terceros, así que **solo el dueño** los recibe: `/api/calendar` suma `companies` y los eventos `empresa` solo con rol owner, y el conector solo en el `calendario` y la herramienta `empresa` del dueño; `/api/company` es solo del dueño. Sin `FINNHUB_API_KEY` queda apagado sin error. Plan gratis: 60 pedidos por minuto y 1 mes de historia.
- Los feriados y cierres anticipados de la NYSE están cargados hasta 2027 en `lib/market-hours.ts` (`NYSE_CALENDAR_UNTIL`). **Cada año hay que agregar el siguiente** desde nyse.com/markets/hours-calendars; si no, la app gasta créditos en los feriados.
- El historial guarda 5 años (`hist5:<símbolo>` en KV) por 1 crédito; los rangos se recortan de ahí con `sliceRange`, que empieza en el cierre **anterior** al inicio del rango.
- Los indicadores (`lib/indicators.ts`) se calculan con los 5 años y **después** se recortan al rango; `/api/history` solo los manda con `&ind=1` (pesan más que los cierres). `compare` alinea las series por fecha **antes** de recortar y carga los símbolos uno por uno: el contador de créditos se lee y escribe en KV y en paralelo se perderían sumas.
- El historial guardado (`hist5:`) trae `bars` (apertura, máximo, mínimo y volumen) desde el 22 oct; `cached` acepta `valid` para renovar una vez los registros con el formato anterior. El volumen diario de Twelve Data sí es el consolidado (verificado contra Nasdaq); el intradía, no.
- Velas: huecas al subir y rellenas al bajar, porque el verde (`--up`) y el rojo (`--down`) dan ΔE 2,2 con deuteranopía en el validador de `dataviz`. En los paneles de abajo de la ficha, la línea principal va en `--s3` y la señal del MACD en `--s4`.
- Colores de los gráficos con varias líneas: `--s1`…`--s4` en `styles.css`, validados para daltonismo con el validador de la skill `dataviz` sobre `#121212`. Si cambias uno, vuelve a validar (parejas vecinas para Comparar; todas las parejas para precio + MM50 + MM200).
- Si cambias la forma de los datos guardados en KV, lee también el formato anterior (ver `readQuotes`).
- Pronósticos del grupo (`lib/forecasts.ts`, `services/forecasts.ts`): las preguntas salen de `EVENTS` del calendario (cargar las fechas de cada año también alimenta el juego) y del fin de cada mes. Cada pronóstico y cada nombre es una clave propia con metadata y se leen con un solo `list` (el plan gratis da 1.000 `list` al día por cuenta: no listes en cada ejecución de la tarea programada). Los resultados (`pron-results`) los escribe solo la tarea programada. Son datos públicos: los amigos juegan.
- Lista diaria (`services/eod.ts`): la renueva la tarea programada (`scheduled` en `index.ts`, cron en `wrangler.jsonc`), nunca un pedido del panel, que solo lee el resumen `eod`. Pide de a 5 por vez (8 créditos por minuto, compartidos) y marca cada símbolo como revisado por sesión (`checked`) para no gastar créditos en uno que no cotizó. `storedHistory(d, símbolo, through)` pide hasta ese día inclusive.

## Estado y próximos pasos

**Lo que falta, en orden, está en `ROADMAP.md`**: empieza por ahí en cada sesión nueva.

- **Cuenta propia de Cloudflare** («mercados», `account_id` en `wrangler.jsonc`), con su subdominio y su Zero Trust: la app vive en `https://mercados.mercados.workers.dev`. La cuenta anterior es de otro proyecto del usuario y no se debe tocar. Ahí queda una copia vieja del Worker `mercados` que se borra **solo con confirmación del usuario**.
- **Conector de Claude:** vive en el Worker aparte `mercados-mcp` (`src/mcp-worker.ts`, `wrangler.mcp.jsonc`), con OAuth propio (`@cloudflare/workers-oauth-provider`). Tu correo se confirma en la app, ruta `/conector/identidad`, detrás de Access. Se descartó *Managed OAuth* de Access porque falla en claude.ai web y móvil (anthropics/claude-ai-mcp#410). Por ahora es solo para el dueño. `mercados-mcp` tiene sus propios secretos (`OWNER_EMAILS`, `LOGIN_LINK_SECRET`, que debe ser igual en ambos Workers, `TWELVE_DATA_API_KEY`, `FRED_API_KEY` y el opcional `FINNHUB_API_KEY`). Las pruebas del login completo están en `test/mcp-worker.test.ts`; en Node, `cloudflare:workers` se reemplaza con `test/stubs/`.
- **Compartida con amigos.** Los términos de Twelve Data (plan gratis) no permiten mostrar sus datos a terceros ni compartir la clave. Por eso hay dos roles: el **dueño** (`OWNER_EMAILS`) ve todo y los **amigos** ven los datos públicos. El bloqueo es del servidor: 403 en precios, historial y lista, y el conector sin esas herramientas. Pendiente:
  - revisar los términos de FRED (su web estaba en mantenimiento); `FRED_API_KEY` ya está cargada;
  - cargar `FINNHUB_API_KEY` en ambos Workers para prender los resultados de empresas.
- **Precios con la clave de cada uno** (`game/panel.ts`, 4 nov, pedido del usuario: que los chicos «puedan ver toda la info»). Un amigo que conectó su clave gratis de Twelve Data (la misma de la liga: una para todo) ve su propia lista, sus precios, la ficha, comparar, el termómetro y los titulares por acción. Las rutas son las del dueño (`FRIEND_KEYED` en `index.ts`), pero las atiende el Durable Object del juego con la clave de esa persona. Reglas:
  - **Cada persona tiene su caché**, con el prefijo `pn:<pid>:` en el Durable Object. **Nunca le muestres a alguien lo que trajo la clave de otro**, ni las cachés de la KV del dueño (`quotes`, `hist5:`…): eso sería mostrar datos de Twelve Data a terceros. Va en el Durable Object y no en la KV por el cupo: 100.000 escrituras al día contra 1.000 para toda la cuenta.
  - La clave nunca sale del Durable Object (`Acciones.ownKey`, que nunca devuelve la de Rueda). Al quitarla (`disconnect`) se borra lo que trajo; su lista queda.
  - **Siguen siendo solo del dueño**, aunque el amigo tenga clave: Finnhub (`/api/company`, los resultados del calendario), la lista diaria, la cartera simulada y los precios para valorizar Hapi.
  - En el panel, lo que se abre con la clave va con la clase `keyed` (`body.con-clave`); `owner-only` sigue siendo solo del dueño.
- **Quién entra: «Personas»** (`services/people.ts`, `lib/access-api.ts`). La lista la maneja el dueño en el panel y vive en KV (`personas`); el secreto `ALLOWED_EMAILS` es la lista vieja y solo se usa mientras ese registro no exista. Los dueños (`OWNER_EMAILS`) siempre entran. Cada cambio se copia a Cloudflare Access con `ACCESS_API_TOKEN` (un solo permiso: «Access: Apps and Policies → Edit»), reescribiendo solo las reglas *Emails* de la política «Personas de Rueda» o, si no hay, de la única que deja entrar por correo. Reglas:
  - **No pidas un permiso más amplio** (por ejemplo, el de grupos e identidades: con él se podría agregar otro proveedor de identidad y entrar como el dueño).
  - **Nunca dejes la política sin correos** y nunca toques las demás reglas ni políticas.
  - **Los correos van en el cuerpo de los pedidos, no en la URL** (las URLs quedan en los registros).
  - **La lista se revisa en cada pedido** (es la segunda capa si Access queda abierto por error). Cada instancia la recuerda 30 s, así que quitar a alguien tarda hasta un minuto.
