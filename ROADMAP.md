# Roadmap de Mercados

Actualizado el 22 de octubre de 2026. Lo que ya está hecho se describe en el README y en el historial de git; aquí va lo que falta, en orden.

**Orden acordado:** primero se termina de implementar todo lo pendiente (secciones 1 a 4). Recién después se configura el acceso para los chicos del grupo (sección 5).

## 1. Nombre e identidad: «Rueda» (elegido el 22 de octubre)

Nombre elegido: **Rueda** (por la rueda de bolsa), con la variante **C** del encabezado: el sello más una cinta de precios. Se mantiene el diseño Terminal y solo cambia el nombre visible: la dirección web y los Workers siguen igual.

- [ ] **Logo:** una rueda con rayos en cian, junto a «RUEDA». Sirve también como `icon.svg` (pestaña y celular).
- [ ] **Estado de la bolsa:** «Rueda abierta» / «Rueda cerrada» en vez de «NYSE abierto» / «NYSE cerrado».
- [ ] **Cinta de precios** debajo del encabezado, como la pizarra electrónica de la bolsa:
  - El dueño ve su lista, con los precios de la caché, sin gastar créditos extra.
  - Los amigos ven datos públicos: dólar, cobre, oro y BVL del BCRP, y el bono a 10 años de FRED. Es por la licencia de Twelve Data.
  - Sin movimiento si el sistema pide reducir animaciones (`prefers-reduced-motion`).
- [ ] **Cambiar el nombre en:** `<title>`, `.logo`, `manifest.webmanifest` (`name`, `short_name`), `apple-mobile-web-app-title`, README y CLAUDE.md. El nombre del conector en claude.ai se cambia al reconectarlo.
- [ ] Mostrar la vista previa antes de publicar.

## 2. Terminar la 3C: fechas del calendario económico

El código ya está publicado y probado (`src/lib/calendar.ts`, `/api/calendar`, herramienta `calendario` y sección del panel). Falta cargar las fechas. Mientras `EVENTS` esté vacío, el panel oculta la sección y el conector no ofrece la herramienta.

- [ ] Cargar en `EVENTS` las fechas oficiales del resto de 2026 y de 2027, cada una verificada en su fuente. Agregar la hora oficial y su zona horaria cuando la fuente la publique:
  - **BCRP:** cronograma de las sesiones del Directorio sobre el Programa Monetario.
  - **Fed:** reuniones del FOMC (`federalreserve.gov/monetarypolicy/fomccalendars.htm`). El comunicado sale a las 2:00 p. m. hora de Nueva York.
  - **INEI:** informe técnico de precios de Lima Metropolitana.
  - **BLS:** calendario del CPI (`bls.gov/schedule/news_release/cpi.htm`), a las 8:30 a. m. hora de Nueva York.
- [ ] Completar `CALENDAR_UNTIL` y la URL exacta de cada calendario en `SOURCES`.
- [ ] Ver la sección en la vista previa y publicar.

Fechas ya investigadas en las fuentes oficiales el 21 de octubre. Hay que volver a verificarlas antes de cargarlas.

- **BCRP:** 12 de noviembre y 10 de diciembre de 2026, según el cronograma de la nota informativa del 11 de diciembre de 2025. El cronograma de 2027 saldrá en la nota del 10 de diciembre. Ninguna página oficial da la hora del anuncio. No hay que calcularlas por regla: la sesión de octubre de 2026 fue un miércoles.
- **Fed:** 27–28 de octubre y 8–9 de diciembre de 2026. En 2027, tentativas hasta que las confirme la reunión anterior: 26–27 de enero, 16–17 de marzo, 27–28 de abril, 8–9 de junio, 27–28 de julio, 14–15 de setiembre, 26–27 de octubre y 7–8 de diciembre. Las de diciembre de 2026 y las de marzo, junio, setiembre y diciembre de 2027 traen proyecciones económicas.
- **INEI:** 1 de noviembre y 1 de diciembre de 2026, según su calendario oficial (inei.gob.pe/calendario). 2027 todavía no aparece. En la práctica publica el día 1 de cada mes aunque sea fin de semana o feriado, así que 2027 iría como tentativo.
- **BLS:** 10 de noviembre y 10 de diciembre de 2026. En 2027: 13 de enero, 11 de febrero, 10 de marzo, 13 de abril, 12 de mayo, 10 de junio, 14 de julio, 11 de agosto, 14 de setiembre, 14 de octubre, 10 de noviembre y 10 de diciembre.

## 3. Fase 3D: cartera simulada

Antes de empezar hay que decidir:
- ¿Solo con símbolos de la lista o con cualquiera?
- ¿Mostrarla también en soles?
- ¿Contar los dividendos?

Alcance pensado:
- Registrar compras y ventas simuladas: fecha, símbolo, cantidad y precio.
- Mostrar el valor actual, la ganancia o pérdida y el rendimiento, comparados con el S&P 500 (SPY) en el mismo periodo.
- Exportar a CSV y consultarla desde el conector.
- Solo para el dueño, porque usa precios de Twelve Data.

## 4. Ajustes tuyos que no dependen de los amigos

- [ ] **`FRED_API_KEY`** en los dos Workers (`mercados` y `mercados-mcp`). Sin la clave, la sección de EE. UU. muestra un error.
- [ ] **Reconectar el conector en claude.ai** para que aparezca `comparar` y, cuando tenga fechas, `calendario`.
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

## 6. Ideas para después

- Que cada amigo use su propia clave gratis de Twelve Data (lista y caché por persona) para que también vea precios.
- Reportes de empresas de EE. UU. (SEC EDGAR) y noticias.
- Medir el gasto de créditos de Twelve Data en un día normal y ajustar el freno si hace falta.
- Decidir si el repositorio sigue público (hoy lo está) o pasa a privado.
- Herramienta `precios` del conector: aceptar los símbolos también como texto («BAP, SPY»).

## 7. Mantenimiento con fecha fija

- **Cada diciembre:** agregar los feriados y cierres anticipados de la NYSE del año siguiente en `lib/market-hours.ts` (hoy están hasta 2027). Si no se hace, la app gasta créditos en los feriados.
- **Cada año:** cargar el calendario económico del año siguiente cuando las fuentes lo publiquen. El BCRP suele publicar su cronograma en diciembre.
