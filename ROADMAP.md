# Roadmap de Rueda (antes «Mercados»)

Actualizado el 22 de octubre de 2026. Lo que ya está hecho se describe en el README y en el historial de git; aquí va lo que falta, en orden.

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
- [ ] **`FINNHUB_API_KEY`:** crear la clave gratis en finnhub.io y cargarla como Secret en `mercados` y en `mercados-mcp`. Sin ella, los resultados de empresas quedan apagados (el resto funciona igual).
- [ ] **Reconectar el conector en claude.ai** para que aparezcan las herramientas nuevas (`comparar`, `cartera`, `noticias` y `calendario`).
- [ ] **Probar en el celular** la medición con dos dedos: hasta ahora solo se probó simulada.

## 5. Al final: abrir la app a los chicos del grupo

Solo cuando las secciones 1 a 4 estén terminadas.

- [ ] **Revisar los términos de FRED** antes de mostrarles sus datos.
- [ ] **Acceso con código por correo.** Hoy Access pide una cuenta de Cloudflare.
  1. Zero Trust → **Integrations → Identity providers** → **Add new identity provider** → **One-time PIN**.
  2. **Access controls → Applications** → la app de `mercados.mercados.workers.dev`. Edita esa misma, no crees otra: una app nueva cambia el AUD y la app dejaría de dejarte entrar.
  3. En sus métodos de inicio de sesión, marca **One-time PIN**. En **Policies**, agrega una regla **Include → Emails** con tu correo y los de tus amigos.
  4. Workers & Pages → mercados → Settings → Variables and Secrets: reescribe **`ALLOWED_EMAILS`** con la lista completa, incluido tu correo. `OWNER_EMAILS` queda solo con el tuyo.
  5. Prueba en una ventana de incógnito. El código llega de `noreply@notify.cloudflare.com` y vale 10 minutos.
- [ ] **Probar la vista de amigo** con el correo de uno de ellos: debe ver solo los datos públicos (Perú, EE. UU., cobre, oro, BVL, reservas, calendario y la cinta pública).
- [ ] **Pasarles la dirección** y avisarles que entran con su correo y un código.

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

## 8. Lo elegido tras comparar Rueda con otras apps — en curso

El 22 de octubre se comparó Rueda con Yahoo Finance, Google Finance, TradingView, Investing.com, Koyfin, Delta, Stock Events y lo que hay en el Perú (Trii, la app de la SMV, TuCambista, Rextie).

- **Lo propio de Rueda:** el Perú en una pantalla con fuentes oficiales (BCRP), el conector para Claude con tus datos, el calendario con fechas del Perú en hora de Lima, exportar a Excel gratis (Yahoo lo cobra), la matriz de correlación, y nada de anuncios.
- **Elegido por el usuario:**
  - [x] **Datos de la empresa** en la ficha (Finnhub, solo el dueño): PER, capitalización, beta, dividendo, márgenes, recomendación de analistas, sorpresas de BPA de los últimos 4 trimestres y comparables. Al cargar la clave, comparar el PER y la capitalización de BAP con Yahoo o Google: Credicorp reporta en soles y Finnhub podría mezclar monedas en las ADR.
  - [x] **Velas, volumen y MACD** en la ficha. Volumen verificado contra Nasdaq y MACD contra Twelve Data.
  - [ ] **Lista ampliada** de más de 8 símbolos, actualizada una vez al día después del cierre (1 crédito por símbolo al día).
- **No elegido por ahora** (queda en ideas): alertas al celular por Telegram, pronósticos del grupo (juego sin plata con datos públicos, para los amigos), gráfico del día (1D y 5D), reportes oficiales de la SEC y la SMV, dividendos en la cartera simulada.
- **Descartado:** buscador de acciones, mapa de calor y lo que más sube o baja (necesitan datos de todo el mercado, que no entran en ningún plan gratis); IA dentro de la app (el conector ya lo hace); widgets del celular (necesitan una app nativa).

## 9. Ideas para después

- **Alertas al celular por Telegram:** precio, % del día, dólar, MM200/RSI y «mañana presenta resultados». Tarea programada cada 15 min con la bolsa abierta, unos 100–150 créditos al día. Es lo que tienen todas las apps comparadas y Rueda no.
- **Pronósticos del grupo:** cada amigo pronostica, sin plata, la tasa del BCRP, la inflación o el dólar del viernes, con ranking. Solo datos públicos, así que los amigos pueden jugar.
- **Gráfico del día** (1D y 5D): 1 crédito cada 5 min, solo con la ficha abierta.
- **Reportes oficiales:** SEC (6-K, 10-Q), gratis y públicos; hechos de importancia de la SMV, falta probar si su web deja leerse.
- **Dividendos en la cartera simulada:** anotados a mano (Finnhub los cobra).
- Que cada amigo use su propia clave gratis de Twelve Data (lista y caché por persona) para que también vea precios.
- Reportes financieros de empresas de EE. UU. (SEC EDGAR).
- **Valor cuota de las AFP:** la SBS lo muestra detrás de una verificación anti-robots (Imperva) y no se puede leer desde el Worker. Queda el archivo mensual de la SBS (xlsx de ~1 MB), sin probar.
- Medir el gasto de créditos de Twelve Data en un día normal y ajustar el freno si hace falta.
- Decidir si el repositorio sigue público (hoy lo está) o pasa a privado.
- Herramienta `precios` del conector: aceptar los símbolos también como texto («BAP, SPY»).

## 10. Mantenimiento con fecha fija

- **Cada diciembre:** agregar los feriados y cierres anticipados de la NYSE del año siguiente en `lib/market-hours.ts` (hoy están hasta 2027). Si no se hace, la app gasta créditos en los feriados.
- **Cada año:** cargar el calendario económico del año siguiente cuando las fuentes lo publiquen. El BCRP suele publicar su cronograma en diciembre.
