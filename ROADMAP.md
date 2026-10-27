# Roadmap de Rueda (antes «Mercados»)

Actualizado el 27 de octubre de 2026. Lo que ya está hecho se describe en el README y en el historial de git; aquí va lo que falta, en orden.

**Orden acordado:** primero se termina de implementar todo lo pendiente (secciones 1 a 4). Recién después se configura el acceso para los chicos del grupo (sección 5).

## 1. Nombre e identidad: «Rueda» — hecho el 22 de octubre

Nombre elegido: **Rueda** (por la rueda de bolsa), con la variante **C** del encabezado: el sello más una cinta de precios. Se mantiene el diseño Terminal y solo cambia el nombre visible: la dirección web y los Workers siguen igual.

- [x] **Logo:** una rueda con rayos en cian, junto a «RUEDA». Sirve también como `icon.svg` (pestaña y celular).
- [x] **Estado de la bolsa:** «Rueda abierta» / «Rueda cerrada» en vez de «NYSE abierto» / «NYSE cerrado».
- [x] **Cinta de precios** debajo del encabezado, como la pizarra electrónica de la bolsa:
  - El dueño ve su lista, con los precios de la caché, sin gastar créditos extra.
  - Los amigos ven datos públicos: dólar, cobre, oro y BVL del BCRP, y el bono a 10 años de FRED. Es por la licencia de Twelve Data.
  - Sin movimiento si el sistema pide reducir animaciones (`prefers-reduced-motion`).
- [x] **Cambiar el nombre en:** `<title>`, `.logo`, `manifest.webmanifest` (`name`, `short_name`), `apple-mobile-web-app-title`, README y CLAUDE.md. El nombre del conector en claude.ai se cambia al reconectarlo.
- [x] Publicado directo, a pedido del usuario: se revisa después.

## 2. Terminar la 3C: fechas del calendario económico — hecho el 22 de octubre

El código ya está publicado y probado (`src/lib/calendar.ts`, `/api/calendar`, herramienta `calendario` y sección del panel). Falta cargar las fechas. Mientras `EVENTS` esté vacío, el panel oculta la sección y el conector no ofrece la herramienta.

- [x] Cargar en `EVENTS` las fechas oficiales del resto de 2026 y de 2027, cada una verificada en su fuente. Agregar la hora oficial y su zona horaria cuando la fuente la publique:
  - **BCRP:** cronograma de las sesiones del Directorio sobre el Programa Monetario.
  - **Fed:** reuniones del FOMC (`federalreserve.gov/monetarypolicy/fomccalendars.htm`). El comunicado sale a las 2:00 p. m. hora de Nueva York.
  - **INEI:** informe técnico de precios de Lima Metropolitana.
  - **BLS:** calendario del CPI (`bls.gov/schedule/news_release/cpi.htm`), a las 8:30 a. m. hora de Nueva York.
- [x] Completar `CALENDAR_UNTIL` y la URL exacta de cada calendario en `SOURCES`.
- [x] Publicado directo, a pedido del usuario: se revisa después.

Fechas ya investigadas en las fuentes oficiales el 21 de octubre. Hay que volver a verificarlas antes de cargarlas.

- **BCRP:** 12 de noviembre y 10 de diciembre de 2026, según el cronograma de la nota informativa del 11 de diciembre de 2025. El cronograma de 2027 saldrá en la nota del 10 de diciembre. Ninguna página oficial da la hora del anuncio. No hay que calcularlas por regla: la sesión de octubre de 2026 fue un miércoles.
- **Fed:** 27–28 de octubre y 8–9 de diciembre de 2026. En 2027, tentativas hasta que las confirme la reunión anterior: 26–27 de enero, 16–17 de marzo, 27–28 de abril, 8–9 de junio, 27–28 de julio, 14–15 de setiembre, 26–27 de octubre y 7–8 de diciembre. Las de diciembre de 2026 y las de marzo, junio, setiembre y diciembre de 2027 traen proyecciones económicas.
- **INEI:** 1 de noviembre y 1 de diciembre de 2026, según su calendario oficial (inei.gob.pe/calendario). 2027 todavía no aparece. En la práctica publica el día 1 de cada mes aunque sea fin de semana o feriado, así que 2027 iría como tentativo.
- **BLS:** 10 de noviembre y 10 de diciembre de 2026. En 2027: 13 de enero, 11 de febrero, 10 de marzo, 13 de abril, 12 de mayo, 10 de junio, 14 de julio, 11 de agosto, 14 de setiembre, 14 de octubre, 10 de noviembre y 10 de diciembre.

## 3. Fase 3D: cartera simulada — hecho el 22 de octubre

Las tres preguntas pendientes las respondió Claude con la opción más simple, porque el usuario pidió avanzar sin consultar. Se pueden cambiar:
- **Símbolos:** solo los de la lista que cotizan en dólares (acciones, ETF y cripto); USD/PEN no entra.
- **Soles:** los totales se muestran también en soles, con el USD/PEN de la lista o el dólar del BCRP.
- **Dividendos:** no se cuentan, ni tampoco comisiones.

- [x] Registrar compras y ventas simuladas: fecha, símbolo, cantidad y precio. Sin precio, usa el cierre de ese día.
- [x] Mostrar el valor actual, la ganancia o pérdida y el rendimiento, comparados con haber hecho las mismas operaciones en el S&P 500 (SPY).
- [x] Exportar a CSV y consultarla desde el conector (herramienta `cartera`).
- [x] Solo para el dueño, porque usa precios de Twelve Data.
- [x] Publicado directo, a pedido del usuario: se revisa después.

## 4. Ajustes tuyos que no dependen de los amigos

- [x] **`FRED_API_KEY`** cargada el 22 de octubre. Verificada en el conector: bono a 10 años 5,12 % (20 oct), tasa de la Fed 3,88 % e inflación anual 3,72 % (setiembre).
- [x] **`FINNHUB_API_KEY`** cargada. Verificada el 23 de octubre con el conector: resultados de SCCO (26 oct) y BVN (28 oct) en el calendario, y datos de SCCO coherentes (capitalización US$ 155.013 millones / 844 millones de acciones ≈ US$ 184; PER 28 × BPA 6,81 ≈ US$ 190).
- [x] **Conector reconectado en claude.ai** (23 oct): ya aparecen `comparar`, `cartera`, `empresa`, `lista_diaria`, `noticias` y `calendario`.
- [ ] **Probar en el celular** la medición con dos dedos: hasta ahora solo se probó simulada.

## 5. Abrir la app a los chicos del grupo — la app está lista (26 de octubre); faltan los pasos del panel

- [x] **Términos de FRED** revisados (26 oct): se pueden mostrar sus datos a otras personas si la app muestra el enlace a sus términos, sus usuarios los aceptan y hay política de privacidad. Hecho: pie con el aviso exacto («This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.»), el enlace y la página `/terminos.html` (términos y privacidad). Las series usadas (DGS*, DFF, DFEDTAR*, CPIAUCSL) son de dominio público; solo piden citar la fuente (Junta de la Reserva Federal y BLS).
- [x] **Vista de amigo probada en local** (`DEV_ROLE=friend`): bienvenida, noticias, Mi cuenta Hapi, Perú, EE. UU., mercados del Perú, resultados de empresas, calendario y pronósticos; sin errores y sin pedidos a rutas del dueño.
- [ ] **Acceso con código por correo** (panel de Cloudflare, lo hace el dueño):
  1. Zero Trust → **Integrations → Identity providers**: que exista **One-time PIN** (la pantalla de entrada ya muestra «Send login code», así que probablemente ya está).
  2. **Access controls → Applications** → la app de `mercados.mercados.workers.dev`. Edita esa misma, no crees otra: una app nueva cambia el AUD y la app dejaría de dejarte entrar. Opcional: cámbiale el nombre a «Rueda» (es lo que dice la pantalla de entrada) y sube la duración de la sesión (por ejemplo, 1 mes) para que no pidan código a cada rato.
  3. En sus métodos de inicio de sesión, marca **One-time PIN**. En **Policies**, en la regla que permite entrar, agrega **Include → Emails** con los correos de los chicos (y el tuyo).
  4. Workers & Pages → mercados → Settings → Variables and Secrets: reescribe **`ALLOWED_EMAILS`** con la lista completa, incluido tu correo, separados por comas. `OWNER_EMAILS` queda solo con el tuyo.
  5. Prueba en una ventana de incógnito con un correo de la lista que no sea el tuyo. El código llega de `noreply@notify.cloudflare.com` (a veces a spam) y vale 10 minutos.
  - **Si a alguien no le llega el código:** Cloudflare solo lo manda si el correo está en la política de Access, pero la pantalla dice «A code has been emailed» igual. Revisa que su correo esté en la regla (paso 3), que mire en spam y que use el último código: pedir otro anula el anterior. Si le llega pero Rueda le dice «Entraste con …, pero ese correo no está en la lista», falta en `ALLOWED_EMAILS` (paso 4). El 26 de octubre se pidió un código de prueba para el correo del dueño.
- [ ] **Pasarles la dirección** (https://mercados.mercados.workers.dev) y avisarles: entran con su correo y un código; la frase de su cuenta Hapi no se puede recuperar.
- Opcional, después: abrir el conector de Claude a los amigos (hoy `/conector/identidad` solo deja pasar al dueño; ellos verían solo las herramientas públicas).

## 6. Noticias — hecho el 22 de octubre

Se adelantaron a pedido del usuario: quedaron hechas antes de abrir la app a los amigos. Ese mismo día se aplicó la opción B de legibilidad: base de 15 px, nada por debajo de 12 px, frases en IBM Plex Sans y ayudas detrás de un «?».

Primero el mercado en general, después cada acción. Fuentes probadas el 22 de octubre: todas respondieron con titulares del día, gratis y sin claves.

- **Mercado en general:**
  - Bloomberg: `feeds.bloomberg.com/markets/news.rss`.
  - WSJ: `feeds.content.dowjones.io/public/rss/RSSMarketsMain`.
  - MarketWatch: `feeds.content.dowjones.io/public/rss/mw_topstories`.
  - CNBC: `cnbc.com/id/100003114/device/rss/rss.html`.
- **En español y del Perú:**
  - Bloomberg Línea: `bloomberglinea.com/arc/outboundfeeds/rss/?outputType=xml`.
  - Gestión: `gestion.pe/arc/outboundfeeds/rss/?outputType=xml`.
- **Por acción:**
  - Yahoo Finance, por símbolo: `feeds.finance.yahoo.com/rss/2.0/headline?s=BAP&region=US&lang=en-US`.
  - Google News, por nombre de empresa y en español: `news.google.com/rss/search?q=Credicorp&hl=es-419&gl=PE&ceid=PE:es-419`.
- **No sirve:** las noticias de Twelve Data. Para BAP devolvieron un comunicado genérico de la NYSE, de hace un año, que no trataba de BAP.

Pasos:
- [x] **Mercado en general:** una sección «Noticias» con lo último de las fuentes elegidas y filtros Perú, EE. UU. y mundo.
  - Muestra titular, medio, hora y enlace, nunca la nota completa (Bloomberg y WSJ tienen muro de pago).
  - El servidor lee los RSS cada 30 minutos y guarda todo en un solo registro de KV: unas 48 escrituras al día.
  - Es pública: también la ven los amigos.
- [x] **Por acción:** en la ficha de cada símbolo, los titulares de Yahoo y Google News sobre esa empresa, filtrados por medios confiables. Más adelante, las fuentes oficiales: hechos de importancia de la SMV y reportes 8-K de la SEC.
- [x] **Conector:** una herramienta `noticias` para preguntarle a Claude qué movió al mercado o a una acción, cruzando titulares con precios.

## 7. Después de las noticias — hecho el 22 de octubre

Elegidos por el usuario el 22 de octubre, antes de abrir la app a los amigos:

- [x] **Cartera en los gráficos:** tus compras y ventas marcadas en la ficha, y señales en la lista (MM200 y RSI extremo).
- [x] **Más Perú:** bonos del Perú a 10 años en soles y en dólares, y un riesgo país aproximado (el EMBIG del BCRP está detenido desde setiembre).
- [x] **Resultados de tus empresas:** fechas de resultados trimestrales de la lista en el calendario, en la ficha y en la lista, con Finnhub. Twelve Data los cobra (plan Grow o mayor); Finnhub los da gratis con clave propia, pero sus términos no permiten mostrarlos a terceros: son solo para el dueño. Queda apagado hasta cargar `FINNHUB_API_KEY` (sección 4). Para comprobarlo: Credicorp confirmó sus resultados del 3T26 para el lunes 9 de noviembre de 2026.

## 8. Lo elegido tras comparar Rueda con otras apps — hecho el 22 de octubre

El 22 de octubre se comparó Rueda con Yahoo Finance, Google Finance, TradingView, Investing.com, Koyfin, Delta, Stock Events y lo que hay en el Perú (Trii, la app de la SMV, TuCambista, Rextie).

- **Lo propio de Rueda** (al 22 de octubre; la lista al día está en la sección 8f): el Perú en una pantalla con fuentes oficiales (BCRP), el conector para Claude con tus datos, el calendario con fechas del Perú en hora de Lima, exportar a Excel gratis (Yahoo lo cobra), la matriz de correlación, y nada de anuncios.
- **Elegido por el usuario:**
  - [x] **Datos de la empresa** en la ficha (Finnhub, solo el dueño): PER, capitalización, beta, dividendo, márgenes, recomendación de analistas, sorpresas de BPA de los últimos 4 trimestres y comparables. Pendiente si BAP vuelve a la lista (hoy está VTI en su lugar): comparar su PER y capitalización con Yahoo, porque Credicorp reporta en soles y Finnhub podría mezclar monedas en las ADR.
  - [x] **Velas, volumen y MACD** en la ficha. Volumen verificado contra Nasdaq y MACD contra Twelve Data.
  - [x] **Lista ampliada** («Lista diaria»): hasta 20 símbolos más, actualizados una vez al día después del cierre por una tarea programada (1 crédito por símbolo al día). Falta verla funcionar en producción tras el primer cierre.
- **No elegido por ahora** (queda en ideas): alertas al celular por Telegram, gráfico del día (1D y 5D), reportes oficiales de la SEC y la SMV, dividendos en la cartera simulada. Los pronósticos del grupo se hicieron después (sección 8b).
- **Descartado:** buscador de acciones, mapa de calor y lo que más sube o baja (necesitan datos de todo el mercado, que no entran en ningún plan gratis); IA dentro de la app (el conector ya lo hace); widgets del celular (necesitan una app nativa).

## 8b. Pronósticos del grupo — hecho el 23 de octubre

Elegido por el usuario antes de abrir la app a los chicos, con las opciones recomendadas: preguntas de tasas (BCRP y Fed), inflación (Lima y EE. UU.) y dólar a fin de mes; hasta 10 puntos por pregunta; lo de los demás oculto hasta el cierre.

- [x] Preguntas automáticas desde el calendario, nombre para el ranking, pronósticos ocultos hasta el cierre, consenso, puntos y ranking.
- [x] Resolución automática con la tarea programada (BCRP, FRED e INEI vía BCRP).
- [x] Conector: herramienta `pronosticos` (solo lectura).
- [ ] Ver resolverse en producción la primera pregunta: la decisión de la Fed del 28 de octubre (se resuelve desde el 29).

## 8c. Lo elegido tras mirar apps de pago — hecho (23 de octubre)

Ideas sacadas de Bloomberg, Morningstar, Seeking Alpha, Simply Wall St y TradingView. El usuario eligió las siete:

- [x] **Expectativas de los analistas** (encuesta del BCRP), públicas, también en el juego.
- [x] **Curva de rendimientos** de EE. UU. (FRED), pública. El BCRP no publica más plazos que el bono a 10 años.
- [x] **Estacionalidad** en la ficha (rendimiento de cada mes por año, promedio y meses en alza).
- [x] **Probar una estrategia**: cruce de medias 50/200 o 20/50, o RSI 30/70, frente a comprar y mantener.
- [x] **Rayos X de la cartera** (sector, país, beta, volatilidad, concentración y correlaciones).
- [x] **Notas por factores A–F** frente a las comparables (Finnhub), con el detalle de cada indicador.
- [x] **Historia financiera** desde la SEC (hasta 12 años), pública: sección para todos con cualquier símbolo, bloque en la ficha y herramienta `resultados_anuales` en el conector.

## 8d. Hapi, el bróker del grupo — hecho (23 de octubre)

Hapi no tiene API pública ni exporta CSV: solo PDF (estado de cuenta mensual que emite Apex Clearing y una confirmación por operación, también por correo). Leer la cuenta con usuario y contraseña quedó descartado (términos y seguridad). El usuario eligió que **nadie más vea su cuenta** (sin liga del grupo).

- [x] **Mi cuenta Hapi a mano**: compras, ventas, dividendos, depósitos y retiros con las comisiones de Hapi de 2026; rendimiento en US$ y en soles. Precios de mercado solo para el dueño.
- [x] **Cifrada en el navegador con la frase de cada uno** (elegido por el usuario para que ni él pueda ver las cuentas de los demás): el servidor solo guarda texto ilegible. Se quitó la herramienta `cuenta_hapi` del conector, que ya no puede leerla.
- [x] **Versión publicada al pie** (commit, con enlace a GitHub), para que cualquiera revise el código que corre.
- [x] **Enlace «Ver en Hapi»** en la ficha y en «Resultados de empresas» (página pública; Hapi no tiene enlaces que abran la app).
- [x] **Leer el estado de cuenta mensual (PDF)** en el navegador con pdf.js: periodo, valor total, posiciones y movimientos, con vista previa. Probado con el estado real de setiembre de 2026 del usuario (11 posiciones y 7 dividendos, cuadran con los totales).
- [x] **Valor de la cuenta con los precios del último estado de cuenta** (26 oct), para los que no reciben precios en vivo: cada importación guarda los precios de cierre en la cuenta cifrada. Reimportar el mismo mes ya no repite los movimientos del saldo inicial.
- [x] **iPad** (26 oct): un amigo no pudo importar su estado de cuenta en iPad. Causa más probable: pdf.js 6 pide Safari 18 y no trae el reemplazo de `Promise.withResolvers`; se volvió a pdf.js 4.10.38 (Safari 16.4+, mismo resultado con el estado real), con aviso claro para equipos más viejos y la indicación de guardar el PDF en Archivos en iPhone o iPad. Falta que el amigo lo confirme.
- [ ] Ver en un estado real cómo vienen las compras, ventas y depósitos (setiembre solo traía dividendos) y ajustar el lector si hace falta.
- [ ] Idea: reporte anual para la declaración de impuestos (ganancias realizadas y dividendos en soles, con el tipo de cambio de cada fecha). Solo cálculos: el tratamiento tributario lo decide un contador.

## 8e. Rueda como app — hecho el 26 de octubre

El usuario pidió poder bajar la app desde Rueda. Lo realista es una **app web instalable**: se instala desde el navegador, sin tienda, gratis, en iPhone, iPad, Android y computadora, y se actualiza sola con cada push.

- [x] Botón **«Instalar app»** en la barra: abre el diálogo de Chrome o Edge si lo ofrecen; si no, los pasos de cada equipo (en iPhone y iPad, Compartir → «Agregar a inicio»). Abierta como app no aparece.
- [x] Íconos PNG (192, 512, «maskable» para Android y el de iPhone) con el dibujo de la rueda, manifiesto completo y un service worker mínimo que solo muestra un aviso sin conexión (no guarda nada).
- [ ] **Probarla en un iPhone o iPad:** agregarla a inicio, abrirla desde el ícono y entrar con el código **dentro de la app** (no comparte la sesión con Safari). Y en un Android: menú → «Instalar app».
- [ ] **Subir la duración de la sesión de Access** (sección 5, paso 2; por ejemplo, 1 mes): con la app instalada, una sesión corta pide el código a cada rato. Si se pierde un celular, la sesión se corta desde Zero Trust.
- **Descartado por ahora:**
  - **APK de Android** (TWA, con PWABuilder o Bubblewrap): se puede armar desde Windows y pasar como archivo (o subir a Play Store por US$ 25), pero aporta poco: Chrome ya instala una app de verdad. Además pide dejar `/.well-known/assetlinks.json` fuera de Access.
  - **App Store o TestFlight:** US$ 99 al año, una Mac con Xcode y la revisión de Apple, que suele rechazar apps que solo muestran una web. No es realista para un grupo de amigos.
  - **App nativa nueva:** meses de trabajo para lo mismo.
- Idea: **notificaciones** de la app instalada (alertas de precio, resultados, pronósticos que cierran). En iPhone y iPad solo funcionan con la app agregada a inicio (iOS 16.4 o más nuevo). Necesitan claves VAPID (secreto) y guardar las suscripciones en KV.

## 8f. Comparación del 27 de octubre: lo propio de Rueda y funciones posibles

El 27 de octubre se repitió la comparación con más de 50 apps: las de las secciones 8 y 8c, más Getquin, Snowball, Sharesight, Parqet, Ghostfolio, Portfolio Performance, Kubera, Wealthfolio, Robinhood, Webull, moomoo, eToro, Public, Trading 212, Revolut, Finviz, Stock Analysis, Fiscal.ai, TIKR, Quartr, Dataroma, WhaleWisdom, Quiver, OpenInsider, Stocktwits, Kalshi, Polymarket, Manifold, Metaculus, Good Judgment Open, Hapi, Tyba, Fintual, Racional, IOL, Balanz, Lemon, Bitso, Kambista, Tkambio, cuantoestaeldolar.pe, Comparabien, BCRPData y Bolsapp. Todavía no hay nada elegido.

### Lo propio de Rueda

**Ninguna de las apps revisadas lo tiene:**
- **Pronósticos del grupo:** un juego sin plata sobre tasas, inflación y dólar.
  - Se resuelve solo con datos oficiales, tiene ranking y se compara con la encuesta de expectativas del BCRP.
  - Lo más cercano son los concursos de cartera simulada: Wall Street Survivor, TradingView, moomoo y la liga de Trii con la Bolsa de Colombia.
  - También Manifold, con dinero ficticio, pero cada pregunta se resuelve a mano y no hay datos del Perú. Kalshi y Polymarket son con plata real.
- **Tu cuenta Hapi en tu navegador:**
  - Lee el estado de cuenta en PDF sin subirlo y lo cifra con tu frase: ni el dueño lo ve.
  - Aplica las comisiones y retenciones de Hapi y da el rendimiento en soles.
  - Ninguna app sincroniza Hapi (SnapTrade y Plaid no lo cubren).
  - Google Finance importa carteras desde un PDF o una captura, pero subiéndolos a Google. Portfolio Performance y Parqet leen los PDF de otros brókeres. Wealthfolio cifra en el equipo, pero no lee PDF.
- **El Perú oficial y EE. UU. en una pantalla:**
  - Del BCRP: dólar, tasa, inflación, cobre, oro, reservas, BVL, bonos, riesgo país aproximado y expectativas. Junto a eso, FRED y la SEC.
  - Lo más cercano: la app BCRPData (solo iOS, sin mercados de EE. UU.), TradingView (algunas series del Perú) y Bolsapp de Coril (BVL y EE. UU., sin datos de la economía).

**Otras lo cobran y en Rueda es gratis:**
- Descargar el historial a Excel: Yahoo lo da con Gold (US$ 39,95 al mes).
- Rayos X de la cartera (Morningstar Investor) y notas por factores A–F (Seeking Alpha Premium, Simply Wall St). En Rueda, solo para el dueño.
- Sin anuncios: las versiones gratis de Yahoo, Investing.com y TradingView los tienen.

**Otras lo tienen por separado; Rueda lo junta en español para el grupo:**
- Calendario con fechas oficiales en hora de Lima, los resultados de tu lista y las preguntas del juego.
- Ficha completa: velas, MACD, estacionalidad (TradingView la da gratis con 3 años), probar una estrategia, medir entre dos días y correlación.
- Historia financiera de 12 años de la SEC, también para los amigos. Morningstar y Seeking Alpha la cobran; Macrotrends y Stock Analysis la dan gratis, con anuncios.
- Noticias del Perú y de Wall Street, app instalable sin tienda y código público con la versión al pie.
- **El conector para Claude ya no es exclusivo.** En 2026 sacaron el suyo Hapi (beta cerrada, solo lectura), Robinhood, Webull, eToro, Public, TradingView (de pago), Morningstar, Kubera y Parqet. Lo propio del de Rueda es lo que trae: el Perú oficial, el juego y tu lista.

### Funciones posibles (sin elegir)

Entre paréntesis, la opinión de Claude: **Sí**, Tal vez o No.

**Para todos, con datos públicos:**
1. **Reportes y avisos oficiales** en la ficha y el calendario (**Sí**).
   - De la SEC: 8-K, 6-K, 10-Q, 20-F y avisos de compras y ventas de directivos.
   - De la SMV: hechos de importancia de Southern, Credicorp, Buenaventura, IFS y otras.
   - Lo tienen Yahoo (SEC), la app de la SMV y Bolsapp.
   - Datos probados el 27 oct: `data.sec.gov/submissions` (100–165 KB por empresa) y la API de datos abiertos de la SMV (`mvnet.smv.gob.pe/SMV.OData.Api/api/registro/HechosSMVEmisor`: 118 hechos en una semana, 49 KB).
2. **«¿Le ganaste a…?»:** tu cuenta Hapi en soles frente al plazo fijo, tu AFP, la inflación y el dólar (**Sí**).
   - Comparabien compara depósitos y AFP, pero sin tu cartera; Snowball lo cobra.
   - Datos del BCRP: tasas de depósito (`PN07814NM`, `PN07815NM`) y rentabilidad real a 12 meses de cada AFP (`PN01179MM`–`PN01182MM`; falta confirmar de qué fondo es).
   - Se calcula en el navegador, así que la cuenta sigue cifrada.
3. **Máquina del tiempo en soles:** «si hubieras puesto S/ 1.000 hace 5 años en dólares, plazo fijo, oro, cobre o una AFP» (**Sí**).
   - La tienen Racional (Chile) y Lightyear.
   - Datos del BCRP. El S&P 500 de FRED tiene derechos de S&P: no puede ir para los amigos.
4. **Juego: temporadas y «¿por qué?»** (**Sí**).
   - Campeón de cada mes.
   - Una explicación de hasta 280 caracteres que se ve al cierre.
   - Puntaje frente a la mediana del grupo y curva de calibración tras 20 pronósticos.
   - Lo tienen Good Judgment Open, Metaculus y Manifold.
5. **Juego: preguntas nuevas** (**Sí**).
   - Cobre, oro, BVL y bono a 10 años a fin de mes (BCRP).
   - Desempleo de EE. UU. (BLS, dominio público).
   - Votos disidentes en la Fed.
   - «¿Crecerá el BPA de X?» (se resuelve con la SEC).
6. **Juego: probabilidades.** Cada uno reparte 100 % entre sube, mantiene y baja; los puntos son 10 × (1 − Brier/2), como en Metaculus y Good Judgment Open. (Tal vez: es más justo, pero más difícil de explicar.)
7. **Costo de pasar plata a Hapi** (**Sí**).
   - Compara depositar en soles (US$ 1,99), en dólares (0,45 %, mínimo US$ 2,99) o cambiar antes en una casa de cambio, frente al dólar SBS.
   - Retiros: US$ 4,99 en soles o 7,99 en dólares.
   - Kambista y Tkambio muestran «lo que ahorras frente al banco».
   - Datos: el dólar SBS del BCRP (`PD04639PD`/`PD04640PD`, el que usa la SUNAT) y el tipo de cambio que escribas, porque las casas de cambio no publican API o prohíben leerlas con programas.
8. **Calendario en Google Calendar o el iPhone** (enlace .ics) con decisiones, datos y cierres del juego. Lo tiene Parqet. Access no deja pasar a Google Calendar, así que el enlace viviría en el Worker del conector, secreto y por persona. (Tal vez)
9. **Termómetro de riesgo:** estrés financiero de la Fed de St. Louis (`STLFSI4`), regla de Sahm y probabilidad de recesión, de FRED (Tal vez).
   - Reemplaza al Fear & Greed de CNN.
   - El NFCI (Fed de Chicago) y el VIX son de terceros: solo para el dueño.
10. **Buscador por fundamentos, sin precios:** crecimiento, margen, ROE, deuda y el puntaje Piotroski de 0 a 9. (Tal vez: el esfuerzo es alto, porque cada empresa usa etiquetas contables distintas.)
    - Lo tienen Finviz, Stock Analysis y TIKR.
    - La API «frames» de la SEC trae todas las empresas en un pedido (400–900 KB): se calcularía en la tarea programada.
11. **Cortes y feriados para Hapi:** feriados de la NYSE y del Perú, y la hora de corte de los depósitos en hora de Lima. La ayuda de Hapi da dos horas de corte distintas: hay que confirmarla. (Tal vez)

**Con datos con licencia (solo para el dueño, salvo el último):**

12. **Alertas al celular** (**Sí**: es lo que tienen todas).
    - Para el dueño: precio, % del día, MM200/RSI y «mañana presenta resultados». Para todos: el dólar del BCRP y «cierra tu pronóstico».
    - Con la app instalada ya se pueden mandar notificaciones (en iPhone, desde iOS 16.4 y agregada a inicio). Telegram sigue siendo otra opción.
    - Revisar cada 15 minutos con la bolsa abierta cuesta unos 100–150 créditos al día.
    - Lo tienen Yahoo, Investing.com, TradingView, Delta, Stock Events y Hapi Prime (US$ 9,99 al mes).
13. **Resumen semanal** por la misma vía: dólar, calendario, noticias y tu lista. Lo tienen Google Finance (2026), Snowball y Robinhood Gold. (Tal vez, junto con las alertas)
14. **Compras de directivos (insiders).** Finnhub las da gratis según su documentación (`/stock/insider-transactions`); los amigos solo verían que hubo un aviso (punto 1). Lo tienen OpenInsider, Finviz y Yahoo. (Tal vez)
15. **Probabilidades del mercado junto al juego** (Tal vez, o solo un enlace).
    - Polymarket tiene API sin clave, pero sus términos dan una licencia personal: para el dueño sí; para los amigos es zona gris.
    - Kalshi prohíbe mostrar sus datos.
    - Google Finance las muestra desde noviembre de 2025.
16. **PER histórico** con el precio de Twelve Data y el BPA de la SEC. Lo tienen Macrotrends y TIKR. (Tal vez)
17. **Gráfico del día (1D y 5D):** 1 crédito cada 5 minutos, solo con la ficha abierta. (Tal vez)
18. **Dividendos en la cartera simulada:** Twelve Data los da desde el plan Grow (comprobado el 27 oct), así que irían a mano. (Tal vez)
19. **Precios para los amigos con su propia clave gratis de Twelve Data,** desde su navegador, con lista y caché por persona. (Tal vez)

**Sin datos externos: cálculos y grupo:**

20. **Metas y aportes mensuales:** «¿cuánto tendré en 5 años con S/ 300 al mes?», con la inflación del BCRP; también metas del grupo. Lo tienen Tyba, Fintual, GBM, Getquin y Kubera. (**Sí**, es barata)
21. **Rendimiento real de tu cuenta Hapi** (**Sí**).
    - Una rentabilidad que no se infla con los depósitos (ponderada por tiempo y por dinero), el Sharpe y la peor caída.
    - Hoy Rueda da la ganancia sobre el costo.
    - Lo tienen Portfolio Performance y Snowball.
22. **Exportar tu cuenta Hapi a CSV,** para Portfolio Performance, Parqet o la declaración. (**Sí**, es barata)
23. **Modo privado:** ocultar los montos con un toque, para mostrar la pantalla al grupo. Lo tienen muchas apps de bancos y brókeres. (**Sí**, es barata)
24. **Rebalanceo con aportes:** «con S/ 500, ¿qué compro para volver a mis pesos?». Lo tienen Snowball y Portfolio Performance. (Tal vez)
25. **Patrimonio total:** AFP, CTS, ahorros y cripto, cifrados como la cuenta Hapi. Lo tienen Kubera y Getquin. (Tal vez)
26. **Ideas del grupo:** una tesis corta por acción, visible para el grupo, como las ideas de TradingView o las narrativas de Simply Wall St. (Tal vez)
27. **Compartir solo porcentajes y el promedio del grupo,** si cada uno lo activa. Lo tienen Robinhood Social, Snowball, Kubera y Getquin. Necesita la decisión del dueño: hoy nadie ve nada de la cuenta de otro. (Tal vez)

**Si Rueda tuviera un correo propio para la SEC:**

28. `www.sec.gov` pide un correo en el User-Agent (Tal vez).
    - Con uno creado solo para Rueda, no el personal, se abrirían los montos de las compras de directivos para todos y las carteras 13F de grandes inversores (como en Dataroma, WhaleWisdom o GuruFocus).
    - El correo lo crea el dueño.

**Descartado el 27 oct:**
- **Mapa de calor y «lo que más sube»:** Twelve Data los da desde el plan Pro (comprobado), y no hay una fuente gratis que se pueda mostrar.
- **Liga de carteras simuladas entre amigos:** ningún plan gratis de precios permite mostrarlos a terceros. En su lugar, temporadas del juego (punto 4).
- **Kalshi, volumen en corto de FINRA y lo más comentado en Reddit:** sus términos no lo permiten o no los publican.
- **Operaciones de congresistas:** solo dicen quién y cuándo, en PDF.
- **ETF por dentro (solapamiento):** los datos de la SEC vienen en archivos de 230–690 MB.
- **Carteras modelo:** se leerían como recomendación.
- **Transcripciones de llamadas:** Google Finance las da gratis desde noviembre de 2025; basta un enlace.
- Siguen descartados la IA dentro de la app y los widgets.

**Novedad útil para el grupo:** Hapi tiene en beta cerrada su conector para Claude, ChatGPT y Cursor (`mcp.hapi.trade/mcp`). Es de solo lectura y el permiso dura 30 días, así que cada uno podría preguntarle a Claude por su cuenta real. Rueda no puede usarlo.

**Para revisar:** la página de precios de Twelve Data describe el plan gratis como «Internal non-display usage» y pone «Internal display data access» recién en Grow. En cambio, sus términos permiten mostrar los datos a los «Authorized Users» (§2.2 b). Para un panel personal es zona gris: conviene preguntarles por correo.

## 9. Ideas para después

Las funciones posibles, con quién las tiene y de dónde saldrían los datos, están en la sección 8f: alertas, gráfico del día, reportes oficiales, dividendos y precios para los amigos. Además:

- **Valor cuota de las AFP:** la SBS lo muestra detrás de una verificación anti-robots (Imperva) y no se puede leer desde el Worker. Queda el archivo mensual de la SBS (xlsx de ~1 MB), sin probar. El BCRP sí publica la rentabilidad real a 12 meses de cada AFP (sección 8f, punto 2).
- Medir el gasto de créditos de Twelve Data en un día normal y ajustar el freno si hace falta.
- Revisar la licencia del plan gratis de Twelve Data (sección 8f, «Para revisar»).
- Decidir si el repositorio sigue público (hoy lo está) o pasa a privado.
- Herramienta `precios` del conector: aceptar los símbolos también como texto («BAP, SPY»).

## 10. Mantenimiento con fecha fija

- **Cada diciembre:** agregar los feriados y cierres anticipados de la NYSE del año siguiente en `lib/market-hours.ts` (hoy están hasta 2027). Si no se hace, la app gasta créditos en los feriados.
- **Cada año:** cargar el calendario económico del año siguiente cuando las fuentes lo publiquen. El BCRP suele publicar su cronograma en diciembre.
