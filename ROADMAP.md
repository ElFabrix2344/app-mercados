# Roadmap de Mercados

Actualizado el 21 de octubre de 2026. Lo que ya está hecho se describe en el README y en el historial de git; aquí va lo que falta, en el orden sugerido.

## 1. Pendientes cortos de configuración (los haces tú)

- [ ] **Acceso de amigos con código por correo.** Hoy Access pide una cuenta de Cloudflare.
  1. Zero Trust → **Integrations → Identity providers** → **Add new identity provider** → **One-time PIN**.
  2. **Access controls → Applications** → la app de `mercados.mercados.workers.dev`. Edita esa misma, no crees otra: una app nueva cambia el AUD y la app dejaría de dejarte entrar.
  3. En sus métodos de inicio de sesión, marca **One-time PIN**. En **Policies**, agrega una regla **Include → Emails** con tu correo y los de tus amigos.
  4. Workers & Pages → mercados → Settings → Variables and Secrets: reescribe **`ALLOWED_EMAILS`** con la lista completa, incluido tu correo. `OWNER_EMAILS` queda solo con el tuyo.
  5. Prueba en una ventana de incógnito. El código llega de `noreply@notify.cloudflare.com` y vale 10 minutos.
- [ ] **`FRED_API_KEY`** en los dos Workers (`mercados` y `mercados-mcp`). Antes de invitar a los amigos, revisa los términos de FRED: sin la clave, la sección de EE. UU. les muestra un error.
- [ ] **Reconectar el conector en claude.ai** para que aparezca `comparar` y, cuando tenga fechas, `calendario`.
- [ ] **Probar en el celular** la medición con dos dedos: hasta ahora solo se probó simulada.

## 2. Terminar la 3C: fechas del calendario económico

El código ya está publicado y probado (`src/lib/calendar.ts`, `/api/calendar`, herramienta `calendario` y sección del panel). Falta cargar las fechas. Mientras `EVENTS` esté vacío, el panel oculta la sección y el conector no ofrece la herramienta.

- [ ] Cargar en `EVENTS` las fechas oficiales del resto de 2026 y de 2027, cada una verificada en su fuente. Agregar la hora oficial y su zona horaria cuando la fuente la publique:
  - **BCRP:** cronograma de las sesiones del Directorio sobre el Programa Monetario.
  - **Fed:** reuniones del FOMC (`federalreserve.gov/monetarypolicy/fomccalendars.htm`). El comunicado sale a las 2:00 p. m. hora de Nueva York.
  - **INEI:** informe técnico de precios de Lima Metropolitana.
  - **BLS:** calendario del CPI (`bls.gov/schedule/news_release/cpi.htm`), a las 8:30 a. m. hora de Nueva York.
- [ ] Completar `CALENDAR_UNTIL` y la URL exacta de cada calendario en `SOURCES`.
- [ ] Ver la sección en la vista previa y publicar.

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

## 4. Ideas para después

- Que cada amigo use su propia clave gratis de Twelve Data (lista y caché por persona) para que también vea precios.
- Reportes de empresas de EE. UU. (SEC EDGAR) y noticias.
- Medir el gasto de créditos de Twelve Data en un día normal y ajustar el freno si hace falta.
- Decidir si el repositorio sigue público (hoy lo está) o pasa a privado.
- Herramienta `precios` del conector: aceptar los símbolos también como texto («BAP, SPY»).

## 5. Mantenimiento con fecha fija

- **Cada diciembre:** agregar los feriados y cierres anticipados de la NYSE del año siguiente en `lib/market-hours.ts` (hoy están hasta 2027). Si no se hace, la app gasta créditos en los feriados.
- **Cada año:** cargar el calendario económico del año siguiente cuando las fuentes lo publiquen. El BCRP suele publicar su cronograma en diciembre.
