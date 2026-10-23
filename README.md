# Rueda (antes «Mercados»)

**Rueda** es el nombre visible desde el 22 de octubre de 2026, por la rueda de bolsa. Los nombres técnicos (Workers `mercados` y `mercados-mcp`, sus direcciones, la KV, el scope OAuth y las claves de localStorage) siguen como «mercados» a propósito: cambiarlos rompería el acceso, el conector y las preferencias guardadas.

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
  - BCRP (BCRPData, sin clave): `PD04637PD`/`PD04638PD` (dólar interbancario compra/venta), `PD12301MD` (tasa de referencia), `PN01273PM` (inflación de Lima a 12 meses), `PD04701XD` (cobre en Londres, en centavos de US$ por libra; se muestra en US$), `PD04704XD` (oro en Londres, US$ por onza troy), `PD04650MD` (reservas internacionales netas, millones de US$), `PD38026MD` (índice general de la BVL), `PD31893DD` y `PD31894DD` (bono del gobierno peruano a 10 años en soles y en dólares) y `PD04719XD` (Tesoro de EE. UU. a 10 años). La API devuelve las series ordenadas por código, no en el orden pedido: `getBcrp` las reacomoda.
  - BCRP, encuesta de expectativas (mensual): `PD12912AM` (inflación esperada a 12 meses), `PD38048AM` (PBI) y `PD38049AM` (tipo de cambio).
  - FRED: `DGS10` (bono del Tesoro a 10 años), `DFF` (tasa de la Fed), `CPIAUCSL` con `units=pc1` (inflación anual), `DFEDTARU`/`DFEDTARL` (rango objetivo de la Fed) y la curva del Tesoro de `DGS1MO` a `DGS30`.
  - Finnhub (opcional, clave gratis propia): `/calendar/earnings` (fechas de resultados trimestrales) y, para la ficha, `/stock/profile2`, `/stock/metric`, `/stock/recommendation`, `/stock/earnings` y `/stock/peers`. Solo para el dueño.
  - SEC EDGAR (sin clave, dominio público): el buscador `efts.sec.gov/LATEST/search-index` (ticker → CIK) y `data.sec.gov/api/xbrl/companyconcept` (un concepto contable por pedido). `www.sec.gov` rechaza a quien no se identifica con un correo, así que no se usa.
- **Caché en KV.** La Cache API no funciona en Workers detrás de Access, así que todo se guarda en KV (plan gratis: 1.000 escrituras/día).
  - Precios: el panel pide cada 10 min y cada símbolo se renueva por separado. Acciones y ETF solo con la bolsa de Nueva York abierta (lunes a viernes, 9:30–16:00 hora de NY, sin los feriados ni los cierres a la 1:00 p. m. del calendario oficial de la NYSE, cargado hasta 2027 en `lib/market-hours.ts`) y una vez más tras el cierre. Divisas y cripto, siempre. «Actualizar» renueva si el dato tiene más de 30 s.
  - Historial de **5 años** por símbolo, cada 12 h: Twelve Data cobra 1 crédito por consulta sin importar cuántos días traiga. Los rangos 1M, 3M, 6M, YTD, 1A, 3A y 5A se recortan de esa misma caché y miden el rendimiento desde el cierre anterior al inicio (YTD, desde el 31 de diciembre). BCRP y FRED: cada 6 h.
  - **Freno:** la app gasta como máximo 600 créditos de Twelve Data al día; el resto queda para el conector de Claude. Pasado el freno se muestran los últimos precios guardados.
- **Exportar a Excel:** los botones «CSV» arman el archivo en el navegador (comas, punto decimal y BOM UTF-8, como lo lee Excel con la configuración es-PE). Son los cierres, rendimientos diarios e indicadores del rango, en la ficha; los cierres alineados y la base 100, en Comparar; y las series de Perú y EE. UU., que también ven los amigos.
- **Indicadores técnicos (ficha):** medias móviles de 50 y 200 días, bandas de Bollinger (20 días, 2 desviaciones) y RSI de 14 días (suavizado de Wilder) en `lib/indicators.ts`. Se calculan en el servidor con los 5 años guardados y después se recortan al rango, así la MM200 existe desde el primer día de cualquier rango. Se prenden y apagan en la leyenda del gráfico (la elección queda guardada en el navegador).
- **Velas, volumen y MACD (ficha):** el historial de 5 años guarda también apertura, máximo, mínimo y volumen de cada día (`bars` en `hist5:<símbolo>`; los registros de antes se renuevan una vez, 1 crédito por símbolo). Las velas se ven hasta 1 año (en 3 y 5 años serían de menos de 1 px): huecas si el día cerró más arriba de lo que abrió y rellenas si cerró más abajo, porque el verde y el rojo se confunden con daltonismo (ΔE 2,2 en el validador). El volumen va en un panel aparte (nunca dos escalas en un gráfico); en acciones es el consolidado de las bolsas de EE. UU., verificado contra Nasdaq (BAP, 21 oct: 392.500 frente a 392.494). El MACD (12, 26, 9) es la media exponencial de 12 días menos la de 26, con su señal de 9 y el histograma, en otro panel; coincide con el de Twelve Data hasta el cuarto decimal. Todos los paneles de la ficha usan una franja por día, así el cursor marca el mismo día en todos. El CSV de la ficha suma apertura, máximo, mínimo, volumen y MACD.
- **Estacionalidad y probar una estrategia (ficha, bloques plegables):** se calculan en el navegador con los 5 años que el servidor ya guarda, sin créditos.
  - **Estacionalidad:** rendimiento de cada mes por año (último cierre del mes anterior al último del mes), del año, el promedio de cada mes y en cuántos años subió. Mapa de calor divergente azul (sube) ↔ rojo (baja) con gris al medio, como pide la guía de gráficos, y el número en cada celda; el tope del color es el percentil 90 de los movimientos del símbolo. El mes en curso no entra al promedio.
  - **Probar una estrategia:** cruce de medias 50/200 o 20/50 días, o RSI (compra bajo 30, vende sobre 70), frente a comprar y mantener desde el primer día con señal, base 100. Cada día se está dentro o fuera según la señal del cierre anterior (sin mirar el futuro); sin comisiones ni impuestos. Muestra el rendimiento total y anual, la peor caída, el tiempo dentro del mercado y las últimas operaciones.
- **Comparar:** de 2 a 4 símbolos de la lista en base 100, con rendimiento, volatilidad, mayor caída y la correlación de los rendimientos diarios. Solo cuentan los días en que todos cotizan (la cripto también cotiza los fines de semana). Sale de la misma caché del historial: normalmente no gasta créditos.
- **Mercados y tasas del Perú:** cobre, oro, BVL, reservas, bonos del Perú a 10 años (en soles y en dólares) y un riesgo país aproximado. Cada uno muestra el último dato, la variación a 1 y 12 meses y el gráfico del último año, con datos del BCRP (públicos: también los ven los amigos). Las tasas cambian en puntos porcentuales y el riesgo país en puntos básicos. Se guardan aparte de lo demás de Perú (`peru-markets2` en KV), así que si el BCRP falla con ellas el resto se sigue viendo.
  - **Riesgo país aproximado:** bono peruano en dólares a 10 años menos el Tesoro de EE. UU. a 10 años. El EMBIG del BCRP (`PD04709XD`) está detenido desde el 3 de setiembre de 2026, sin aviso.
- **Calendario económico:** decisiones de tasas del BCRP y de la Fed, y publicaciones de inflación del INEI y del BLS, en `lib/calendar.ts`. Las fechas se cargan a mano desde cada fuente oficial (`SOURCES`), hoy hasta 2026 para el BCRP y hasta 2027 para las demás (`CALENDAR_UNTIL`). Las horas oficiales se convierten a la hora de Lima, y las fechas que la fuente da como tentativas se marcan así. Si `EVENTS` quedara vacío, el panel oculta la sección y el conector no ofrece la herramienta.
- **Resultados de tus empresas** (solo el dueño, `services/earnings.ts`, cliente en `lib/finnhub.ts`): fechas de resultados trimestrales de las acciones de la lista, de Finnhub. Sus términos no permiten mostrar los datos a otras personas, así que los amigos nunca los reciben. Sin `FINNHUB_API_KEY` la función queda apagada y el calendario sigue igual.
  - Se pide un mes hacia atrás (lo que da el plan gratis) y 120 días hacia adelante, un pedido por acción (sin divisas ni cripto; los ETF no traen fechas). Se guarda en KV por lista (`earnings:<símbolos>`) cada 12 h. Si falla una acción se muestran las demás; si fallan todas, lo último guardado o nada, sin romper el calendario.
  - **Calendario:** cada presentación con el símbolo (abre su ficha), el trimestre fiscal, el momento del día (antes de la apertura, después del cierre o durante la sesión) y el BPA estimado por los analistas.
  - **Ficha:** próximos resultados y, si hubo en el último mes, el último BPA frente al esperado, con la sorpresa en %.
  - **Lista:** un aviso «Resultados en N d» cuando faltan 7 días o menos.
  - El BPA y los ingresos son ajustados (no GAAP) y van en la moneda en que reporta cada empresa; el trimestre es el fiscal.
- **Datos de la empresa** (solo el dueño, `services/company.ts`): en la ficha, perfil (sector, país, bolsa, web), capitalización, PER y BPA de los últimos 12 meses, precio/valor contable, beta, dividendo, margen neto, ROE, crecimiento de ingresos, rango de 52 semanas, recomendación de los analistas (y cómo estaba unos meses antes), sorpresas del BPA de los últimos 4 trimestres y comparables. De Finnhub, guardado 24 h por símbolo en KV (`company:<símbolo>`): cinco pedidos al abrir la ficha, una escritura como mucho al día por símbolo. Si falla una parte se muestran las demás. Sin `FINNHUB_API_KEY` la ficha muestra cómo prenderlo; divisas y cripto no tienen esta sección, y los ETF casi no traen datos.
- **Pronósticos del grupo** (`lib/forecasts.ts` y `services/forecasts.ts`): un juego sin plata con datos públicos, así que juegan el dueño y los amigos.
  - **Preguntas:** salen solas del calendario: cada decisión de tasa del BCRP y de la Fed (sube, mantiene o baja), cada dato de inflación a 12 meses del INEI (Lima) y del BLS (EE. UU., con un decimal), más el dólar interbancario del BCRP (venta) al cierre de cada mes. Se abren 45 días antes y se cierran a la medianoche de Lima anterior al anuncio; el dólar, una semana antes de su último día hábil. Lo que cerró antes del 23 oct 2026 (`GAME_START`) no cuenta.
  - **Puntos:** hasta 10 por pregunta. Acertar la decisión da 10; en los números, 10 menos 1 por cada 0,05 pp de error en la inflación o por cada medio céntimo en el dólar. El ranking suma todo lo resuelto.
  - **Reglas de juego:** cada uno elige un nombre para el ranking (sin repetir); el jugador es el hash de su correo de Access, que no se guarda ni se muestra. Lo que puso cada uno se ve recién al cierre, junto con el consenso (cuántos eligieron cada opción o la mediana).
  - **Resultados:** los calcula la tarea programada con las cachés de Perú y EE. UU.: la tasa del BCRP día por día, el rango objetivo de la Fed (`DFEDTARU`/`DFEDTARL` de FRED), la inflación de Lima, el IPC de EE. UU. y el dólar.
  - **KV:** cada pronóstico es una clave propia con el valor en la metadata (`pron:f:<pregunta>:<jugador>`), igual que cada nombre (`pron:p:<jugador>`), así dos amigos que juegan a la vez no se pisan; un solo `list` trae todo. Los resultados van en `pron-results` y solo los escribe la tarea programada.
- **Expectativas de los analistas** (público): en Perú, la inflación, el PBI y el dólar que esperan analistas y empresas a 12 meses según la encuesta mensual del BCRP, frente al mes anterior. Las tarjetas del juego de inflación de Lima y del dólar las muestran junto al último dato.
- **Curva de rendimientos** (público, `/api/curve`): en EE. UU., la curva del Tesoro de 1 mes a 30 años de hoy, de hace un mes y de hace un año (FRED, 11 series guardadas juntas 6 h en `curve`), y la diferencia 10 años − 2 años del último año: si es negativa, la curva está invertida. El BCRP solo publica el bono peruano a 10 años, que ya está en «Mercados y tasas del Perú».
- **Resultados de empresas** (público, `services/financials.ts`, lector en `lib/sec.ts`, `/api/financials?symbol=`): ingresos, utilidad operativa y utilidad neta de hasta 12 años fiscales de cualquier empresa que reporte a la SEC (10-K de EE. UU.; 20-F o 40-F de extranjeras como Southern Copper, Buenaventura o Credicorp), con margen neto, cambio frente al año anterior y crecimiento compuesto de los ingresos. Cada línea junta varios conceptos XBRL año por año (las empresas cambian de nombre contable con los años) y, si no hay US GAAP recientes, se leen los de NIIF. Hasta 11 pedidos a la SEC por símbolo (de a 6 a la vez: pide no pasar de 10 por segundo), guardados 7 días en `sec:<símbolo>`, también cuando la SEC no tiene la empresa (ETF). Una sección para todos con cualquier símbolo y un bloque plegable en la ficha del dueño.
- **Encabezado «Rueda»:** logo de rueda (también `icon.svg`), estado «Rueda abierta / cerrada» según el horario de la NYSE (lo da `/api/status`, sin usar Twelve Data) y una cinta de precios. En la cinta, el dueño ve su lista con los precios guardados, sin gastar créditos; todos ven el dólar, el cobre, el oro y la BVL del BCRP, y el bono a 10 años de FRED. Un botón ▶/⏸ al inicio la mueve o la detiene (se recuerda en el navegador); sin elegir, sigue lo que pide el sistema: con «reducir movimiento» o los efectos de animación de Windows apagados, arranca quieta.
- **Mi cuenta Hapi** (cada uno la suya, privada; `services/hapi.ts`, comisiones en `lib/hapi.ts`, `/api/hapi`): Hapi, el bróker que usa el grupo, no tiene API, así que se anotan compras, ventas, dividendos, depósitos y retiros. Si no se escribe el costo, se calcula con las comisiones de Hapi de 2026 (US$ 0,10 por orden de acciones enteras, 0,15 por fracciones, 0,05 con Prime; en ventas, los cargos de la SEC y de FINRA; depósito en soles US$ 1,99, retiro US$ 4,99) y los dividendos llevan la retención de 30 % de EE. UU. Muestra costo promedio con comisiones, ganancia realizada neta, dividendos, costos pagados, efectivo y rendimiento en US$ y en soles (con los soles de cada depósito y el dólar del BCRP). Solo el dueño la ve a precios de mercado (Twelve Data); los demás comparan con el valor total que anotan de Hapi. Un registro por persona en KV (`hapi:<jugador>`, el id del juego de pronósticos): nadie ve la cuenta de otro, ni en el panel ni en el conector. La ficha y «Resultados de empresas» enlazan a la página pública de cada acción en Hapi (Hapi no tiene enlaces que abran su app).
- **Cartera simulada** (solo el dueño, `services/portfolio.ts`): compras y ventas con fecha, cantidad y precio guardadas en KV (`portfolio`). Si no se escribe el precio, se usa el cierre de ese día; si la fecha es hoy, el precio guardado de la lista.
  - Se valoriza con los precios ya guardados, así que no gasta créditos.
  - Usa costo promedio y muestra los totales en US$ y en soles (con el USD/PEN de la lista o el dólar del BCRP), sin dividendos ni comisiones.
  - Se compara con haber hecho las mismas compras y ventas en el SPY: cada compra pone esa plata en el SPY y cada venta saca la parte proporcional.
  - Solo entran los símbolos de la lista que cotizan en dólares (USD/PEN no). No deja vender más de lo que había en esa fecha ni borrar una compra que respalda una venta posterior.
- **Rayos X de la cartera** (solo el dueño, `services/xray.ts`, `/api/portfolio/xray`): de qué está hecha la cartera simulada (por posición, sector y país, con el perfil de Finnhub; ETF y cripto aparte), su concentración (la mayor posición, las 3 mayores y las «posiciones efectivas», 1 / Σ peso²) y su riesgo del último año con los pesos de hoy: volatilidad anual, beta frente al SPY, peor caída y correlación entre posiciones. Usa solo lo guardado: no gasta créditos.
- **Notas por factores A–F** (solo el dueño, `services/factors.ts`, `/api/company/factors`): en la ficha, valor (PER, precio/valor contable, precio/ventas: más barato, mejor), crecimiento, rentabilidad, impulso (26 y 52 semanas) y dividendo frente a las comparables de Finnhub. Cada indicador da un percentil dentro del grupo y la nota del factor es el promedio (A desde 80, B desde 60, C desde 40, D desde 20). Con menos de 3 empresas con el dato no se califica; un PER negativo no cuenta como barato. Los indicadores de las comparables se guardan 24 h en `factors:<símbolo>`.
- **Noticias** (`services/news.ts`, lector en `lib/rss.ts`): titulares de RSS públicos, gratis y sin claves. Se muestran titular, medio, hora y enlace, nunca la nota completa.
  - **Generales:** Gestión (economía), Bloomberg Línea (mercados), WSJ, MarketWatch, CNBC y Bloomberg. Se guardan juntas en KV (`news`) cada 30 minutos, unas 48 escrituras al día. Si una fuente falla, se muestran las demás. Son públicas: las ven también los amigos.
  - **Por acción:** en la ficha, titulares de Yahoo Finance (por símbolo) y de Google News (por nombre, en español). Se piden al abrirla y no se guardan.
  - **Por qué se leen de a poco:** Gestión y Bloomberg Línea mandan la nota completa en cada ítem y pesan ~1 MB. El lector lee el stream y corta apenas tiene los primeros titulares, para respetar el límite de procesador del plan gratis (10 ms por pedido).
- **Tipografía (legibilidad, 22 oct):** números, títulos y datos en IBM Plex Mono; frases, etiquetas y ayudas en IBM Plex Sans. Base de 15 px y nada por debajo de 12 px. Las explicaciones de uso van en un «?» por sección (`<details class="help">`) en vez de quedar siempre a la vista.
- **Cartera en los gráficos y señales:** la ficha marca tus compras (▲) y ventas (▼) de la cartera simulada a su precio, y el tooltip las detalla. En la lista, junto al nombre, se ve si el último cierre está sobre o bajo su media de 200 días y, solo en zona extrema (70 o más, 30 o menos), el RSI. Sale del `latest` que `/api/history` devuelve siempre.
- **Medir entre dos días:** en cualquier gráfico interactivo, arrastrar con el mouse (en el celular, dos dedos; con el teclado, Mayús + flechas) muestra las fechas, la duración y la variación entre ambos días: en % y en precio en la ficha, por símbolo en Comparar y en puntos porcentuales en las tasas. Queda fija hasta un clic fuera o Esc.
- **Colores de los gráficos con varias líneas:** `--s1` a `--s4` en `styles.css` (cian, magenta, violeta, amarillo), validados para daltonismo sobre el fondo del panel. Cada símbolo conserva su color mientras está elegido. Las líneas solas usan el cian de marca.
- **Lista de seguimiento:** hasta 8 símbolos (8 créditos por minuto del plan gratis).
- **Lista diaria** (`services/eod.ts`, solo el dueño): hasta 20 símbolos más, sin precio en vivo, con el cierre de cada día, la variación, el minigráfico de 1 año (un punto por semana) y el rendimiento de 1 año. Al tocar uno se abre su ficha, que funciona igual que con la lista principal (historial, indicadores, empresa, noticias y resultados).
  - Una tarea programada (`triggers` en `wrangler.jsonc`, cada 10 minutos) pide los cierres que faltan: en acciones, el del día 30 minutos después del cierre de Nueva York; en cripto y divisas, el del día anterior. Como mucho 5 por ejecución (8 créditos por minuto), 1 crédito por símbolo al día, y cada símbolo se pide una sola vez por sesión aunque no haya cotizado.
  - El panel lee un solo registro resumido (`eod` en KV) en vez de 20 historiales; la lista se guarda en `watchlist-eod`. Al guardarla, los símbolos nuevos (hasta 4) se piden en el momento.
  - Un símbolo no puede estar en las dos listas.

## Quién ve qué

| Rol | Quién | Qué ve |
|---|---|---|
| Dueño | Los correos de `OWNER_EMAILS` | Todo: precios, historial, comparación, cartera simulada y lista (Twelve Data), resultados y datos de empresas (Finnhub), resultados anuales (SEC), Perú y EE. UU., y su cuenta de Hapi a precios de mercado |
| Amigo | El resto de `ALLOWED_EMAILS` (y de la política de Access) | Solo datos públicos: Perú (BCRP) y EE. UU. (FRED), resultados anuales de empresas (SEC), noticias generales, calendario, y juegan a los pronósticos del grupo. Además, su propia cuenta de Hapi (sin precios de mercado) |

La licencia gratis de Twelve Data no permite mostrar sus datos a otras personas ni compartir la clave (§2.2 y §2.3 de sus [términos](https://twelvedata.com/terms)). Por eso el servidor responde **403** a los amigos en `/api/quotes`, `/api/history`, `/api/compare`, `/api/portfolio`, `/api/news/symbol`, `/api/company`, `/api/eod` y `/api/watchlist`, y el conector solo les ofrece las herramientas de datos públicos (`peru_bcrp`, `eeuu_fred`, `resultados_anuales`, `noticias` generales y `calendario`); no es solo un ocultamiento en pantalla. Si `OWNER_EMAILS` está vacío, nadie ve los precios (falla cerrado). Con Finnhub pasa lo mismo: `/api/calendar` y la herramienta `calendario` solo suman los resultados de empresas cuando quien pide es el dueño.

**Agregar un amigo:** su correo va en la política de Access de la app (regla *Allow* → *Emails*) **y** en `ALLOWED_EMAILS`. Al editar ese secreto hay que volver a escribir toda la lista, incluido tu correo: el panel no muestra el valor anterior.

## API

Todas las rutas exigen sesión de Cloudflare Access. Las marcadas con 🔒 son solo para el dueño.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/status` | Tu rol. Al dueño además: si cada secreto está cargado y con formato correcto (sin mostrar valores) y créditos usados hoy |
| GET / PUT | `/api/watchlist` 🔒 | Lee o guarda la lista (`{"symbols": ["BAP", "USD/PEN"]}`) |
| GET / PUT | `/api/eod` 🔒 | Lista diaria: cierres guardados (no gasta créditos) o guardar la lista (`{"symbols": ["NVDA"]}`; pide ya los nuevos, hasta 4) |
| GET | `/api/quotes` 🔒 | Precios de la lista (`?refresh=1` = botón «Actualizar») y estado de la bolsa |
| GET | `/api/history?symbol=BAP&range=1A` 🔒 | Cierres diarios del rango (1M, 3M, 6M, YTD, 1A, 3A, 5A) y sus estadísticas. Con `&ind=1`, también MM50, MM200, Bollinger, RSI 14 y MACD, y apertura, máximo, mínimo y volumen (`bars`), alineados con los cierres |
| GET | `/api/compare?symbols=BAP,SPY&range=1A` 🔒 | De 2 a 4 símbolos de la lista: días en común, cierres, base 100, estadísticas y matriz de correlación |
| GET | `/api/portfolio` 🔒 | Cartera simulada valorizada: operaciones, posiciones, totales en US$ y soles, y comparación con el SPY |
| POST / DELETE | `/api/portfolio` 🔒 | Agrega una operación (`{"date", "symbol", "side": "buy"\|"sell", "qty", "price"?}`) o borra una (`?id=…`); responde la cartera valorizada |
| GET | `/api/company?symbol=BAP` 🔒 | Datos de la empresa (Finnhub): perfil, indicadores, analistas, sorpresas del BPA y comparables. `enabled: false` sin clave; `applicable: false` para divisas y cripto |
| GET | `/api/portfolio/xray` 🔒 | Rayos X de la cartera simulada: composición, concentración y riesgo con los pesos de hoy |
| GET | `/api/company/factors?symbol=BAP` 🔒 | Notas por factores A–F frente a las comparables de Finnhub, con el detalle de cada indicador |
| GET | `/api/news` | Titulares generales (todas las fuentes, guardados 30 min), con su grupo: `latam`, `eeuu` o `global` |
| GET | `/api/news/symbol?symbol=BAP` 🔒 | Titulares de un símbolo de la lista (Yahoo Finance y Google News), sin guardar |
| GET | `/api/peru` | Dólar interbancario, tasa de referencia e inflación (BCRP) |
| GET | `/api/peru-markets` | Cobre, oro, reservas internacionales e índice de la BVL: un año diario, último dato y variaciones a 1 y 12 meses (BCRP) |
| GET / POST | `/api/forecasts` | Pronósticos del grupo: preguntas, lo propio, lo de los demás desde el cierre, resultados y ranking. POST `{"questionId", "value"}` guarda o cambia un pronóstico (pide nombre) |
| PUT | `/api/forecasts/name` | Nombre para el ranking (`{"alias": "Fabri"}`), de 2 a 20 caracteres y sin repetir |
| GET | `/api/calendar?days=120` | Próximos eventos del calendario económico (`loaded: false` mientras no haya fechas cargadas). Al dueño, además, los resultados de su lista (eventos `empresa` y `companies`: estado, último resultado del mes y notas) |
| GET | `/api/curve` | Curva del Tesoro de EE. UU. (hoy, hace un mes y hace un año) y la diferencia 10 años − 2 años (FRED) |
| GET / POST / DELETE | `/api/hapi` | La cuenta de Hapi de quien pide: posiciones, totales y movimientos. POST `{"kind", "date", …}` anota un movimiento (compra, venta, dividendo, depósito o retiro); DELETE `?id=…` lo borra |
| PUT | `/api/hapi/settings` | Plan de Hapi (`{"plan": "standard" \| "prime"}`) o el valor total que muestra Hapi (`{"snapshot": {"date", "value"}}`, `null` lo borra) |
| GET | `/api/financials?symbol=SCCO` | Resultados anuales de cualquier acción que reporte a la SEC: ingresos, utilidad operativa y utilidad neta por año fiscal (`cik: null` si la SEC no la tiene) |
| GET | `/api/usa` | Bono a 10 años, tasa de la Fed e inflación (FRED) |
| GET | `/conector/identidad?state=…` 🔒 | Paso del login del conector: firma tu correo y vuelve a `mercados-mcp` |

## Conector de Claude (MCP)

Vive en un **Worker aparte, `mercados-mcp`** (`src/mcp-worker.ts`, `wrangler.mcp.jsonc`), en `https://mercados-mcp.mercados.workers.dev/mcp`: un servidor MCP remoto (Streamable HTTP, sin estado; SDK `@modelcontextprotocol/server`) para usar Mercados desde claude.ai, el celular o Claude Code. Herramientas, todas de solo lectura:

| Herramienta | Qué devuelve |
|---|---|
| `precios` | Precios de la lista de seguimiento (todos o los símbolos pedidos) |
| `historial` | Cierres de un símbolo de la lista en el rango pedido (hasta 5 años), sus estadísticas y los indicadores técnicos del último cierre (medias, RSI, Bollinger, MACD y volumen) |
| `comparar` | De 2 a 4 símbolos de la lista: rendimiento, volatilidad, mayor caída, correlación y base 100 al cierre de cada mes |
| `cartera` | La cartera simulada valorizada: posiciones, ganancia, totales en US$ y soles y comparación con el SPY (solo lectura) |
| `empresa` | Datos de una acción de la lista (Finnhub): perfil, capitalización, PER, márgenes, ROE, beta, dividendo, analistas, sorpresas del BPA, comparables y notas por factores A–F |
| `lista_diaria` | Cierres guardados de la lista diaria: último cierre, fecha, variación y rendimiento de 1 año. Sus símbolos también sirven en `historial`, `comparar`, `empresa` y `noticias` |
| `pronosticos` | El juego de pronósticos del grupo: preguntas abiertas (con el pronóstico propio), cerradas, resueltas con puntos y ranking. Solo lectura |
| `noticias` | Titulares generales por grupo y, para el dueño, los de un símbolo de la lista, con medio, hora, enlace y resumen corto |
| `peru_bcrp` | Dólar interbancario, tasa de referencia, inflación de Lima y, en `mercados`, cobre, oro, reservas y BVL con sus variaciones y cierres mensuales (BCRP) |
| `calendario` | Próximas decisiones de tasas (BCRP, Fed) y publicaciones de inflación (INEI, BLS). Para el dueño, también los resultados de su lista (Finnhub): fecha, momento, BPA e ingresos esperados y el último resultado del mes con la sorpresa. Aparece mientras haya fechas cargadas |
| `eeuu_fred` | Bono del Tesoro a 10 años, tasa de la Fed e inflación (FRED) |
| `resultados_anuales` | Ingresos, utilidad operativa, utilidad neta y margen neto por año fiscal de cualquier acción que reporte a la SEC (también para los amigos) |
| `cuenta_hapi` | La cuenta de Hapi de quien usa el conector (privada): posiciones, costos, dividendos, depósitos y rendimiento; para el dueño, también a precios de mercado |

- **Mismos datos y reglas que el panel:** lee la misma caché de KV, renueva solo lo vencido con las mismas reglas (acciones solo con la bolsa abierta) y cuenta para el mismo freno de 600 créditos. Solo responde por los símbolos de la lista; para otros, Claude debe usar el conector oficial de Twelve Data.
- **Por qué un Worker aparte:** Access no deja pasar a los servidores de Claude, y su login para conectores (*Managed OAuth*) falla en claude.ai web y móvil ([anthropics/claude-ai-mcp#410](https://github.com/anthropics/claude-ai-mcp/issues/410)). `mercados-mcp` no está detrás de Access: es su propio servidor OAuth 2.1, con la librería oficial `@cloudflare/workers-oauth-provider` (DCR, CIMD, PKCE, tokens guardados como hash en la KV `OAUTH_KV`).
- **Login:** Claude abre `/authorize` → página de permiso (cliente y destino a la vista; solo destinos `claude.ai`/`claude.com` o apps locales) → **Permitir** lleva a la app, `/conector/identidad`, donde Access confirma tu correo → la app lo firma (HMAC con `LOGIN_LINK_SECRET`, 2 min) y vuelve a `/callback` → código → `/token`. El `state` queda atado al navegador que empezó (cookie `__Host-`), así que un enlace robado no sirve en otro.
- **Quién puede:** por ahora solo el dueño (`OWNER_EMAILS`), en el login y en **cada** pedido a `/mcp`: si sacas un correo de la lista, su token deja de servir.
- **Agregarlo en Claude:** claude.ai → Customize → Connectors → **+ Add** → **Add custom connector** → URL `https://mercados-mcp.mercados.workers.dev/mcp`. En el plan gratis de Claude solo se permite un conector personalizado.
- **Secretos de `mercados-mcp`:** `OWNER_EMAILS`, `LOGIN_LINK_SECRET` (**el mismo** que en la app), `TWELVE_DATA_API_KEY`, `FRED_API_KEY` y, si la usas, `FINNHUB_API_KEY`. Si cambias una clave en la app, cámbiala también aquí.

## Estructura

```
src/
  index.ts              app: router, validación de Access, cabeceras de seguridad
  mcp-worker.ts         Worker del conector: OAuth propio (permiso, login, tokens) y /mcp
  mcp.ts                servidor MCP y sus herramientas (lo usa mcp-worker.ts)
  lib/signed.ts         mensajes firmados (HMAC) entre la app y el conector
  auth/access.ts        verificación del JWT de Cloudflare Access (jose)
  services/market.ts    caché en KV, freno de créditos y qué símbolos renovar
  services/portfolio.ts cartera simulada: operaciones, costo promedio, valorización y comparación con el SPY
  services/news.ts      noticias: fuentes RSS, caché de las generales y titulares por acción
  services/earnings.ts  resultados de empresas de la lista (Finnhub, solo el dueño) para el calendario y la ficha
  services/company.ts   datos de la empresa para la ficha (Finnhub, solo el dueño)
  services/factors.ts   notas por factores A–F frente a las comparables (Finnhub, solo el dueño)
  services/financials.ts resultados anuales de la SEC: conceptos por línea, NIIF si hace falta y caché de 7 días
  services/hapi.ts      cuenta de Hapi de cada persona (privada): movimientos, costo promedio con comisiones y valorización
  services/xray.ts      rayos X de la cartera simulada: composición, concentración y riesgo
  services/eod.ts       lista diaria: cierres de hasta 20 símbolos más y la tarea programada que los renueva
  lib/forecasts.ts      pronósticos del grupo: preguntas desde el calendario, puntos y cómo se resuelve cada una
  services/forecasts.ts pronósticos del grupo: jugadores, pronósticos en KV, lo que ve cada uno y la resolución automática
  lib/finnhub.ts        cliente de Finnhub (calendario de resultados y datos de empresa)
  lib/sec.ts            cliente de la SEC (buscador de EDGAR y conceptos XBRL anuales)
  lib/hapi.ts           comisiones de Hapi 2026 (compensación por orden, SEC y FINRA en ventas, depósitos y retiros)
  lib/rss.ts            lector de RSS por stream (corta apenas tiene los titulares que necesita)
  lib/twelvedata.ts     cliente de Twelve Data
  lib/bcrp.ts           cliente del BCRP (tolera el aviso HTML que agrega tras el JSON)
  lib/fred.ts           cliente de FRED
  lib/market-hours.ts   horario de la bolsa de Nueva York
  lib/stats.ts          rendimiento, volatilidad, mayor caída, peor/mejor día
  lib/indicators.ts     medias móviles simples y exponenciales, Bollinger, RSI, MACD, alineación por fecha y correlación
  lib/calendar.ts       calendario económico: fechas oficiales cargadas por año y conversión a la hora de Lima
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

Cada push a `main` ejecuta GitHub Actions: typecheck, pruebas y `wrangler deploy` de los **dos** Workers (`mercados` y `mercados-mcp`). Los pull requests solo ejecutan las pruebas. `mercados` tiene una tarea programada (cron cada 10 minutos: lista diaria y resultados de los pronósticos) que el despliegue registra solo; se ve en Workers → mercados → Settings → Trigger events.

- **Secretos del repo** (GitHub → Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (plantilla «Edit Cloudflare Workers») y `CLOUDFLARE_ACCOUNT_ID`.
- **Secretos de `mercados`** (panel de Cloudflare → Workers → mercados → Settings → Variables and Secrets, tipo **Secret**): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, `OWNER_EMAILS`, `TWELVE_DATA_API_KEY`, `FRED_API_KEY`, `LOGIN_LINK_SECRET` y, opcional, `FINNHUB_API_KEY` (clave gratis de finnhub.io, para los resultados de empresas). El despliegue los conserva. Para comprobarlos: `/api/status` → `config`.
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
