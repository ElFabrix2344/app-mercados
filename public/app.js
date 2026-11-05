'use strict';
// Rueda (antes «Mercados»): panel sin framework. Todo el texto que viene de la API se pone con textContent.

(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = 'America/Lima';
  const LOCALE = 'es-PE';
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Cada 10 min: el servidor solo cobra los símbolos que tocan (acciones solo con la bolsa abierta).
  const QUOTE_POLL_MS = 600_000;

  const state = {
    symbols: [],
    max: 8,
    quotes: null,
    hist: new Map(), // símbolo → { points, stats } | { error }  (rango 1A: filas y ficha)
    histBusy: false,
    selected: null,
    range: '1A', // rango de la ficha
    rangeData: new Map(), // `${símbolo}|${rango}` → { points, stats, ind } | { error } | 'cargando'
    ind: { candles: false, sma50: false, sma200: false, bb: false, vol: false, rsi: false, macd: false }, // lo que se ve en la ficha
    cmp: { picks: [], range: '1A' }, // comparar: [{ sym, slot }] (el color sigue al símbolo) y rango
    cmpData: new Map(), // `${símbolos ordenados}|${rango}` → respuesta de /api/compare | 'cargando'
    cmpError: null, // { key, message } del último intento fallido
    peruData: null, // lo último de /api/peru y /api/usa (el calendario muestra la tasa o la inflación actual)
    usaData: null,
    peruMarkets: null, // materias primas, BVL, reservas, bonos y riesgo país del BCRP (también van en la cinta)
    crypto: null, // respuesta de /api/crypto (CoinGecko): bitcoin también va en la cinta
    portfolio: null, // respuesta de /api/portfolio (cartera simulada, solo el dueño)
    news: null, // respuesta de /api/news (titulares generales)
    summary: null, // respuesta de /api/resumen (resumen del día, lo ven todos)
    newsGroup: 'todas',
    newsShown: 6,
    symbolNews: new Map(), // símbolo → { items } | { error } | 'cargando' (se piden al abrir la ficha)
    company: new Map(), // símbolo → respuesta de /api/company | { error } | 'cargando' (al abrir la ficha)
    full: new Map(), // símbolo → { points } de 5 años | { error } | 'cargando' (estacionalidad y estrategia)
    factors: new Map(), // símbolo → respuesta de /api/company/factors | { error } | 'cargando'
    fin: new Map(), // símbolo → respuesta de /api/financials | { error } | 'cargando' (SEC: ficha y sección pública)
    finSym: null, // símbolo que muestra la sección «Resultados de empresas»
    role: null, // 'owner' o 'friend' (de /api/status)
    keyed: false, // un amigo con su propia clave de Twelve Data (la de la liga): ve su lista, sus precios y sus gráficos
    birthday: null, // de /api/status, solo el día del cumpleaños del dueño: { alias, mine }
    eod: null, // respuesta de /api/eod (lista diaria: cierres, no precios en vivo)
    forecasts: null, // respuesta de /api/forecasts (pronósticos del grupo)
    calAll: false, // el calendario muestra todo lo cargado (si no, lo más cercano)
    fcEditName: false, // cambiando el nombre del ranking
    marketOpen: null, // ¿la bolsa de Nueva York está en sesión? (de /api/status y de cada pedido de precios)
    calendar: null, // respuesta de /api/calendar
    games: null, // respuesta de /api/games (liga de acciones, gráfico del día y 2/3 del promedio)
    openTutorial: false, // al llegar con /#liga, abrir el tutorial de la liga cuando cargue
    k23Edit: false, // cambiando el número de esta semana
    lookups: new Map(), // símbolo → acción abierta con el buscador: respuesta de /api/lookup | { pending, name } | { error, retry, name }
    lookupStatus: null, // { used, max, today } de /api/lookup: acciones nuevas abiertas hoy (tope del día)
    lookAdded: null, // { sym, where } la buscada que se acaba de agregar a una lista (la ficha lo confirma)
    people: null, // respuesta de /api/people (quién puede entrar; solo el dueño)
    peopleNew: null, // correo recién agregado (se marca en la lista)
    peopleBusy: false,
    notes: new Map(), // clave → { text, kind }
  };

  // Preferencias de este navegador (indicadores y comparación). Si no hay almacenamiento, se usan las de fábrica.
  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* sin almacenamiento: la preferencia dura hasta recargar */
      }
    },
  };

  // iPhone o iPad (el iPad se presenta como Mac, pero con pantalla táctil). Ahí todos los navegadores son Safari.
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ---------- formato ----------
  const nfCache = new Map();
  const nf = (dec) => {
    if (!nfCache.has(dec)) nfCache.set(dec, new Intl.NumberFormat(LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec }));
    return nfCache.get(dec);
  };
  const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
  const priceDec = (v) => (Math.abs(v) < 10 ? 4 : 2);
  const fmtPrice = (v) => (v == null ? '—' : nf(priceDec(v)).format(v));
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  /** Fracción → «+53.7%». */
  const pctFrac = (f, dec = 1) => `${sign(f)}${nf(dec).format(Math.abs(f * 100))}%`;
  /** Número que ya es porcentaje → «4.25%». */
  const rate = (v, dec = 2) => `${nf(dec).format(v)}%`;

  const fmt = (opts) => new Intl.DateTimeFormat(LOCALE, opts);
  // Las fechas YYYY-MM-DD se leen como mediodía UTC para que no cambie el día.
  const day = (iso) => new Date(`${iso}T12:00:00Z`);
  const fDay = fmt({ day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fDayYear = fmt({ day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fMonthYear = fmt({ month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fAxisMonth = fmt({ month: 'short', year: '2-digit', timeZone: 'UTC' });
  const fTime = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
  const fStamp = fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
  const fClock = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });
  const limaDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const listFmt = new Intl.ListFormat(LOCALE, { style: 'long', type: 'conjunction' });
  const listJoin = (xs) => listFmt.format(xs);

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'hace un momento';
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `hace ${h} h` : fStamp.format(new Date(iso));
  }

  /** Hora del dato: solo la hora si es de hoy (Lima), si no, fecha y hora. */
  function stamp(iso) {
    const d = new Date(iso);
    return limaDate(d) === limaDate(new Date()) ? fTime.format(d) : fStamp.format(d);
  }

  // ---------- DOM ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  function s(tag, attrs = {}) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }

  // ---------- avisos ----------
  function setNote(key, text, kind = 'info') {
    if (text) state.notes.set(key, { text, kind });
    else state.notes.delete(key);
    const b = $('banner');
    const notes = [...state.notes.values()];
    b.hidden = !notes.length;
    b.className = notes.some((n) => n.kind === 'crit') ? 'banner crit' : 'banner';
    b.replaceChildren(...notes.flatMap((n, i) => (i ? [h('br'), n.text] : [n.text])));
  }

  // ---------- API ----------
  async function api(path, init) {
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', ...init });
    } catch {
      // Una sesión de Access vencida redirige a otro dominio y fetch falla así.
      setNote('net', 'No se pudo conectar. Si la sesión de Access venció, recarga la página.', 'crit');
      throw Object.assign(new Error('Sin conexión'), { status: 0 });
    }
    setNote('net', null);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* respuesta sin JSON */
    }
    if (!res.ok) {
      throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { status: res.status, code: body?.error?.code });
    }
    return body;
  }

  // ---------- gráficos ----------
  const charts = new Map(); // host → [pts, opts] para redibujar al cambiar el ancho

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / Math.max(1, count - 1);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.floor(lo / step) * step; out.length < 12; v += step) {
      out.push(Number(v.toFixed(10)));
      if (v >= hi - step * 1e-9) break;
    }
    return { ticks: out, step };
  }

  const lastIndex = (values) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
    return -1;
  };

  /** Trazo de una serie, cortado donde falta el dato (una media no existe hasta tener sus días). */
  function linePath(values, xy) {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
      } else {
        d += `${pen ? 'L' : 'M'}${xy(i, v)}`;
        pen = true;
      }
    });
    return d;
  }

  /** Área entre dos líneas (bandas de Bollinger), por tramos con datos. */
  function bandPath(upper, lower, xy) {
    let d = '';
    let seg = [];
    const flush = () => {
      if (seg.length > 1) d += `M${seg.map((i) => xy(i, upper[i])).join('L')}L${[...seg].reverse().map((i) => xy(i, lower[i])).join('L')}Z`;
      seg = [];
    };
    upper.forEach((u, i) => (u == null || lower[i] == null ? flush() : seg.push(i)));
    flush();
    return d;
  }

  /** Barra de ancho `w` desde la base `y0` hasta `y`: punta redondeada (4px como mucho) y base recta. */
  function barPath(x, w, y, y0) {
    const len = Math.abs(y0 - y);
    if (len < 0.5) return '';
    const f = (v) => v.toFixed(1);
    const r = Math.min(4, w / 2, len);
    if (r < 1) return `M${f(x)},${f(Math.min(y, y0))}h${f(w)}v${f(len)}h${f(-w)}Z`;
    const dir = y < y0 ? 1 : -1; // 1: la barra crece hacia arriba
    return `M${f(x)},${f(y0)}V${f(y + dir * r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + dir * r)}V${f(y0)}Z`;
  }

  /**
   * Velas: mecha del mínimo al máximo y cuerpo de la apertura al cierre. Las que suben van huecas y las que bajan,
   * rellenas: así se distinguen también sin ver colores (el verde y el rojo se confunden con daltonismo).
   */
  function drawCandles(svg, { open, high, low }, close, X, Y, w) {
    const f = (v) => v.toFixed(1);
    const d = { wickUp: '', wickDown: '', up: '', down: '' };
    close.forEach((c, i) => {
      const o = open[i];
      const top = high[i];
      const bottom = low[i];
      if (c == null || o == null || top == null || bottom == null) return;
      const up = c >= o;
      const x = X(i);
      const bodyTop = Y(Math.max(o, c));
      const bodyH = Math.max(1, Y(Math.min(o, c)) - bodyTop);
      d[up ? 'wickUp' : 'wickDown'] += `M${f(x)},${f(Y(top))}V${f(Y(bottom))}`;
      d[up ? 'up' : 'down'] += `M${f(x - w / 2)},${f(bodyTop)}h${f(w)}v${f(bodyH)}h${f(-w)}Z`;
    });
    svg.append(
      s('path', { class: 'wick up', d: d.wickUp }),
      s('path', { class: 'wick down', d: d.wickDown }),
      s('path', { class: 'candle up', d: d.up }),
      s('path', { class: 'candle down', d: d.down }),
    );
  }

  /**
   * Gráfico de líneas sobre fechas comunes, con una o varias series.
   * spec.dates: ['YYYY-MM-DD', …]; spec.series: [{ name, values: [número | null], cls, tipLabel? }]: la primera es
   * la principal (va encima y su etiqueta tiene prioridad). Opcionales: band { upper, lower } (debajo de las líneas),
   * refs (valores con línea de referencia), domain [mín, máx] y ticks fijos, height, axis, xLabels, interactive, fmt,
   * dateFmt, axisDateFmt, aria, padR (número o función del ancho), endLabel(serie, valor, ancho) → texto | null,
   * extraTip(i) → filas extra del tooltip, sortTip (filas del tooltip de mayor a menor), flat (sin serie principal).
   * Medición entre dos días: measure ('main' = solo la principal, 'all' = todas, 'none' = sin medición), measureRow(serie,
   * v0, v1, spec) → { value, label } y monthly (el tramo se cuenta en meses). Una serie con kind: 'bars' se dibuja como
   * barras desde el cero (volumen, histograma); candles { open, high, low } dibuja velas con el cierre de la serie
   * principal; inset pone cada día al centro de su franja (la ficha lo usa en todos sus gráficos para que se alineen).
   * labels: textos del eje x en vez de fechas (los plazos de la curva de rendimientos); se muestran todos si caben.
   */
  function drawChart(host, spec) {
    // Si había una medición fija en este gráfico, se va con él (si no, su tooltip quedaría flotando).
    if (pinned && host.contains(pinned.svg)) pinned.clear();
    charts.set(host, spec);
    host.replaceChildren();
    const { dates, series } = spec;
    const n = dates.length;
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v) => {
      if (v != null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    };
    for (const sr of series) sr.values.forEach(take);
    // Las barras (volumen, histograma del MACD) salen de cero: el cero entra en la escala.
    if (series.some((sr) => sr.kind === 'bars')) take(0);
    if (spec.candles) {
      spec.candles.high.forEach(take);
      spec.candles.low.forEach(take);
    }
    if (spec.band) {
      spec.band.upper.forEach(take);
      spec.band.lower.forEach(take);
    }
    for (const m of spec.markers || []) take(m.v);
    if (n < 2 || lo === Infinity) {
      host.append(h('p', { class: 'muted' }, 'Sin datos suficientes.'));
      return;
    }
    (spec.refs || []).forEach(take);
    if (spec.domain) [lo, hi] = spec.domain;
    if (lo === hi) {
      const d = Math.abs(lo) * 0.01 || 1;
      lo -= d;
      hi += d;
    }
    const W = Math.max(spec.axis ? 160 : 40, Math.round(host.clientWidth || 300));
    // Sin altura fija (minigráficos) se usa la del contenedor, que cambia en el celular.
    const H = spec.height || host.clientHeight || 28;
    const padR = typeof spec.padR === 'function' ? spec.padR(W) : spec.padR ?? 76;
    const pad = spec.axis ? { l: 48, r: padR, t: 12, b: spec.xLabels === false ? 8 : 24 } : { l: 2, r: 4, t: 4, b: 4 };
    let ticks = [];
    let tickFmt = (v) => String(v);
    if (spec.axis && spec.ticks) {
      ticks = spec.ticks;
    } else if (spec.axis) {
      const t = niceTicks(lo, hi, 4);
      ticks = t.ticks;
      lo = Math.min(lo, ticks[0]);
      hi = Math.max(hi, ticks[ticks.length - 1]);
      const dec = Math.max(0, -Math.floor(Math.log10(t.step)));
      tickFmt = hi >= 10_000 ? (v) => compact.format(v) : (v) => nf(dec).format(v);
    }
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    // inset: cada día ocupa una franja y su marca va al centro, así las velas y barras de los extremos no quedan cortadas.
    const slot = spec.inset ? iw / n : iw / (n - 1);
    const X = spec.inset ? (i) => pad.l + (i + 0.5) * slot : (i) => pad.l + i * slot;
    // Velas y barras: 2px de aire entre vecinas y 24px de ancho como mucho. Varias series de barras (resultados anuales)
    // van lado a lado en la franja de cada día, con más aire entre grupos que dentro de cada uno.
    const barSeries = series.filter((sr) => sr.kind === 'bars');
    const groups = Math.max(1, barSeries.length);
    const barW = groups > 1 ? Math.min(24 * groups, slot * 0.7) : slot >= 4 ? Math.min(24, slot - 2) : Math.max(1, slot * 0.6);
    const Y = (v) => pad.t + ((hi - v) * ih) / (hi - lo);
    const xy = (i, v) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.aria || '' });
    if (spec.axis) {
      for (const t of ticks) {
        svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
        const label = s('text', { class: 'tick', x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' });
        label.textContent = tickFmt(t);
        svg.append(label);
      }
      if (spec.xLabels !== false && spec.labels) {
        // Etiquetas propias (plazos, años): todas si caben, si no, una sí y una no, contando desde la última.
        const every = iw / n >= 26 ? 1 : 2;
        spec.labels.forEach((text, i) => {
          if ((n - 1 - i) % every) return;
          const label = s('text', { class: 'tick', x: X(i), y: H - 6, 'text-anchor': 'middle' });
          label.textContent = text;
          svg.append(label);
        });
      } else if (spec.xLabels !== false) {
        // Menos etiquetas en gráficos angostos (celular), para que las fechas no se pisen.
        const labels = iw < 300 ? 2 : iw < 480 ? 3 : 4;
        const idxs = [...new Set(Array.from({ length: labels }, (_, k) => Math.round((k * (n - 1)) / (labels - 1))))];
        for (const i of idxs) {
          const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
          const label = s('text', { class: 'tick', x: X(i), y: H - 6, 'text-anchor': anchor });
          label.textContent = (spec.axisDateFmt || fAxisMonth).format(day(dates[i]));
          svg.append(label);
        }
      }
    }
    for (const r of spec.refs || []) svg.append(s('line', { class: 'ref', x1: pad.l, x2: W - pad.r, y1: Y(r), y2: Y(r) }));
    // Capa debajo de las líneas (la franja de la medición).
    const under = s('g', {});
    svg.append(under);
    if (spec.band) {
      const { upper, lower } = spec.band;
      svg.append(
        s('path', { class: 'band', d: bandPath(upper, lower, xy) }),
        s('path', { class: 'band-edge', d: linePath(upper, xy) }),
        s('path', { class: 'band-edge', d: linePath(lower, xy) }),
      );
    }
    // Barras (volumen, histograma, resultados) debajo de todo, desde el cero.
    const base = Y(Math.min(Math.max(0, lo), hi));
    const each = barW / groups;
    barSeries.forEach((sr, k) => {
      let d = '';
      sr.values.forEach((v, i) => {
        if (v == null) return;
        d += groups > 1 ? barPath(X(i) - barW / 2 + k * each + 1, Math.max(1, each - 2), Y(v), base) : barPath(X(i) - barW / 2, barW, Y(v), base);
      });
      svg.append(s('path', { class: `bars ${sr.cls || ''}`, d }));
    });
    if (spec.candles) drawCandles(svg, spec.candles, series[0].values, X, Y, barW);
    // Líneas (con velas, el cierre ya está en ellas). La serie principal se dibuja al final para quedar encima.
    const drawOrder = [...series.slice(1), series[0]].filter((sr) => sr.kind !== 'bars' && !(spec.candles && sr === series[0]));
    for (const sr of drawOrder) svg.append(s('path', { class: `line ${sr.cls || ''}`, d: linePath(sr.values, xy) }));
    // Operaciones de la cartera: ▲ compra y ▼ venta, a su precio.
    for (const m of spec.markers || []) {
      const x = X(m.i);
      const y = Y(m.v);
      const k = 6;
      const d = m.kind === 'buy' ? `M${x},${y - k}L${x + k},${y + k}L${x - k},${y + k}Z` : `M${x},${y + k}L${x + k},${y - k}L${x - k},${y - k}Z`;
      svg.append(s('path', { class: `trade ${m.kind}`, d }));
    }
    for (const sr of drawOrder) {
      const i = lastIndex(sr.values);
      if (i >= 0) svg.append(s('circle', { class: `end-dot ${sr.cls || ''}`, cx: X(i), cy: Y(sr.values[i]), r: spec.axis ? 4 : 2.5 }));
    }
    if (spec.axis) {
      // Etiquetas al final de cada línea. Si una choca con otra no se dibuja: la leyenda y el tooltip la cubren.
      const placed = [];
      series.forEach((sr, k) => {
        const i = lastIndex(sr.values);
        if (i < 0) return;
        const v = sr.values[i];
        const text = spec.endLabel ? spec.endLabel(sr, v, W) : k === 0 ? spec.fmt(v) : null;
        const y = Y(v) + 4;
        if (!text || placed.some((p) => Math.abs(p - y) < 13)) return;
        placed.push(y);
        const label = s('text', { class: k === 0 || spec.flat ? 'end-label' : 'end-label alt', x: X(i) + 8, y });
        label.textContent = text;
        svg.append(label);
      });
    }
    host.append(svg);
    if (spec.interactive) attachHover(svg, spec, { W, H, pad, X, Y, under, slot });
  }

  /** Una sola serie (minigráficos, Perú, EE. UU.). pts: [{ date: 'YYYY-MM-DD', v: número }]. */
  function drawLine(host, pts, opts) {
    drawChart(host, { ...opts, dates: pts.map((p) => p.date), series: [{ name: '', values: pts.map((p) => p.v), cls: opts.cls }] });
  }

  /** Una serie: el valor y la fecha. Varias: la fecha y una fila por serie, con el valor primero y su clave de color. */
  function tipContent(spec, i) {
    const date = spec.labels ? spec.labels[i] : (spec.dateFmt || fDayYear).format(day(spec.dates[i]));
    if (spec.series.length === 1 && !spec.extraTip) {
      const v = spec.series[0].values[i];
      return [h('strong', {}, v == null ? '—' : spec.fmt(v)), date];
    }
    const rows = spec.series
      .filter((sr) => sr.values[i] != null)
      .map((sr) => ({ cls: sr.cls, value: spec.fmt(sr.values[i]), label: sr.tipLabel ? sr.tipLabel(sr.values[i]) : sr.name, v: sr.values[i] }));
    if (spec.sortTip) rows.sort((a, b) => b.v - a.v);
    if (spec.extraTip) rows.push(...spec.extraTip(i));
    return [
      h('span', { class: 'tt-date' }, date),
      ...rows.map((r) => h('span', { class: `tt-row ${r.cls || ''}` }, h('span', { class: `key ${r.keyCls || ''}` }), h('strong', { class: r.dir || null }, r.value), r.label)),
    ];
  }

  // ---------- medir entre dos días ----------
  // Una sola medición fija a la vez (hay un solo tooltip). Un toque o clic fuera de su gráfico la borra.
  let pinned = null; // { svg, clear }
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (pinned && !pinned.svg.contains(e.target)) pinned.clear();
    },
    true,
  );

  const arrowOf = (d) => (d > 0 ? '▲' : d < 0 ? '▼' : '■');

  /** Variación en % y en la unidad del gráfico, con el valor de cada extremo. */
  function measureRowDefault(sr, v0, v1, spec) {
    const d = v1 - v0;
    return { value: `${arrowOf(d)} ${pctFrac(v1 / v0 - 1, 2)}`, label: `${sign(d)}${spec.fmt(Math.abs(d))} · ${spec.fmt(v0)} → ${spec.fmt(v1)}` };
  }

  /** Tasas (bono, inflación): la variación va en puntos porcentuales, no en % de un %. */
  function measureRowPoints(sr, v0, v1, spec) {
    const d = v1 - v0;
    return { value: `${arrowOf(d)} ${sign(d)}${nf(2).format(Math.abs(d))} pp`, label: `${spec.fmt(v0)} → ${spec.fmt(v1)}` };
  }

  /** Lectura de la medición: el tramo (fechas y duración) y una fila por serie medida. */
  function measureContent(spec, a, b) {
    const d0 = spec.dates[a];
    const d1 = spec.dates[b];
    let span;
    if (spec.monthly) {
      const m = (Number(d1.slice(0, 4)) - Number(d0.slice(0, 4))) * 12 + Number(d1.slice(5, 7)) - Number(d0.slice(5, 7));
      span = `${m} ${m === 1 ? 'mes' : 'meses'}`;
    } else {
      const days = Math.round((Date.parse(d1) - Date.parse(d0)) / 86_400_000);
      span = `${days} ${days === 1 ? 'día' : 'días'}`;
    }
    const dateFmt = spec.dateFmt || fDayYear;
    const rows = (spec.measure === 'all' ? spec.series : spec.series.slice(0, 1))
      .filter((sr) => sr.values[a] != null && sr.values[b] != null)
      .map((sr) => ({ sr, v0: sr.values[a], v1: sr.values[b] }));
    if (spec.measure === 'all') rows.sort((x, y) => y.v1 / y.v0 - x.v1 / x.v0);
    const rowOf = spec.measureRow || measureRowDefault;
    return [
      h('span', { class: 'tt-date' }, `${dateFmt.format(day(d0))} → ${dateFmt.format(day(d1))} · ${span}`),
      ...rows.map(({ sr, v0, v1 }) => {
        const r = rowOf(sr, v0, v1, spec);
        return h('span', { class: `tt-row ${sr.cls || ''}` }, h('span', { class: 'key' }), h('strong', { class: trend(v1 - v0) }, r.value), r.label);
      }),
    ];
  }

  /**
   * Interacción del gráfico. Un día: pasar el mouse, tocar con un dedo o las flechas. Dos días (medir):
   * arrastrar con el mouse, dos dedos en el celular o Mayús + flechas. La medición queda fija hasta un
   * clic o toque fuera, otro clic en el gráfico o Esc.
   */
  function attachHover(svg, spec, { W, H, pad, X, Y, under, slot }) {
    const n = spec.dates.length;
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Escape');
    const cross = s('line', { class: 'cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dots = spec.series.map((sr) => s('circle', { class: `hover-dot ${sr.cls || ''}`, r: 4, visibility: 'hidden' }));
    const canMeasure = spec.measure !== 'none';
    const measured = !canMeasure ? [] : spec.measure === 'all' ? spec.series : spec.series.slice(0, 1);
    const band = s('rect', { class: 'sel-band', y: pad.t, height: H - pad.t - pad.b, visibility: 'hidden' });
    const edges = [0, 1].map(() => s('line', { class: 'sel-edge', y1: pad.t, y2: H - pad.b, visibility: 'hidden' }));
    const ends = measured.map((sr) => [0, 1].map(() => s('circle', { class: `hover-dot ${sr.cls || ''}`, r: 4, visibility: 'hidden' })));
    under.append(band);
    svg.append(cross, ...edges, ...dots, ...ends.flat());
    const tip = $('tooltip');
    const clamp = (i) => Math.max(0, Math.min(n - 1, i));
    const vis = (el, on) => el.setAttribute('visibility', on ? 'visible' : 'hidden');
    let idx = -1; // día señalado
    let sel = null; // medición: { anchor, end } (índices)
    let drag = null; // índice donde empezó el arrastre del mouse
    let pointerActive = false;
    const touches = new Map(); // dedos sobre el gráfico: pointerId → índice
    let frozen = false; // al levantar uno de los dos dedos, la medición queda fija

    /** Tooltip a la derecha de x (o centrado), arriba de y; siempre dentro de la ventana. */
    const placeTip = (x, y, centered) => {
      const r = svg.getBoundingClientRect();
      const sx = r.width / W;
      let left = centered ? r.left + x * sx - tip.offsetWidth / 2 : r.left + x * sx + 12;
      if (!centered && left + tip.offsetWidth > window.innerWidth - 8) left = r.left + x * sx - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, r.top + y * sx - tip.offsetHeight - 10)}px`;
    };
    const hideDay = () => {
      vis(cross, false);
      for (const d of dots) vis(d, false);
    };
    const clearSel = () => {
      sel = null;
      vis(band, false);
      for (const e of edges) vis(e, false);
      for (const d of ends.flat()) vis(d, false);
      if (pinned?.svg === svg) pinned = null;
    };
    const hide = () => {
      idx = -1;
      hideDay();
      clearSel();
      tip.hidden = true;
    };
    // Hay un solo tooltip: usar este gráfico borra la medición fija de otro.
    const takeTip = () => {
      if (pinned && pinned.svg !== svg) pinned.clear();
    };
    const show = (i) => {
      takeTip();
      clearSel();
      idx = clamp(i);
      const x = X(idx);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      vis(cross, true);
      let top = H - pad.b;
      spec.series.forEach((sr, k) => {
        const v = sr.values[idx];
        // Las barras no llevan punto: el cursor y el tooltip bastan.
        vis(dots[k], v != null && sr.kind !== 'bars');
        if (v == null) return;
        dots[k].setAttribute('cx', x);
        dots[k].setAttribute('cy', Y(v));
        top = Math.min(top, Y(v));
      });
      tip.replaceChildren(...tipContent(spec, idx));
      tip.hidden = false;
      placeTip(x, top, false);
    };
    const measure = (anchor, end) => {
      anchor = clamp(anchor);
      end = clamp(end);
      if (anchor === end || !canMeasure) {
        show(end);
        return;
      }
      takeTip();
      hideDay();
      sel = { anchor, end };
      idx = end;
      const a = Math.min(anchor, end);
      const b = Math.max(anchor, end);
      band.setAttribute('x', X(a));
      band.setAttribute('width', X(b) - X(a));
      vis(band, true);
      [a, b].forEach((i, k) => {
        edges[k].setAttribute('x1', X(i));
        edges[k].setAttribute('x2', X(i));
        vis(edges[k], true);
      });
      measured.forEach((sr, k) =>
        [a, b].forEach((i, e) => {
          const v = sr.values[i];
          vis(ends[k][e], v != null);
          if (v == null) return;
          ends[k][e].setAttribute('cx', X(i));
          ends[k][e].setAttribute('cy', Y(v));
        }),
      );
      tip.replaceChildren(...measureContent(spec, a, b));
      tip.hidden = false;
      placeTip((X(a) + X(b)) / 2, pad.t, true);
      pinned = { svg, clear: hide };
    };

    const indexAt = (e) => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) * (W / r.width);
      return clamp(spec.inset ? Math.floor((x - pad.l) / slot) : Math.round((x - pad.l) / slot));
    };
    const twoFingers = () => {
      const [p, q] = touches.values();
      measure(p, q);
    };
    svg.addEventListener('pointerdown', (e) => {
      pointerActive = true;
      const i = indexAt(e);
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, i);
        frozen = false;
        if (touches.size >= 2) twoFingers();
        else show(i);
        return;
      }
      if (e.button !== 0) return;
      drag = i;
      svg.setPointerCapture?.(e.pointerId);
      show(i);
    });
    svg.addEventListener('pointermove', (e) => {
      const i = indexAt(e);
      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId) || frozen) return;
        touches.set(e.pointerId, i);
        if (touches.size >= 2) twoFingers();
        else if (!sel) show(i);
        return;
      }
      if (drag !== null) measure(drag, i);
      else if (!sel) show(i); // con una medición fija, pasar el mouse no la cambia
    });
    const release = (e) => {
      pointerActive = false;
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (sel) frozen = touches.size > 0;
        else if (!touches.size) hide();
        return;
      }
      drag = null;
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', (e) => {
      release(e);
      if (!sel) hide();
    });
    svg.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && drag === null && !sel) hide();
    });
    svg.addEventListener('blur', hide);
    // Al hacer clic el gráfico también recibe el foco: ahí no hay que saltar al último día.
    svg.addEventListener('focus', () => {
      if (!pointerActive && idx < 0) show(n - 1);
    });
    svg.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step && e.shiftKey) {
        const anchor = sel ? sel.anchor : idx >= 0 ? idx : n - 1;
        measure(anchor, (sel ? sel.end : anchor) + step);
        e.preventDefault();
        return;
      }
      const keys = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: n - 1 };
      if (e.key in keys) {
        show(keys[e.key]);
        e.preventDefault();
      } else if (e.key === 'Escape') hide();
    });
  }

  /** Redibuja los gráficos a su ancho actual (al cambiar el tamaño de la ventana o al volver a la hoja «Mercados»). */
  function redrawCharts() {
    for (const [host, spec] of charts) {
      if (host.isConnected && !host.closest('[hidden]')) drawChart(host, spec);
      else if (!host.isConnected) charts.delete(host);
    }
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      redrawCharts();
      // La carrera de la liga se dibuja al ancho de su sección (solo si se está viendo la hoja «Juego»).
      if (raceHost?.isConnected && state.games && currentSheet() === 'juego') drawRace(raceHost, state.games.liga);
    }, 150);
  });

  // ---------- lista de seguimiento ----------
  function quoteFor(sym) {
    return state.quotes?.data?.quotes?.find((q) => q.symbol === sym) ?? state.lookups.get(sym)?.quote ?? null;
  }

  /** En la lista de seguimiento o en la diaria (las que no, se abren con el buscador). */
  const inLists = (sym) => state.symbols.includes(sym) || !!state.eod?.symbols?.includes(sym);

  /**
   * Una acción abierta con el buscador (fuera de tus listas): su historial, sus titulares y sus datos se piden recién
   * cuando el servidor la anotó con su precio. 'cargando', { error } o null (ya se puede pedir).
   */
  function lookupGate(sym) {
    if (inLists(sym)) return null;
    const l = state.lookups.get(sym);
    if (!l || l.pending) return 'cargando';
    return l.quote ? null : { error: l.error ?? 'Sin precio.' };
  }

  const trend = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

  function changeEl(q) {
    if (q.changePct == null) return h('span', { class: 'c-chg flat' }, '—');
    const arrow = q.changePct > 0 ? '▲' : q.changePct < 0 ? '▼' : '■';
    // La variación absoluta va en su propio span para ocultarla en el celular.
    const abs = q.change != null ? h('span', { class: 'c-abs' }, ` (${sign(q.change)}${nf(priceDec(q.price)).format(Math.abs(q.change))})`) : null;
    return h('span', { class: `c-chg ${trend(q.changePct)}` }, `${arrow} ${sign(q.changePct)}${nf(2).format(Math.abs(q.changePct))}%`, abs);
  }

  /** Una fila por símbolo: símbolo · nombre · último · variación · 1 año · 1A % · hora. */
  function renderTiles() {
    const host = $('tiles');
    host.replaceChildren();
    for (const k of charts.keys()) if (!k.isConnected) charts.delete(k);
    for (const sym of state.symbols) {
      const q = quoteFor(sym);
      const err = state.quotes?.data?.errors?.[sym];
      const hist = state.hist.get(sym);
      const ret = hist?.stats ? hist.stats.totalReturn : null;
      const spark = h('span', { class: 'c-spark chart', 'aria-hidden': 'true' });
      const row = h('button', { type: 'button', class: q ? 'row' : 'row error', 'aria-pressed': String(state.selected === sym) });
      row.append(
        h('span', { class: 'c-sym' }, sym),
        h(
          'span',
          { class: 'c-name' },
          h('span', { class: 'c-name-text' }, q?.name ?? (err ? `Sin dato: ${err}` : state.quotes ? 'Sin dato' : 'Cargando…')),
          // Primero los resultados próximos (lo más urgente); si no caben todas, las últimas señales se ocultan.
          h('span', { class: 'c-sigs' }, earningsChip(sym), ...signalChips(hist?.latest)),
        ),
        h('span', { class: 'c-price' }, q ? fmtPrice(q.price) : '—'),
        q ? changeEl(q) : h('span', { class: 'c-chg flat' }, '—'),
        spark,
        h('span', { class: `c-ret ${ret == null ? 'flat' : trend(ret)}` }, ret != null ? pctFrac(ret) : hist?.error ? 'n.d.' : ''),
        h('span', { class: 'c-time' }, q?.asOf ? stamp(q.asOf) : ''),
      );
      row.addEventListener('click', () => select(sym));
      host.append(row);
      if (hist?.points) {
        drawLine(spark, hist.points.map(([date, v]) => ({ date, v })), { axis: false, fmt: fmtPrice });
      }
    }
    renderMarket();
  }

  /** Señales rápidas del último cierre: precio frente a la media de 200 días y, solo en zona extrema, el RSI. */
  function signalChips(l) {
    if (!l) return [];
    const chips = [];
    if (l.sma200 != null) {
      const above = l.close >= l.sma200;
      chips.push(
        h('span', { class: `sig ${above ? 'up' : 'down'}`, title: `${above ? 'Sobre' : 'Bajo'} su media de 200 días (${fmtPrice(l.sma200)})` }, `${above ? '▲' : '▼'} MM200`),
      );
    }
    if (l.rsi14 != null && (l.rsi14 >= 70 || l.rsi14 <= 30)) {
      chips.push(h('span', { class: 'sig', title: l.rsi14 >= 70 ? 'RSI sobre 70: zona de sobrecompra' : 'RSI bajo 30: zona de sobreventa' }, `RSI ${nf(0).format(l.rsi14)}`));
    }
    return chips;
  }

  /** «Rueda abierta / cerrada»: la sesión de la bolsa de Nueva York, con el mismo criterio con el que el servidor decide qué renovar. */
  function renderMarket() {
    const el = $('mkt');
    const open = state.quotes?.market?.open ?? state.marketOpen;
    // En computadora, «Rueda abierta · NYSE»; en el celular, más corto (styles.css, .mkt-x y .mkt-cel).
    if (open == null) el.replaceChildren();
    else el.replaceChildren(h('span', { class: 'mkt-x' }, `Rueda ${open ? 'abierta' : 'cerrada'} · NYSE`), h('span', { class: 'mkt-cel' }, `NYSE ${open ? 'abierta' : 'cerrada'}`));
    el.className = open ? 'mkt open' : 'mkt';
    el.title = open == null ? '' : open ? 'La bolsa de Nueva York está en sesión.' : 'Fuera del horario de la bolsa de Nueva York: las acciones muestran su último cierre.';
  }

  // ---------- cinta de precios ----------
  /** Variación del último dato contra el anterior de una serie [fecha, valor][]. */
  const lastChange = (pts) => (pts?.length >= 2 ? pts.at(-1)[1] / pts.at(-2)[1] - 1 : null);

  /**
   * Lo que pasa por la cinta: la lista (precios ya guardados, sin gastar créditos) y, para todos, los datos públicos
   * del BCRP y de FRED. Un amigo tiene lista solo con su propia clave: la licencia de Twelve Data no deja mostrarle la
   * de Rueda.
   */
  function tapeItems() {
    const items = [];
    for (const sym of state.symbols) {
      const q = quoteFor(sym);
      if (q?.price != null) items.push({ sym, value: fmtPrice(q.price), ch: q.changePct != null ? q.changePct / 100 : null });
    }
    const fx = state.peruData?.fx;
    if (fx?.length) items.push({ sym: 'Dólar BCRP', value: nf(4).format(fx.at(-1).sell), ch: fx.length > 1 ? fx.at(-1).sell / fx.at(-2).sell - 1 : null });
    const pm = state.peruMarkets;
    for (const [key, label] of [['copper', 'Cobre'], ['gold', 'Oro'], ['oil', 'Petróleo'], ['bvl', 'BVL']]) {
      const pts = pm?.[key]?.points;
      if (pts?.length) items.push({ sym: label, value: nf(2).format(pts.at(-1)[1]), ch: lastChange(pts) });
    }
    // Bitcoin de CoinGecko (público), si no está ya en la lista.
    const btc = state.crypto?.coins?.bitcoin;
    if (btc?.summary?.last && !items.some((it) => it.sym === 'BTC/USD')) items.push({ sym: 'Bitcoin', value: nf(0).format(btc.summary.last.value), ch: btc.change24h });
    const pe10 = pm?.bond10pen?.points;
    if (pe10?.length) items.push({ sym: 'Bono Perú 10A', value: rate(pe10.at(-1)[1]), pp: pe10.length > 1 ? pe10.at(-1)[1] - pe10.at(-2)[1] : null });
    const t10 = state.usaData?.treasury10y;
    if (t10?.length) items.push({ sym: 'Bono EE. UU. 10A', value: rate(t10.at(-1).value), pp: t10.length > 1 ? t10.at(-1).value - t10.at(-2).value : null });
    // El día del cumpleaños del dueño, primero en la cinta (si ya hay datos que mostrar).
    const b = state.birthday;
    if (b && items.length) items.unshift({ sym: 'Cumpleaños', value: b.alias ?? 'Rueda', text: '▲ +1 año', cls: 'up' });
    return items;
  }

  /** ¿La cinta se mueve? Lo que elegiste en este navegador o, si no, lo que pide el sistema («menos movimiento» = quieta). */
  function tapeMoving() {
    const saved = prefs.get('mercados.cinta', null);
    if (saved === 'mover' || saved === 'quieta') return saved === 'mover';
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  function applyTapeMotion() {
    const moving = tapeMoving();
    $('tape').classList.toggle('still', !moving);
    const b = $('tape-toggle');
    b.textContent = moving ? '⏸' : '▶';
    b.setAttribute('aria-label', moving ? 'Detener la cinta de precios' : 'Mover la cinta de precios');
    b.title = b.getAttribute('aria-label');
  }

  function renderTape() {
    const items = tapeItems();
    $('tape').hidden = !items.length;
    if (!items.length) return;
    const half = () =>
      h(
        'span',
        { class: 'tape-half' },
        ...items.map((it) => {
          const d = it.pp ?? it.ch;
          const text = it.text ?? (d == null ? null : it.pp != null ? `${arrowOf(d)} ${sign(d)}${nf(2).format(Math.abs(d))} pp` : `${arrowOf(d)} ${pctFrac(d, 2)}`);
          return h('span', { class: 'tape-item' }, h('span', { class: 'tape-sym' }, it.sym), it.value, text ? h('span', { class: it.cls ?? trend(d) }, text) : null);
        }),
      );
    const track = $('tape-track');
    // Dos copias seguidas: al correr media cinta vuelve a empezar sin que se note el corte.
    track.replaceChildren(half(), half());
    track.style.animationDuration = `${Math.max(30, items.length * 6)}s`;
  }

  // ---------- cumpleaños del dueño (OWNER_BIRTHDAY) ----------
  // Ese día, para todos y sin molestar: un chip junto a la hora, una línea en la cinta y la fecha en la agenda. Al
  // dueño se lo saluda; a los demás se les avisa. El confeti sale solo si alguien toca el chip.
  const birthdayName = (b) => b.alias ?? 'quien creó Rueda';

  function renderBirthday() {
    const b = state.birthday;
    const chip = $('cumple');
    chip.hidden = !b;
    if (!b) return;
    $('cumple-text').textContent = b.mine ? '¡Feliz cumple!' : `Hoy cumple ${birthdayName(b)}`;
    chip.title = b.mine ? '¡Feliz cumpleaños! Toca para tirar confeti.' : `Hoy es el cumpleaños de ${birthdayName(b)}. Toca para tirar confeti.`;
  }

  /** Un puñado de confeti que sale del chip y cae (unos 2,5 s), con colores de la paleta. Con «menos movimiento», solo 🎉. */
  function confetti() {
    const chip = $('cumple');
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      chip.classList.add('cheers');
      setTimeout(() => chip.classList.remove('cheers'), 2500);
      return;
    }
    document.querySelector('canvas.confeti')?.remove();
    const canvas = h('canvas', { class: 'confeti', 'aria-hidden': 'true' });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    document.body.append(canvas);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const colors = ['--accent', '--ink', '--s2', '--s3', '--s4'].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
    const at = chip.getBoundingClientRect();
    const pieces = Array.from({ length: 90 }, () => {
      // Hacia arriba, en un abanico; después cae con la gravedad.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
      const speed = 6 + Math.random() * 7;
      return {
        x: at.left + at.width / 2,
        y: at.top + at.height / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 4 + Math.random() * 4,
        h: 7 + Math.random() * 6,
        r: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: colors[Math.floor(Math.random() * colors.length)],
      };
    });
    const DURATION = 2600;
    const start = performance.now();
    let last = start;
    const frame = (t) => {
      const age = t - start;
      // Pasos medidos en cuadros de 60 por segundo: cae igual en una pantalla de 60 Hz que en una de 120 Hz.
      const dt = Math.min(3, Math.max(0, (t - last) / 16.7));
      last = t;
      ctx.clearRect(0, 0, W, H);
      // Se desvanece en el último 40 %.
      ctx.globalAlpha = Math.min(1, Math.max(0, (DURATION - age) / (DURATION * 0.4)));
      for (const p of pieces) {
        p.vy += 0.25 * dt;
        p.vx *= 0.99 ** dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (age < DURATION) requestAnimationFrame(frame);
      else canvas.remove();
    };
    requestAnimationFrame(frame);
  }

  /** El cumpleaños en la agenda: el servidor lo manda aparte (no es un evento del mercado) y va en su día. */
  function withBirthday(events, b) {
    if (!b) return events;
    const ev = { date: b.date, kind: 'cumple', title: b.mine ? 'Tu cumpleaños' : `Cumpleaños de ${birthdayName(b)}`, at: null };
    const i = events.findIndex((e) => e.date > b.date);
    return i === -1 ? [...events, ev] : [...events.slice(0, i), ev, ...events.slice(i)];
  }

  function renderClock() {
    // En el celular no va «Lima» (styles.css, .clock-tz): la línea de arriba es chica.
    $('today').replaceChildren(fClock.format(new Date()).replace(/\./g, ''), h('span', { class: 'clock-tz' }, ' Lima'));
  }

  function renderFresh() {
    renderClock();
    const f = $('fresh');
    const q = state.quotes;
    if (!q) return;
    f.textContent = q.stale ? `Guardado ${ago(q.fetchedAt)}` : `Actualizado ${ago(q.fetchedAt)}`;
    f.classList.toggle('stale', !!q.stale);
    const c = q.credits;
    if (c) {
      const pill = $('credits');
      pill.textContent = `${c.used} / ${c.cap} créditos`;
      pill.classList.toggle('warn', c.used > c.cap * 0.8);
    }
  }

  async function loadQuotes(refresh) {
    const btn = $('refresh-btn');
    btn.disabled = true;
    try {
      state.quotes = await api(`/api/quotes${refresh ? '?refresh=1' : ''}`);
      if (state.quotes?.market) state.marketOpen = state.quotes.market.open;
      // La cartera se valoriza con los precios guardados: con precios nuevos, se vuelve a pedir.
      if (state.portfolio) loadPortfolio();
      setNote('quotes', state.quotes.stale && state.quotes.note ? `Precios guardados: ${state.quotes.note}` : null);
      setNote('mock', state.quotes.note === 'Datos de prueba' ? 'Datos de prueba: no son precios reales.' : null);
    } catch (e) {
      setNote('quotes', `Precios: ${e.message}`, 'crit');
    } finally {
      btn.disabled = false;
    }
    renderTiles();
    renderTape();
    renderFresh();
    if (state.selected) renderDetail();
    // El comparador por P/S usa los precios de tu lista, y los hechos de la SMV abren la ficha de sus empresas.
    if (psState.sym) renderPsSection();
    if (smv.feed) renderSmv();
  }

  async function loadHistories() {
    if (state.histBusy) return;
    state.histBusy = true;
    let waiting = false;
    for (const sym of state.symbols) {
      if (state.hist.has(sym)) continue;
      try {
        const r = await api(`/api/history?symbol=${encodeURIComponent(sym)}`);
        state.hist.set(sym, { points: r.data.points, stats: r.stats, latest: r.latest });
      } catch (e) {
        if (e.status === 429) {
          waiting = true;
          break;
        }
        state.hist.set(sym, { error: e.message });
      }
      renderTiles();
      if (state.selected === sym) renderDetail();
    }
    state.histBusy = false;
    const note = $('hist-note');
    note.hidden = !waiting;
    note.textContent = waiting ? 'Algunos gráficos llegan en un minuto: el plan gratis permite 8 créditos por minuto.' : '';
    if (waiting) setTimeout(loadHistories, 65_000);
  }

  // ---------- ficha ----------
  // En computadora va en «Acciones», al lado de tu lista. En el celular (pedido del usuario el 5 nov) se abre a pantalla
  // completa, con «← Volver», que deja la hoja donde estaba; el botón atrás del teléfono hace lo mismo.
  let fichaBack = null; // { sheet, y, focus }: dónde estabas al abrirla en el celular
  const fichaFull = () => document.body.classList.contains('ficha-abierta');

  /** Una fila de la lista: abre su ficha o, si ya está abierta, la cierra. */
  function select(sym) {
    if (state.selected === sym) closeDetail();
    else openDetail(sym);
  }

  function openDetail(sym) {
    state.selected = sym;
    if (isPhone() && !fichaFull()) {
      fichaBack = { sheet: currentSheet(), y: scrollY, focus: document.activeElement };
      document.body.classList.add('ficha-abierta');
      history.pushState({ ficha: true }, '');
    }
    $('d-close').textContent = fichaFull() ? '← Volver' : 'Cerrar';
    showSheet('acciones');
    renderTiles();
    renderEod();
    renderDetail();
    if (fichaFull()) $('detail').scrollTop = 0;
    else $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** Cierra la ficha. En el celular vuelve a la hoja y al lugar de antes (`fromHistory`: el teléfono ya fue atrás). */
  function closeDetail(fromHistory = false) {
    state.selected = null;
    renderTiles();
    renderEod();
    renderDetail();
    if (!fichaFull()) return;
    document.body.classList.remove('ficha-abierta');
    const back = fichaBack;
    fichaBack = null;
    if (back) {
      showSheet(back.sheet);
      window.scrollTo(0, back.y);
      if (back.focus?.isConnected) back.focus.focus({ preventScroll: true });
    }
    if (!fromHistory && history.state?.ficha) history.back();
  }

  function stat(label, value, sub) {
    return h('div', {}, h('dt', {}, label), h('dd', {}, value, sub ? h('small', {}, sub) : null));
  }

  const RANGES = ['1M', '3M', '6M', 'YTD', '1A', '3A', '5A'];
  const RANGE_NAMES = { '1M': 'el último mes', '3M': 'los últimos 3 meses', '6M': 'los últimos 6 meses', YTD: 'lo que va del año', '1A': 'el último año', '3A': 'los últimos 3 años', '5A': 'los últimos 5 años' };

  /**
   * Historial de la ficha en el rango elegido, con indicadores (se piden una vez por rango; salen de la
   * caché del servidor, sin créditos). Mientras llegan, 1A se dibuja con lo que ya cargaron las filas.
   */
  function detailHistory(sym, range) {
    const key = `${sym}|${range}`;
    const cached = state.rangeData.get(key);
    if (cached && cached !== 'cargando') return cached;
    if (!cached) {
      const gate = lookupGate(sym);
      if (gate) return gate === 'cargando' ? undefined : gate;
      state.rangeData.set(key, 'cargando');
      api(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&ind=1`)
        .then((r) => {
          state.rangeData.set(key, { points: r.data.points, stats: r.stats, ind: r.indicators, bars: r.bars ?? null });
          // Una buscada no tiene fila en la lista: su año y su último cierre (resumen y señales) salen de aquí.
          if (range === '1A' && !state.hist.has(sym)) state.hist.set(sym, { points: r.data.points, stats: r.stats, latest: r.latest });
        })
        .catch((e) => state.rangeData.set(key, { error: e.message }))
        .finally(() => {
          if (state.selected === sym && state.range === range) renderDetail();
        });
    }
    return range === '1A' ? state.hist.get(sym) : undefined;
  }

  function rangeButtons(current, onPick) {
    return RANGES.map((r) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(current === r) }, r);
      b.addEventListener('click', () => onPick(r));
      return b;
    });
  }

  function renderRanges() {
    $('d-ranges').replaceChildren(
      ...rangeButtons(state.range, (r) => {
        state.range = r;
        renderDetail();
      }),
    );
  }

  // Colores validados para daltonismo sobre el panel: precio s1, MM50 s4, MM200 s2 (todas las parejas). En los paneles de
  // abajo, la línea principal va en s3 (RSI y MACD) y la señal del MACD en s4, como la otra media (s3–s4 es pareja validada).
  const INDICATORS = [
    { key: 'candles', label: 'Velas', keyCls: 'candle', title: 'Velas japonesas: apertura, máximo, mínimo y cierre de cada día (hasta 1 año)' },
    { key: 'sma50', label: 'MM50', cls: 's4', title: 'Media móvil simple de 50 días' },
    { key: 'sma200', label: 'MM200', cls: 's2', title: 'Media móvil simple de 200 días' },
    { key: 'bb', label: 'Bollinger', keyCls: 'band', title: 'Bandas de Bollinger: media de 20 días ± 2 desviaciones estándar' },
    { key: 'vol', label: 'Volumen', keyCls: 'bars', title: 'Volumen diario (panel debajo del gráfico)' },
    { key: 'rsi', label: 'RSI 14', cls: 's3', title: 'Índice de fuerza relativa de 14 días (panel debajo del gráfico)' },
    { key: 'macd', label: 'MACD', cls: 's3', title: 'MACD (12, 26, 9): media exponencial de 12 días menos la de 26, con su señal de 9 días (panel debajo)' },
  ];
  /** Rangos con velas: en 3 y 5 años cada vela tendría menos de 1 px. */
  const CANDLE_RANGES = new Set(['1M', '3M', '6M', 'YTD', '1A']);

  /** Por qué no se puede prender algo en este rango o símbolo (null si se puede). `bars`: undefined mientras llegan. */
  function unavailable(key, bars) {
    if (key === 'candles') {
      if (!CANDLE_RANGES.has(state.range)) return 'Las velas se ven hasta 1 año: en 3 y 5 años serían demasiado finas.';
      if (bars === null) return 'Todavía no hay velas guardadas para este símbolo.';
    }
    if (key === 'vol' && (bars === null || (bars && !bars.volume.some((v) => v > 0)))) return 'Sin volumen para este símbolo (las divisas no lo traen).';
    return null;
  }

  /** Leyenda de la ficha: «Cierre» (o cómo leer las velas) y un botón por indicador, con la clave de su línea o marca. */
  function renderIndicatorToggles(hist) {
    const bars = hist?.bars;
    const candlesOn = state.ind.candles && !unavailable('candles', bars);
    $('d-ind').replaceChildren(
      candlesOn
        ? h('span', { class: 'legend-item' }, h('span', { class: 'key candle' }), 'Velas: hueca sube, rellena baja')
        : h('span', { class: 'legend-item s1' }, h('span', { class: 'key' }), 'Cierre'),
      ...INDICATORS.map((it) => {
        const off = unavailable(it.key, bars);
        const b = h(
          'button',
          { type: 'button', class: `tog ${it.cls || ''}`, 'aria-pressed': String(!!state.ind[it.key] && !off), title: off ?? it.title, disabled: !!off },
          h('span', { class: `key ${it.keyCls || ''}` }),
          it.label,
        );
        b.addEventListener('click', () => {
          state.ind[it.key] = !state.ind[it.key];
          prefs.set('mercados.indicadores', state.ind);
          renderDetail();
        });
        return b;
      }),
    );
  }

  function renderDetail() {
    const sym = state.selected;
    const sec = $('detail');
    if (!sym) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    const hapi = $('d-hapi');
    hapi.hidden = sym.includes('/');
    hapi.href = hapiUrl(sym);
    renderRanges();
    renderSymbolNews();
    renderDetailSmv();
    renderEarnings(sym);
    renderCompany();
    renderSeason();
    renderStrategy();
    renderDetailFin();
    renderDetailPs();
    renderDetailVal();
    renderQuick();
    renderLook(sym);
    $('d-claude').href = detailClaudeHref(sym);
    const q = quoteFor(sym);
    const hist = detailHistory(sym, state.range);
    renderIndicatorToggles(hist);
    const eodRow = q ? null : eodRowFor(sym);
    const name = q?.name ?? eodRow?.name ?? state.lookups.get(sym)?.name;
    $('d-title').textContent = name ? `${sym} · ${name}` : sym;
    $('d-sub').textContent = q ? [q.exchange, q.currency].filter(Boolean).join(' · ') : eodRow ? `Lista diaria · cierre del ${fDayYear.format(day(eodRow.date))}` : '';
    const chart = $('d-chart');
    const rsiWrap = $('d-rsi-wrap');
    const rsiHost = $('d-rsi');
    const volWrap = $('d-vol-wrap');
    const volHost = $('d-vol');
    const macdWrap = $('d-macd-wrap');
    const macdHost = $('d-macd');
    const stats = $('d-stats');
    const tbody = $('d-table').tBodies[0];
    const csvBtn = $('d-csv');
    csvBtn.disabled = !hist?.points;
    // Mientras llega otro rango queda el gráfico anterior, atenuado: sin saltos ni parpadeos.
    sec.classList.toggle('is-loading', !hist && chart.childElementCount > 0);
    if (!hist) {
      const looking = state.lookups.get(sym)?.pending && !inLists(sym);
      if (!chart.childElementCount) chart.replaceChildren(h('p', { class: 'muted' }, looking ? `Buscando el precio de ${sym}…` : 'Cargando historial…'));
      return;
    }
    stats.replaceChildren();
    tbody.replaceChildren();
    if (hist.error) {
      for (const host of [chart, rsiHost, volHost, macdHost]) charts.delete(host);
      rsiWrap.hidden = true;
      volWrap.hidden = true;
      macdWrap.hidden = true;
      chart.replaceChildren(h('p', { class: 'err' }, hist.error));
      return;
    }
    const dates = hist.points.map(([date]) => date);
    const pts = hist.points.map(([date, v]) => ({ date, v }));
    const ind = hist.ind; // falta mientras llegan los indicadores
    const on = (k) => !!(ind && state.ind[k]);
    const bars = hist.bars ?? null; // velas y volumen: llegan con los indicadores
    const candles = state.ind.candles && !unavailable('candles', hist.bars) && bars ? bars : null;
    const series = [{ name: 'Cierre', values: pts.map((p) => p.v), cls: 's1' }];
    if (on('sma50')) series.push({ name: 'MM50', values: ind.sma50, cls: 's4' });
    if (on('sma200')) series.push({ name: 'MM200', values: ind.sma200, cls: 's2' });
    const extras = [on('sma50') && 'la media de 50 días', on('sma200') && 'la media de 200 días', on('bb') && 'las bandas de Bollinger'].filter(Boolean);
    // Tus operaciones de la cartera simulada en este rango (si cayeron en un día sin rueda, van al día hábil anterior).
    const markers = (state.portfolio?.trades ?? [])
      .filter((t) => t.symbol === sym && t.date >= dates[0] && t.date <= dates[dates.length - 1])
      .map((t) => {
        let i = dates.length - 1;
        while (i > 0 && dates[i] > t.date) i--;
        return { i, v: t.price, kind: t.side, t };
      });
    const tradeRows = (i) =>
      markers
        .filter((m) => m.i === i)
        .map((m) => ({ keyCls: 'none', dir: m.kind === 'buy' ? 'up' : 'down', value: m.kind === 'buy' ? '▲ Compra' : '▼ Venta', label: `${qtyFmt.format(m.t.qty)} a ${fmtPrice(m.t.price)}` }));
    const short = state.range === '1M' || state.range === '3M';
    drawChart(chart, {
      dates,
      series,
      band: on('bb') ? { upper: ind.bbUpper, lower: ind.bbLower } : null,
      height: 260,
      axis: true,
      interactive: true,
      fmt: fmtPrice,
      axisDateFmt: short ? fDay : fAxisMonth,
      aria: `Cierre diario de ${sym} en ${RANGE_NAMES[state.range]}${extras.length ? `, con ${listJoin(extras)}` : ''}`,
      endLabel: (sr, v) => (sr.cls === 's1' ? fmtPrice(v) : sr.name),
      markers,
      inset: true,
      candles: candles && { open: candles.open, high: candles.high, low: candles.low },
      extraTip:
        candles || on('bb') || on('rsi') || markers.length
          ? (i) => [
              ...(candles && candles.open[i] != null
                ? [
                    { keyCls: 'none', value: fmtPrice(candles.open[i]), label: 'Apertura' },
                    { keyCls: 'none', value: fmtPrice(candles.high[i]), label: 'Máximo' },
                    { keyCls: 'none', value: fmtPrice(candles.low[i]), label: 'Mínimo' },
                  ]
                : []),
              ...(on('bb') && ind.bbUpper[i] != null
                ? [{ keyCls: 'band', value: `${fmtPrice(ind.bbLower[i])} – ${fmtPrice(ind.bbUpper[i])}`, label: 'Bollinger' }]
                : []),
              ...(on('rsi') && ind.rsi14[i] != null ? [{ cls: 's3', value: nf(1).format(ind.rsi14[i]), label: 'RSI 14' }] : []),
              ...tradeRows(i),
            ]
          : null,
    });
    if (markers.length) $('d-ind').append(h('span', { class: 'legend-item' }, '▲▼ tus operaciones'));
    rsiWrap.hidden = !on('rsi');
    if (on('rsi')) {
      drawChart(rsiHost, {
        dates,
        series: [{ name: 'RSI 14', values: ind.rsi14, cls: 's3' }],
        domain: [0, 100],
        ticks: [30, 70],
        height: 96,
        axis: true,
        xLabels: false,
        interactive: true,
        inset: true,
        fmt: (v) => nf(1).format(v),
        endLabel: (sr, v) => nf(0).format(v),
        measureRow: (sr, v0, v1) => ({ value: `${arrowOf(v1 - v0)} ${sign(v1 - v0)}${nf(1).format(Math.abs(v1 - v0))}`, label: `RSI ${nf(1).format(v0)} → ${nf(1).format(v1)}` }),
        aria: `RSI de 14 días de ${sym} en ${RANGE_NAMES[state.range]}`,
      });
    } else {
      charts.delete(rsiHost);
    }
    // Volumen: panel aparte (otra escala; nunca dos ejes en un mismo gráfico).
    const showVol = state.ind.vol && !!bars && !unavailable('vol', bars);
    volWrap.hidden = !showVol;
    if (showVol) {
      // Acciones: el consolidado de las bolsas de EE. UU. (verificado contra Nasdaq); cripto: el del exchange que da el precio.
      $('d-vol-hint').textContent = sym.includes('/') ? 'Volumen diario (del exchange que da el precio)' : 'Volumen diario (acciones negociadas en todas las bolsas de EE. UU.)';
      drawChart(volHost, {
        dates,
        series: [{ name: 'Volumen', values: bars.volume, cls: 'vol', kind: 'bars' }],
        height: 90,
        axis: true,
        xLabels: false,
        interactive: true,
        inset: true,
        measure: 'none',
        fmt: (v) => compact.format(v),
        aria: `Volumen diario de ${sym} en ${RANGE_NAMES[state.range]}`,
      });
    } else {
      charts.delete(volHost);
    }
    macdWrap.hidden = !on('macd');
    if (on('macd')) {
      drawChart(macdHost, {
        dates,
        series: [
          { name: 'MACD', values: ind.macd, cls: 's3' },
          { name: 'Señal', values: ind.macdSignal, cls: 's4' },
          { name: 'Histograma', values: ind.macdHist, cls: 'hist', kind: 'bars' },
        ],
        refs: [0],
        height: 110,
        axis: true,
        xLabels: false,
        interactive: true,
        inset: true,
        fmt: (v) => nf(2).format(v),
        endLabel: (sr, v) => (sr.kind === 'bars' ? null : sr.cls === 's3' ? nf(2).format(v) : sr.name),
        measureRow: (sr, v0, v1) => ({ value: `${arrowOf(v1 - v0)} ${sign(v1 - v0)}${nf(2).format(Math.abs(v1 - v0))}`, label: `MACD ${nf(2).format(v0)} → ${nf(2).format(v1)}` }),
        aria: `MACD (12, 26, 9) de ${sym} en ${RANGE_NAMES[state.range]}`,
      });
    } else {
      charts.delete(macdHost);
    }
    csvBtn.onclick = () => {
      const header = ['fecha', 'cierre', 'rendimiento_diario'];
      if (bars) header.push('apertura', 'maximo', 'minimo', 'volumen');
      if (ind) header.push('mm50', 'mm200', 'bollinger_sup', 'bollinger_inf', 'rsi14', 'macd', 'macd_senal', 'macd_histograma');
      const rows = hist.points.map(([date, close], i) => {
        const row = [date, close, i ? round6(close / hist.points[i - 1][1] - 1) : ''];
        if (bars) row.push(bars.open[i], bars.high[i], bars.low[i], bars.volume[i]);
        if (ind) row.push(ind.sma50[i], ind.sma200[i], ind.bbUpper[i], ind.bbLower[i], ind.rsi14[i], ind.macd[i], ind.macdSignal[i], ind.macdHist[i]);
        return row;
      });
      downloadCsv(`${sym.replace('/', '-')}_${state.range}_${today()}.csv`, header, rows);
    };

    const st = hist.stats;
    if (st) {
      stats.append(
        stat('Rendimiento en el periodo', pctFrac(st.totalReturn), `${fDayYear.format(day(st.from))} → ${fDayYear.format(day(st.to))}`),
        stat('Volatilidad anualizada', st.annualVol != null ? pctFrac(st.annualVol).replace('+', '') : '—'),
        stat(
          'Mayor caída desde un pico',
          st.maxDrawdown ? pctFrac(st.maxDrawdown.value) : 'Sin caídas',
          st.maxDrawdown ? `${fDayYear.format(day(st.maxDrawdown.peakDate))} → ${fDayYear.format(day(st.maxDrawdown.troughDate))}` : null,
        ),
        stat('Peor día', st.worstDay ? pctFrac(st.worstDay.ret) : '—', st.worstDay ? fDayYear.format(day(st.worstDay.date)) : null),
        stat('Mejor día', st.bestDay ? pctFrac(st.bestDay.ret) : '—', st.bestDay ? fDayYear.format(day(st.bestDay.date)) : null),
        stat('Cierre máximo', fmtPrice(st.maxClose.value), fDayYear.format(day(st.maxClose.date))),
        stat('Cierre mínimo', fmtPrice(st.minClose.value), fDayYear.format(day(st.minClose.date))),
      );
    }
    // Lectura técnica del último cierre (la misma en cualquier rango).
    if (ind) {
      const last = pts.at(-1).v;
      const mm200 = ind.sma200.at(-1);
      const r = ind.rsi14.at(-1);
      if (r != null) {
        stats.append(stat('RSI 14 (último cierre)', nf(0).format(r), r > 70 ? 'Sobre 70: zona de sobrecompra' : r < 30 ? 'Bajo 30: zona de sobreventa' : 'Entre 30 y 70: zona neutral'));
      }
      if (mm200 != null) stats.append(stat('Cierre frente a la MM200', pctFrac(last / mm200 - 1), `Media de 200 días: ${fmtPrice(mm200)}`));
    }
    // Tabla: último cierre de cada mes y su variación frente al mes anterior.
    const byMonth = new Map();
    for (const p of pts) byMonth.set(p.date.slice(0, 7), p);
    let prev = null;
    for (const p of byMonth.values()) {
      tbody.append(
        h('tr', {}, h('td', {}, fMonthYear.format(day(p.date))), h('td', {}, fmtPrice(p.v)), h('td', {}, prev ? pctFrac(p.v / prev - 1) : '—')),
      );
      prev = p.v;
    }
  }

  // ---------- estacionalidad y estrategia (ficha) ----------
  // Usan los 5 años que el servidor ya tiene guardados: no gastan créditos. Se calculan aquí, al abrir cada bloque.

  /** Los 5 años de cierres de un símbolo, una vez por sesión. Al llegar se dibujan los dos bloques que estén abiertos. */
  function fullHistory(sym) {
    const c = state.full.get(sym);
    if (c && c !== 'cargando') return c;
    if (!c) {
      const gate = lookupGate(sym);
      if (gate) return gate === 'cargando' ? undefined : gate;
      state.full.set(sym, 'cargando');
      api(`/api/history?symbol=${encodeURIComponent(sym)}&range=5A`)
        .then((r) => state.full.set(sym, { points: r.data.points }))
        .catch((e) => state.full.set(sym, { error: e.message }))
        .finally(() => {
          if (state.selected !== sym) return;
          renderSeason();
          renderStrategy();
          renderDetailPs();
          renderQuick();
        });
    }
    return undefined;
  }

  const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];

  /** Rendimiento de cada mes (último cierre del mes frente al del mes anterior) y de cada año, por año. */
  function monthlyReturns(points) {
    const ends = new Map();
    for (const [d, c] of points) ends.set(d.slice(0, 7), c);
    const months = [...ends.keys()].sort();
    const rows = new Map();
    for (let i = 1; i < months.length; i++) {
      const y = months[i].slice(0, 4);
      if (!rows.has(y)) rows.set(y, new Array(12).fill(null));
      rows.get(y)[Number(months[i].slice(5, 7)) - 1] = ends.get(months[i]) / ends.get(months[i - 1]) - 1;
    }
    const years = [...rows.keys()].sort().reverse();
    const yearRet = new Map();
    for (const y of years) {
      const last = months.filter((m) => m.startsWith(y)).at(-1);
      const before = months.filter((m) => m < `${y}-01`).at(-1);
      if (last && before) yearRet.set(y, ends.get(last) / ends.get(before) - 1);
    }
    return { years, rows, yearRet, current: limaDate(new Date()).slice(0, 7) };
  }

  // Divergente azul ↔ rojo con gris al medio (guía dataviz, modo oscuro): el número va dentro de cada celda.
  const HEAT_POS = [0x25, 0x6a, 0xbf];
  const HEAT_NEG = [0xb8, 0x40, 0x3e];
  const HEAT_MID = [0x38, 0x38, 0x35];
  const heat = (v, cap) => {
    const t = Math.min(1, Math.abs(v) / cap);
    const pole = v >= 0 ? HEAT_POS : HEAT_NEG;
    return `rgb(${HEAT_MID.map((m, i) => Math.round(m + (pole[i] - m) * t)).join(',')})`;
  };
  const pct1 = (v) => `${sign(v)}${nf(1).format(Math.abs(v * 100))}`;

  function renderSeason() {
    const box = $('d-season');
    const body = $('d-season-body');
    const sym = state.selected;
    if (!sym || !box.open) return;
    const full = fullHistory(sym);
    if (!full) return body.replaceChildren(h('p', { class: 'muted' }, 'Calculando con los 5 años guardados…'));
    if (full.error) return body.replaceChildren(h('p', { class: 'err' }, full.error));
    const { years, rows, yearRet, current } = monthlyReturns(full.points);
    const all = years.flatMap((y) => rows.get(y).filter((v) => v != null).map(Math.abs)).sort((a, b) => a - b);
    // Tope del color: el percentil 90 de los movimientos de este símbolo (la cripto se mueve más que un banco).
    const cap = all[Math.floor(all.length * 0.9)] || 0.05;
    const cell = (v, extra = '') => {
      const td = h('td', { class: extra || null }, v == null ? '' : pct1(v));
      if (v != null) td.style.background = heat(v, cap);
      return td;
    };
    // Promedio y meses en alza de cada mes, sin el mes en curso (todavía no cerró).
    const avg = MONTHS_SHORT.map((_, m) => {
      const mm = String(m + 1).padStart(2, '0');
      const xs = years.filter((y) => `${y}-${mm}` !== current).map((y) => rows.get(y)[m]).filter((v) => v != null);
      return xs.length ? { mean: xs.reduce((a, b) => a + b, 0) / xs.length, up: xs.filter((v) => v > 0).length, n: xs.length } : null;
    });
    const table = h(
      'table',
      { class: 'season' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Año'), ...MONTHS_SHORT.map((m) => h('th', { scope: 'col' }, m)), h('th', { scope: 'col' }, 'Año'))),
      h(
        'tbody',
        {},
        ...years.map((y) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, y),
            ...rows.get(y).map((v, m) => cell(v, `${y}-${String(m + 1).padStart(2, '0')}` === current ? 'now' : '')),
            cell(yearRet.get(y) ?? null, 'year'),
          ),
        ),
      ),
      h(
        'tfoot',
        {},
        h('tr', {}, h('th', { scope: 'row' }, 'Promedio'), ...avg.map((a) => cell(a ? a.mean : null)), h('td', {}, '')),
        h('tr', {}, h('th', { scope: 'row' }, 'Subió'), ...avg.map((a) => h('td', { class: 'count' }, a ? `${a.up}/${a.n}` : '')), h('td', {}, '')),
      ),
    );
    const best = avg.map((a, m) => ({ a, m })).filter((x) => x.a).sort((p, q) => q.a.mean - p.a.mean);
    const summary = best.length
      ? `En promedio, el mejor mes fue ${MONTHS_SHORT[best[0].m].toLowerCase()} (${pct1(best[0].a.mean)} %) y el peor ${MONTHS_SHORT[best.at(-1).m].toLowerCase()} (${pct1(best.at(-1).a.mean)} %).`
      : '';
    body.replaceChildren(
      h('div', { class: 'season-wrap' }, table),
      h(
        'p',
        { class: 'hint' },
        `Rendimiento de cada mes en %, del último cierre del mes anterior al último del mes. Azul: subió; rojo: bajó; más intenso, más grande (tope ±${nf(1).format(cap * 100)} %). El mes en curso va con borde y no entra al promedio. ${summary} Con 5 años, cada promedio sale de 4 o 5 datos: sirve para ver patrones, no para predecir.`,
      ),
    );
  }

  // Indicadores para la estrategia, calculados aquí (los mismos que el servidor: media simple y RSI de Wilder).
  function smaOf(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    values.forEach((v, i) => {
      sum += v;
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    });
    return out;
  }
  function rsiOf(values, n = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= n) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= n; i++) {
      const ch = values[i] - values[i - 1];
      if (ch >= 0) gain += ch;
      else loss -= ch;
    }
    let g = gain / n;
    let l = loss / n;
    const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
    out[n] = val();
    for (let i = n + 1; i < values.length; i++) {
      const ch = values[i] - values[i - 1];
      g = (g * (n - 1) + Math.max(ch, 0)) / n;
      l = (l * (n - 1) + Math.max(-ch, 0)) / n;
      out[i] = val();
    }
    return out;
  }

  /**
   * Prueba una regla simple sobre los cierres: dentro o fuera del mercado cada día, según la señal del cierre
   * ANTERIOR (sin mirar el futuro). Sin comisiones ni impuestos. Empieza el primer día con señal, igual que
   * comprar y mantener, para comparar desde el mismo punto.
   */
  function backtest(points, kind) {
    const closes = points.map(([, c]) => c);
    let want; // (i) → true dentro, false fuera, null sin señal todavía
    if (kind === 'rsi') {
      const r = rsiOf(closes, 14);
      let inside = false;
      want = (i) => {
        if (r[i] == null) return null;
        if (r[i] < 30) inside = true;
        else if (r[i] > 70) inside = false;
        return inside;
      };
    } else {
      const [fast, slow] = kind === 'ma20-50' ? [20, 50] : [50, 200];
      const f = smaOf(closes, fast);
      const s = smaOf(closes, slow);
      want = (i) => (s[i] == null ? null : f[i] > s[i]);
    }
    const start = closes.findIndex((_, i) => want(i) !== null);
    if (start < 0 || start >= closes.length - 2) return null;
    const dates = [];
    const strat = [];
    const hold = [];
    const trades = [];
    let eq = 100;
    let inside = false;
    let entry = null;
    let daysIn = 0;
    for (let i = start; i < closes.length; i++) {
      if (i > start) {
        const ret = closes[i] / closes[i - 1] - 1;
        if (inside) {
          eq *= 1 + ret;
          daysIn++;
        }
      }
      dates.push(points[i][0]);
      strat.push(Math.round(eq * 100) / 100);
      hold.push(Math.round((closes[i] / closes[start]) * 10000) / 100);
      // La señal de hoy decide la posición de mañana.
      const next = want(i);
      if (next && !inside) entry = { date: points[i][0], price: closes[i] };
      if (!next && inside && entry) trades.push({ ...entry, exit: points[i][0], ret: closes[i] / entry.price - 1 });
      inside = !!next;
    }
    if (inside && entry) trades.push({ ...entry, exit: null, ret: closes.at(-1) / entry.price - 1 });
    const drawdown = (xs) => {
      let peak = xs[0];
      let worst = 0;
      for (const x of xs) {
        peak = Math.max(peak, x);
        worst = Math.min(worst, x / peak - 1);
      }
      return worst;
    };
    const years = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / (365.25 * 86_400_000);
    const stats = (xs) => ({ total: xs.at(-1) / 100 - 1, cagr: years > 0 ? (xs.at(-1) / 100) ** (1 / years) - 1 : null, dd: drawdown(xs) });
    return { dates, strat, hold, trades, s: stats(strat), b: stats(hold), share: daysIn / Math.max(1, dates.length - 1), years };
  }

  function renderStrategy() {
    const box = $('d-strat');
    const body = $('d-strat-body');
    const sym = state.selected;
    if (!sym || !box.open) return;
    const full = fullHistory(sym);
    if (!full) return body.replaceChildren(h('p', { class: 'muted' }, 'Calculando con los 5 años guardados…'));
    if (full.error) return body.replaceChildren(h('p', { class: 'err' }, full.error));
    const kind = $('d-strat-kind').value;
    const r = backtest(full.points, kind);
    if (!r) return body.replaceChildren(h('p', { class: 'muted' }, 'No hay historia suficiente para esta estrategia.'));
    const chart = h('div', { class: 'chart' });
    const legend = h(
      'div',
      { class: 'legend' },
      h('span', { class: 'legend-item s1' }, h('span', { class: 'key' }), 'Estrategia'),
      h('span', { class: 'legend-item s4' }, h('span', { class: 'key' }), 'Comprar y mantener'),
    );
    const statsEl = h(
      'dl',
      { class: 'stats' },
      stat('Estrategia', pctFrac(r.s.total), `${r.s.cagr != null ? `${pctFrac(r.s.cagr)} al año · ` : ''}peor caída ${pctFrac(r.s.dd)}`),
      stat('Comprar y mantener', pctFrac(r.b.total), `${r.b.cagr != null ? `${pctFrac(r.b.cagr)} al año · ` : ''}peor caída ${pctFrac(r.b.dd)}`),
      stat('Operaciones', String(r.trades.length), `Dentro del mercado el ${nf(0).format(r.share * 100)} % del tiempo`),
    );
    const recent = r.trades.slice(-6).reverse();
    const trades = recent.length
      ? h(
          'table',
          { class: 'co-table' },
          h('thead', {}, h('tr', {}, ...['Entrada', 'Salida', 'Resultado'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            {},
            ...recent.map((t) =>
              h('tr', {}, h('td', {}, fDayYear.format(day(t.date))), h('td', {}, t.exit ? fDayYear.format(day(t.exit)) : 'sigue dentro'), h('td', { class: trend(t.ret) }, `${arrowOf(t.ret)} ${pctFrac(t.ret)}`)),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'La regla no dio ninguna entrada en estos años.');
    body.replaceChildren(
      legend,
      chart,
      statsEl,
      h('p', { class: 'co-h' }, 'Últimas operaciones'),
      trades,
      h(
        'p',
        { class: 'hint' },
        `Desde el ${fDayYear.format(day(r.dates[0]))} (el primer día con señal), con 100 al inicio. Cada día se está dentro o fuera según la señal del cierre anterior. Sin comisiones ni impuestos: es para aprender, no una recomendación.`,
      ),
    );
    drawChart(chart, {
      dates: r.dates,
      series: [
        { name: 'Estrategia', values: r.strat, cls: 's1' },
        { name: 'Comprar y mantener', values: r.hold, cls: 's4' },
      ],
      height: 200,
      axis: true,
      interactive: true,
      measure: 'all',
      fmt: (v) => nf(1).format(v),
      endLabel: (sr, v) => nf(0).format(v),
      aria: `${sym}: estrategia frente a comprar y mantener, base 100`,
    });
  }

  // ---------- comparar ----------
  const CMP_MAX = 4;
  const CMP_SLOTS = [0, 1, 2, 3];

  /** Lo guardado en este navegador, saneado: símbolos de la lista, colores sin repetir y un rango válido. */
  function cmpPrefs() {
    const saved = prefs.get('mercados.comparar', null);
    const range = RANGES.includes(saved?.range) ? saved.range : '1A';
    const picks = [];
    for (const p of Array.isArray(saved?.picks) ? saved.picks : []) {
      const ok = typeof p?.sym === 'string' && state.symbols.includes(p.sym) && CMP_SLOTS.includes(p.slot);
      if (ok && picks.length < CMP_MAX && !picks.some((x) => x.sym === p.sym || x.slot === p.slot)) picks.push({ sym: p.sym, slot: p.slot });
    }
    // La primera vez: los tres primeros de la lista.
    if (!saved) state.symbols.slice(0, 3).forEach((sym, slot) => picks.push({ sym, slot }));
    return { picks, range };
  }

  const cmpKey = () => `${state.cmp.picks.map((p) => p.sym).sort().join(',')}|${state.cmp.range}`;

  function toggleCmp(sym) {
    const picks = state.cmp.picks;
    const i = picks.findIndex((p) => p.sym === sym);
    if (i >= 0) {
      picks.splice(i, 1);
    } else if (picks.length < CMP_MAX) {
      // El color sigue al símbolo: toma el primer color libre y no cambia aunque se quiten otros.
      const used = new Set(picks.map((p) => p.slot));
      picks.push({ sym, slot: CMP_SLOTS.find((k) => !used.has(k)) });
    }
    prefs.set('mercados.comparar', state.cmp);
    loadCompare();
  }

  /** Pide la comparación una vez por selección y rango (sale de la caché del servidor: normalmente sin créditos). */
  async function loadCompare() {
    const key = cmpKey();
    if (state.cmp.picks.length >= 2 && !state.cmpData.has(key)) {
      state.cmpData.set(key, 'cargando');
      if (state.cmpError?.key === key) state.cmpError = null;
      renderCompare();
      const symbols = state.cmp.picks.map((p) => p.sym).join(',');
      try {
        state.cmpData.set(key, await api(`/api/compare?symbols=${encodeURIComponent(symbols)}&range=${state.cmp.range}`));
      } catch (e) {
        // El error no se guarda: el próximo cambio vuelve a intentar.
        state.cmpData.delete(key);
        state.cmpError = { key, message: e.message };
      }
      if (cmpKey() !== key) return; // la selección cambió mientras tanto
    }
    renderCompare();
  }

  const signed2 = (v) => `${v < 0 ? '−' : ''}${nf(2).format(Math.abs(v))}`;

  function corrWord(v) {
    const a = Math.abs(v);
    if (a < 0.2) return 'correlación casi nula';
    return `correlación ${a >= 0.7 ? 'fuerte' : a >= 0.4 ? 'moderada' : 'débil'} ${v > 0 ? 'positiva' : 'negativa'}`;
  }

  /** Tooltip de una celda (al pasar el puntero o con el foco del teclado). */
  function attachCellTip(el, content) {
    const tip = $('tooltip');
    const show = () => {
      tip.replaceChildren(...content());
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
    };
    const hide = () => {
      tip.hidden = true;
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
  }

  /** Celda de la matriz: el número siempre a la vista; el fondo, cian si es positiva y magenta si es negativa, más intenso cuanto más fuerte. */
  function corrCell(v, diag, a, b, days) {
    if (diag) return h('td', { class: 'diag' }, '1');
    if (v == null) return h('td', { class: 'diag' }, '—');
    const td = h('td', { tabindex: '0', 'aria-label': `${a} y ${b}: ${signed2(v)}, ${corrWord(v)}` }, signed2(v));
    td.style.background = `rgba(${v >= 0 ? '69,200,230' : '213,81,129'},${(Math.abs(v) * 0.5).toFixed(3)})`;
    attachCellTip(td, () => [h('strong', {}, signed2(v)), `${a} y ${b}: ${corrWord(v)}`, h('br'), `${days} rendimientos diarios`]);
    return td;
  }

  const symKey = (x) => h('span', { class: `sym ${x.cls}` }, h('span', { class: 'key' }), x.name);

  function renderCompare() {
    const { picks, range } = state.cmp;
    $('cmp-ranges').replaceChildren(
      ...rangeButtons(range, (r) => {
        state.cmp.range = r;
        prefs.set('mercados.comparar', state.cmp);
        loadCompare();
      }),
    );
    const full = picks.length >= CMP_MAX;
    $('cmp-chips').replaceChildren(
      ...state.symbols.map((sym) => {
        const p = picks.find((x) => x.sym === sym);
        const b = h(
          'button',
          {
            type: 'button',
            class: p ? `tog s${p.slot + 1}` : 'tog',
            'aria-pressed': String(!!p),
            disabled: !p && full,
            title: !p && full ? `Máximo ${CMP_MAX}: quita uno para agregar otro` : null,
          },
          p ? h('span', { class: 'key' }) : null,
          sym,
        );
        b.addEventListener('click', () => toggleCmp(sym));
        return b;
      }),
    );

    const sec = $('compare');
    const chart = $('cmp-chart');
    const grid = $('cmp-grid');
    const note = $('cmp-note');
    const csv = $('cmp-csv');
    const key = cmpKey();
    const data = state.cmpData.get(key);
    const ready = !!data && data !== 'cargando';
    csv.disabled = !ready;
    sec.classList.toggle('is-loading', data === 'cargando' && chart.childElementCount > 0);
    const toClaude = $('cmp-claude');
    toClaude.hidden = !ready;
    const message = (cls, text) => {
      charts.delete(chart);
      chart.replaceChildren(h('p', { class: cls }, text));
      grid.hidden = true;
      note.textContent = '';
      csv.disabled = true;
      toClaude.hidden = true;
    };
    if (picks.length < 2) return message('muted', `Elige de 2 a ${CMP_MAX} símbolos de tu lista para compararlos.`);
    if (state.cmpError?.key === key) return message('err', state.cmpError.message);
    if (!ready) {
      if (!chart.childElementCount) chart.replaceChildren(h('p', { class: 'muted' }, 'Cargando comparación…'));
      return;
    }
    const n = data.dates.length;
    if (n < 2) return message('muted', 'No hay suficientes días en común para comparar en este periodo.');
    toClaude.href = compareClaudeHref(data);

    const slotOf = new Map(picks.map((p) => [p.sym, p.slot]));
    const series = data.series
      .filter((sr) => slotOf.has(sr.symbol))
      .sort((a, b) => slotOf.get(a.symbol) - slotOf.get(b.symbol))
      .map((sr) => ({
        name: sr.symbol,
        values: sr.rebased,
        cls: `s${slotOf.get(sr.symbol) + 1}`,
        src: sr,
        tipLabel: (v) => `${sr.symbol} ${pctFrac(v / 100 - 1)}`,
      }));
    const idx = series.map((x) => data.series.indexOf(x.src));
    const short = data.range === '1M' || data.range === '3M';
    drawChart(chart, {
      dates: data.dates,
      series,
      refs: [100],
      flat: true,
      height: 260,
      axis: true,
      interactive: true,
      // Con ancho, cada línea lleva su nombre y rendimiento al final; en el celular quedan la leyenda y el tooltip.
      padR: (W) => (W >= 520 ? 124 : 16),
      endLabel: (sr, v, W) => (W >= 520 ? `${sr.name} ${pctFrac(v / 100 - 1)}` : null),
      fmt: (v) => nf(1).format(v),
      axisDateFmt: short ? fDay : fAxisMonth,
      sortTip: true,
      // Al medir: la variación de cada símbolo en el tramo (en base 100 es la misma que en precio).
      measure: 'all',
      measureRow: (sr, v0, v1) => ({ value: `${arrowOf(v1 - v0)} ${pctFrac(v1 / v0 - 1)}`, label: sr.name }),
      aria: `Evolución en base 100 de ${listJoin(series.map((x) => x.name))} en ${RANGE_NAMES[data.range]}`,
    });

    grid.hidden = false;
    $('cmp-stats').tBodies[0].replaceChildren(
      ...series.map((x) => {
        const st = x.src.stats;
        return h(
          'tr',
          {},
          h('th', { scope: 'row' }, symKey(x)),
          h('td', { class: st ? trend(st.totalReturn) : 'flat' }, st ? pctFrac(st.totalReturn) : '—'),
          h('td', {}, st?.annualVol != null ? pctFrac(st.annualVol).replace('+', '') : '—'),
          h('td', {}, st?.maxDrawdown != null ? pctFrac(st.maxDrawdown) : 'Sin caídas'),
        );
      }),
    );
    $('cmp-corr').replaceChildren(
      h('thead', {}, h('tr', {}, h('td', {}), ...series.map((x) => h('th', { scope: 'col' }, symKey(x))))),
      h(
        'tbody',
        {},
        ...series.map((a, r) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, symKey(a)),
            ...series.map((b, c) => corrCell(data.correlation[idx[r]][idx[c]], r === c, a.name, b.name, n - 1)),
          ),
        ),
      ),
    );
    const errs = Object.entries(data.errors || {}).map(([sym, msg]) => `${sym} (${msg})`);
    note.textContent =
      `${n} días en común, del ${fDayYear.format(day(data.dates[0]))} al ${fDayYear.format(day(data.dates[n - 1]))}. ` +
      `${data.stale ? 'Dato guardado' : 'Actualizado'} ${ago(data.fetchedAt)}.` +
      (errs.length ? ` No se pudo cargar ${listJoin(errs)}.` : '');
    csv.onclick = () => {
      const syms = series.map((x) => x.name);
      const header = ['fecha', ...syms.map((sym) => `${sym}_cierre`), ...syms.map((sym) => `${sym}_base100`)];
      const rows = data.dates.map((d, i) => [d, ...series.map((x) => x.src.closes[i]), ...series.map((x) => x.src.rebased[i])]);
      downloadCsv(`comparar_${syms.map((sym) => sym.replace('/', '-')).join('_')}_${data.range}_${today()}.csv`, header, rows);
    };
  }

  // ---------- noticias ----------
  const NEWS_GROUPS = [
    ['todas', 'Todas'],
    ['latam', 'Perú y LatAm'],
    ['eeuu', 'EE. UU.'],
    ['global', 'Global'],
  ];
  const NEWS_STEP = 6; // compactas: pocas a la vista y «Ver más» para el resto

  /** Un titular en una línea: enlace al medio (se abre aparte; el texto completo, al pasar el mouse) y medio con la hora. */
  function newsItem(n) {
    const meta = [n.source, n.publishedAt ? ago(n.publishedAt) : null].filter(Boolean).join(' · ');
    const title = /^https?:\/\//.test(n.url)
      ? h('a', { class: 'news-title', href: n.url, target: '_blank', rel: 'noopener noreferrer', title: n.title }, n.title)
      : h('span', { class: 'news-title', title: n.title }, n.title);
    return h('li', { class: 'news-item' }, title, h('span', { class: 'news-meta' }, meta));
  }

  function renderNews() {
    const r = state.news;
    const group = state.newsGroup;
    $('news-groups').replaceChildren(
      ...NEWS_GROUPS.map(([id, label]) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(group === id) }, label);
        b.addEventListener('click', () => {
          state.newsGroup = id;
          state.newsShown = NEWS_STEP;
          prefs.set('mercados.noticias', id);
          renderNews();
        });
        return b;
      }),
    );
    if (!r) return;
    const all = r.data.items.filter((n) => group === 'todas' || n.group === group);
    const shown = all.slice(0, state.newsShown);
    $('news-list').replaceChildren(...(shown.length ? shown.map(newsItem) : [h('li', { class: 'muted' }, 'No hay titulares en este grupo.')]));
    $('news-more').hidden = all.length <= state.newsShown;
    const errs = Object.keys(r.data.errors || {});
    $('news-note').textContent = `${r.stale ? 'Guardado' : 'Actualizado'} ${ago(r.fetchedAt)}.${errs.length ? ` Sin respuesta de ${listJoin(errs)}.` : ''}`;
  }

  async function loadNews() {
    try {
      state.news = await api('/api/news');
    } catch (e) {
      $('news-list').replaceChildren(h('li', { class: 'err' }, e.message));
    }
    renderNews();
  }

  // ---------- resumen del día ----------
  /** Lo escribe Claude cada mañana (tarea programada del dueño, con el conector) con titulares y datos públicos: lo ven todos. */
  async function loadSummary() {
    try {
      state.summary = await api('/api/resumen');
    } catch {
      state.summary = null; // sin resumen la sección queda oculta: no hace falta avisar
    }
    renderSummary();
  }

  /** Abre Claude con la pregunta ya escrita, con la cuenta de quien lo usa: a Rueda no le cuesta nada. */
  function claudeLink(s) {
    const q = `Rueda resumió así el mercado del ${fDayYear.format(day(s.date))}: «${s.title}». ${s.text} Explícame con más detalle estas noticias y su contexto.`;
    return `https://claude.ai/new?q=${encodeURIComponent(q)}`;
  }

  /** Fuentes de un día anterior: el nombre del medio con su enlace, separados por comas. */
  const sourceLinks = (sources) =>
    sources.flatMap((x, i) => [
      i ? ', ' : null,
      /^https?:\/\//.test(x.url) ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.title }, x.source) : x.source,
    ]);

  function olderSummary(s) {
    return h(
      'article',
      { class: 'sum-old' },
      h('h4', {}, h('span', { class: 'sum-old-date' }, fDay.format(day(s.date))), s.title),
      h('p', { class: 'sum-text' }, s.text),
      s.sources?.length ? h('p', { class: 'hint' }, 'Fuentes: ', ...sourceLinks(s.sources)) : null,
    );
  }

  function renderSummary() {
    const items = state.summary?.items ?? [];
    $('summary').hidden = !items.length;
    if (!items.length) return;
    const [s, ...older] = items;
    const at = fTime.format(new Date(s.publishedAt));
    const when = s.date === limaDate(new Date()) ? `Hoy · ${at}` : s.date === limaDate(new Date(Date.now() - 86_400_000)) ? `Ayer · ${at}` : fDayYear.format(day(s.date));
    $('sum-date').textContent = when;
    $('sum-title').textContent = s.title;
    $('sum-text').textContent = s.text;
    $('sum-sources-label').textContent = `Fuentes (${s.sources.length})`;
    $('sum-sources-list').replaceChildren(...s.sources.map((x) => newsItem({ title: x.title, url: x.url, source: x.source, publishedAt: null })));
    $('sum-deeper').href = claudeLink(s);
    $('sum-older').hidden = !older.length;
    $('sum-older-list').replaceChildren(...older.map(olderSummary));
  }

  /** Titulares de una acción: se piden una vez por sesión, al abrir su ficha. */
  function symbolNewsFor(sym) {
    const cached = state.symbolNews.get(sym);
    if (cached) return cached === 'cargando' ? undefined : cached;
    if (lookupGate(sym)) return undefined;
    state.symbolNews.set(sym, 'cargando');
    api(`/api/news/symbol?symbol=${encodeURIComponent(sym)}`)
      .then((r) => state.symbolNews.set(sym, { items: r.items }))
      .catch((e) => state.symbolNews.set(sym, { error: e.message }))
      .finally(() => {
        if (state.selected === sym) renderSymbolNews();
      });
    return undefined;
  }

  function renderSymbolNews() {
    const sym = state.selected;
    const wrap = $('d-news');
    // Una buscada sin precio no abre nada más (tampoco se pueden pedir sus titulares).
    wrap.hidden = !sym || !!lookupGate(sym)?.error;
    if (wrap.hidden) return;
    $('d-news-sym').textContent = sym;
    const list = $('d-news-list');
    const r = symbolNewsFor(sym);
    if (!r) list.replaceChildren(h('li', { class: 'muted' }, 'Buscando titulares…'));
    else if (r.error) list.replaceChildren(h('li', { class: 'err' }, r.error));
    else list.replaceChildren(...(r.items.length ? r.items.slice(0, 4).map(newsItem) : [h('li', { class: 'muted' }, 'No hay titulares recientes.')]));
  }

  // ---------- datos de la empresa (Finnhub, solo el dueño) ----------
  /** Se piden una vez por sesión, al abrir la ficha (el servidor los guarda 24 h). */
  function companyFor(sym) {
    const c = state.company.get(sym);
    if (c) return c === 'cargando' ? undefined : c;
    if (lookupGate(sym)) return undefined;
    state.company.set(sym, 'cargando');
    api(`/api/company?symbol=${encodeURIComponent(sym)}`)
      .then((r) => state.company.set(sym, r))
      .catch((e) => state.company.set(sym, { error: e.message }))
      .finally(() => {
        if (state.selected === sym) renderCompany();
      });
    return undefined;
  }

  const regionName = (() => {
    try {
      const dn = new Intl.DisplayNames([LOCALE], { type: 'region' });
      return (code) => (code ? dn.of(code) ?? code : null);
    } catch {
      return (code) => code;
    }
  })();
  const moneyPrefix = (cur) => (cur === 'USD' ? 'US$ ' : cur === 'PEN' ? 'S/ ' : cur ? `${cur} ` : '');
  /** Millones → «21.5 mil millones» o «850 millones». */
  const millions = (v) => (Math.abs(v) >= 1000 ? `${nf(1).format(v / 1000)} mil millones` : `${nf(0).format(v)} millones`);
  const signedRate = (v, dec = 1) => `${sign(v)}${nf(dec).format(Math.abs(v))}%`;
  /** «NEW YORK STOCK EXCHANGE, INC.» → «NYSE». */
  const exchangeName = (x) => (!x ? null : /new york/i.test(x) ? 'NYSE' : /nasdaq/i.test(x) ? 'Nasdaq' : x);

  function renderCompany() {
    const sym = state.selected;
    const wrap = $('d-co');
    // Finnhub es solo para el dueño (sus términos): un amigo con su clave de Twelve Data no ve este bloque.
    if (state.role !== 'owner') {
      wrap.hidden = true;
      return;
    }
    const r = sym ? companyFor(sym) : null;
    // Divisas y cripto no tienen datos de empresa; una buscada sin precio, tampoco.
    if (!sym || r?.applicable === false || lookupGate(sym)?.error) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const meta = $('d-co-meta');
    const statsEl = $('d-co-stats');
    const an = $('d-co-analysts');
    const su = $('d-co-surprises');
    const note = $('d-co-note');
    for (const el of [meta, statsEl, an, su, $('d-co-grades')]) el.replaceChildren();
    note.className = 'hint';
    if (!r) {
      note.textContent = 'Cargando datos de la empresa…';
      return;
    }
    if (r.error) {
      note.className = 'err';
      note.textContent = r.error;
      return;
    }
    if (!r.enabled) {
      note.textContent = 'Para ver el PER, la capitalización, los analistas y las sorpresas del BPA, carga la clave gratis de Finnhub (FINNHUB_API_KEY).';
      return;
    }
    const { profile: p, metrics: m, recommendations: recs, surprises, peers, errors } = r.data;
    if (!p && !m && !recs.length && !surprises.length) {
      note.textContent = `Finnhub no tiene datos de empresa para ${sym} (pasa con los ETF).`;
      return;
    }

    // Perfil en una línea: sector · país · bolsa · moneda · web.
    if (p) {
      const host = p.weburl ? p.weburl.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/.*$/, '') : null;
      meta.append(`· ${[p.industry, regionName(p.country), exchangeName(p.exchange), p.currency ? `reporta en ${p.currency}` : null].filter(Boolean).join(' · ')}`);
      if (host) meta.append(' · ', h('a', { href: p.weburl, target: '_blank', rel: 'noopener noreferrer' }, host));
    }

    const items = [];
    if (p?.marketCap != null) items.push(stat('Capitalización', `${moneyPrefix(p.currency)}${millions(p.marketCap)}`));
    if (m) {
      if (m.pe != null) items.push(stat('PER (12 meses)', m.pe > 0 ? nf(1).format(m.pe) : '—', m.pe > 0 ? null : 'Con pérdidas'));
      if (m.pb != null) items.push(stat('Precio / valor contable', nf(2).format(m.pb)));
      if (m.beta != null) {
        const vs = m.beta > 1.05 ? 'Se mueve más que el mercado' : m.beta < 0.95 ? 'Se mueve menos que el mercado' : 'Se mueve como el mercado';
        items.push(stat('Beta', nf(2).format(m.beta), vs));
      }
      if (m.dividendYield != null) items.push(stat('Dividendo (rendimiento)', rate(m.dividendYield)));
      if (m.netMargin != null) items.push(stat('Margen neto', rate(m.netMargin, 1)));
      if (m.roe != null) items.push(stat('ROE', rate(m.roe, 1)));
      if (m.revenueGrowth != null) items.push(stat('Crecimiento de ingresos', signedRate(m.revenueGrowth), 'Últimos 12 meses frente al año anterior'));
      if (m.eps != null) items.push(stat('BPA (12 meses)', nf(2).format(m.eps), 'En la moneda en que reporta'));
      if (m.high52 != null && m.low52 != null) items.push(stat('Rango de 52 semanas', `${fmtPrice(m.low52)} – ${fmtPrice(m.high52)}`));
    }
    statsEl.append(...items);
    renderFactors(sym);

    // Analistas: el mes más reciente y cómo estaba en el más viejo que dé Finnhub.
    const buyShare = (x) => {
      const total = x.strongBuy + x.buy + x.hold + x.sell + x.strongSell;
      return total ? { share: (x.strongBuy + x.buy) / total, total } : null;
    };
    const rec = recs[0];
    const latest = rec ? buyShare(rec) : null;
    if (latest) {
      const old = recs.length > 1 ? recs.at(-1) : null;
      const before = old ? buyShare(old) : null;
      an.append(
        h('p', { class: 'co-h' }, `Analistas · ${fMonthYear.format(day(rec.period))}`),
        h('p', {}, h('strong', {}, `${nf(0).format(latest.share * 100)}% recomienda comprar`), ` (${latest.total} analistas)`),
        h('p', { class: 'muted' }, `Compra fuerte ${rec.strongBuy} · Compra ${rec.buy} · Mantener ${rec.hold} · Venta ${rec.sell} · Venta fuerte ${rec.strongSell}`),
        before ? h('p', { class: 'muted' }, `En ${fMonthYear.format(day(old.period))}: ${nf(0).format(before.share * 100)}% recomendaba comprar`) : null,
      );
    }

    if (surprises.length) {
      su.append(
        h('p', { class: 'co-h' }, 'BPA: real frente a lo esperado'),
        h(
          'table',
          { class: 'co-table' },
          h('thead', {}, h('tr', {}, ...['Trimestre', 'Real', 'Esperado', 'Sorpresa'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            {},
            ...surprises.map((x) =>
              h(
                'tr',
                {},
                h('td', {}, x.quarter && x.year ? `${x.quarter}T ${x.year}` : fMonthYear.format(day(x.period))),
                h('td', {}, x.actual != null ? nf(2).format(x.actual) : '—'),
                h('td', {}, x.estimate != null ? nf(2).format(x.estimate) : '—'),
                h('td', { class: x.surprisePct == null ? 'flat' : trend(x.surprisePct) }, x.surprisePct == null ? '—' : `${arrowOf(x.surprisePct)} ${signedRate(x.surprisePct)}`),
              ),
            ),
          ),
        ),
      );
    }

    const notes = [];
    if (peers.length) notes.push(`Comparables según Finnhub: ${peers.join(', ')}.`);
    notes.push(`Fuente: Finnhub, ${r.stale ? 'guardado' : 'actualizado'} ${ago(r.fetchedAt)}.`);
    const errs = Object.keys(errors);
    if (errs.length) notes.push(`Sin respuesta para ${listJoin(errs)}.`);
    if (r.note) notes.push(r.note);
    note.textContent = notes.join(' ');
  }

  // ---------- notas por factores (A–F, frente a las comparables) ----------
  function factorsFor(sym) {
    const c = state.factors.get(sym);
    if (c) return c === 'cargando' ? undefined : c;
    if (lookupGate(sym)) return undefined;
    state.factors.set(sym, 'cargando');
    api(`/api/company/factors?symbol=${encodeURIComponent(sym)}`)
      .then((r) => state.factors.set(sym, r))
      .catch((e) => state.factors.set(sym, { error: e.message }))
      .finally(() => {
        if (state.selected === sym) renderFactors(sym);
      });
    return undefined;
  }

  const fmtMetric = (v, label) => (v == null ? '—' : /%/.test(label) ? `${sign(v)}${nf(1).format(Math.abs(v))}%` : nf(2).format(v));

  function renderFactors(sym) {
    const host = $('d-co-grades');
    const r = factorsFor(sym);
    if (!r) return host.replaceChildren(h('p', { class: 'muted' }, 'Calculando las notas frente a sus comparables…'));
    if (r.error) return host.replaceChildren(h('p', { class: 'err' }, r.error));
    if (!r.enabled || !r.applicable) return host.replaceChildren();
    const tiles = r.data.factors.map((f) =>
      h(
        'div',
        { class: 'fx-tile', title: f.score != null ? `Percentil promedio ${nf(0).format(f.score * 100)}` : 'Sin comparables suficientes con este dato' },
        h('span', { class: 'fx-grade' }, f.grade ?? '—'),
        h('span', { class: 'fx-label' }, f.label),
      ),
    );
    const rows = r.data.factors.flatMap((f) =>
      f.metrics.map((m, i) =>
        h(
          'tr',
          {},
          h('td', {}, i ? '' : f.label),
          h('td', {}, m.label),
          h('td', {}, fmtMetric(m.value, m.label)),
          h('td', {}, fmtMetric(m.median, m.label)),
          h('td', {}, m.percentile != null ? nf(0).format(m.percentile * 100) : '—'),
        ),
      ),
    );
    host.replaceChildren(
      h('p', { class: 'co-h' }, `Notas frente a ${r.data.peers.length} comparables (${r.data.peers.join(', ')})`),
      h('div', { class: 'fx-tiles' }, ...tiles),
      h(
        'details',
        { class: 'table-view' },
        h('summary', {}, 'Cómo sale cada nota'),
        h(
          'table',
          { class: 'co-table fx-table' },
          h('thead', {}, h('tr', {}, ...['Factor', 'Indicador', 'Empresa', 'Mediana comparables', 'Percentil'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, ...rows),
        ),
        h(
          'p',
          { class: 'hint' },
          'Cada indicador da un percentil dentro del grupo (100 = el mejor; en los múltiplos de valor, el más barato). La nota del factor es el promedio: A desde 80, B desde 60, C desde 40, D desde 20 y F por debajo. Con menos de 3 empresas con el dato no se califica. No es una recomendación.',
        ),
      ),
    );
  }

  // ---------- resultados anuales (SEC) ----------
  // Datos públicos (SEC EDGAR): la sección «Resultados de empresas», para todos y con cualquier acción, y un bloque
  // plegable en la ficha del dueño. El servidor los guarda una semana por símbolo.
  const FIN_SUGGEST = ['SCCO', 'BVN', 'BAP', 'IFS', 'AAPL', 'NVDA'];
  // Ingresos en s1 y utilidad neta en s4: pareja validada para daltonismo (las del precio y la MM50 en la ficha).
  const FIN_BARS = [
    { key: 'revenue', label: 'Ingresos', cls: 's1' },
    { key: 'netIncome', label: 'Utilidad neta', cls: 's4' },
  ];
  const FIN_COLS = [
    { key: 'revenue', label: 'Ingresos' },
    { key: 'operatingIncome', label: 'Utilidad operativa' },
    { key: 'netIncome', label: 'Utilidad neta' },
  ];
  const fMonthName = fmt({ month: 'long', timeZone: 'UTC' });
  /** Del cierre del año fiscal al informe anual: hasta 4 meses (20-F); pasados ~16, falta un año. */
  const FIN_OVERDUE_DAYS = 485;

  /** Resultados de un símbolo, una vez por sesión; al llegar se dibujan donde se estén mirando. */
  function financialsFor(sym) {
    const c = state.fin.get(sym);
    if (c) return c === 'cargando' ? undefined : c;
    state.fin.set(sym, 'cargando');
    api(`/api/financials?symbol=${encodeURIComponent(sym)}`)
      .then((r) => state.fin.set(sym, r))
      .catch((e) => state.fin.set(sym, { error: e.message }))
      .finally(() => {
        if (state.finSym === sym) renderFinSection();
        if (state.selected === sym) {
          renderDetailFin();
          renderDetailPs();
          renderDetailVal();
          renderQuick();
          $('d-claude').href = detailClaudeHref(sym);
        }
        if (psState.sym === sym || psState.peers.includes(sym)) renderPsSection();
      });
    return undefined;
  }

  /** Escala de los montos: miles de millones desde mil millones y, si no, millones (`name` va en el título; `unit`, tras cada monto). */
  function finScale(years) {
    const max = Math.max(0, ...years.flatMap((y) => FIN_COLS.map((c) => Math.abs(y[c.key] ?? 0))));
    return max >= 1e9 ? { div: 1e9, name: 'miles de millones', unit: 'mil millones', dec: 1 } : { div: 1e6, name: 'millones', unit: 'millones', dec: max >= 1e8 ? 0 : 1 };
  }

  /** Cambio frente al año anterior: en %, salvo que alguno de los dos años haya sido de pérdidas. */
  function yoyText(v, prev, prevYear) {
    if (v == null || prev == null) return null;
    if (prev > 0 && v >= 0) return `${arrowOf(v - prev)} ${pctFrac(v / prev - 1)} frente a ${prevYear}`;
    if (prev > 0) return `Pasó a pérdidas (ganó en ${prevYear})`;
    if (prev < 0 && v > 0) return `Volvió a ganar (perdió en ${prevYear})`;
    return null;
  }

  const netMargin = (y) => (y.revenue > 0 && y.netIncome != null ? y.netIncome / y.revenue : null);

  /** Bloque de resultados: los nodos y la función que dibuja el gráfico (cuando ya está en la página). */
  function financialsView(r, withName) {
    const d = r.data;
    if (!d.cik) return { nodes: [h('p', { class: 'muted' }, `La SEC no tiene informes anuales de ${d.symbol}: pasa con los ETF, los fondos y las empresas que no cotizan en EE. UU.`)] };
    if (!d.years.length) return { nodes: [h('p', { class: 'muted' }, `${d.name} reporta a la SEC, pero sus informes no traen ingresos ni utilidades en el formato que Rueda sabe leer.`)] };
    const ys = d.years;
    const last = ys.at(-1);
    const prev = ys.at(-2);
    const cur = moneyPrefix(d.currency);
    const curName = cur.trim() || d.currency;
    const money = (v) => `${v < 0 ? '−' : ''}${cur}${millions(Math.abs(v) / 1e6)}`;

    const items = [];
    if (last.revenue != null) items.push(stat(`Ingresos ${last.year}`, money(last.revenue), yoyText(last.revenue, prev?.revenue, prev?.year)));
    if (last.netIncome != null) items.push(stat(`Utilidad neta ${last.year}`, money(last.netIncome), yoyText(last.netIncome, prev?.netIncome, prev?.year)));
    const m = netMargin(last);
    if (m != null) items.push(stat(`Margen neto ${last.year}`, rate(m * 100, 1), last.operatingIncome != null ? `Margen operativo ${rate((last.operatingIncome / last.revenue) * 100, 1)}` : null));
    const withRev = ys.filter((y) => y.revenue > 0);
    const a = withRev[0];
    const b = withRev.at(-1);
    if (a && b && b.year - a.year >= 3) {
      items.push(stat('Crecimiento anual de ingresos', pctFrac((b.revenue / a.revenue) ** (1 / (b.year - a.year)) - 1), `Compuesto, ${a.year}–${b.year}`));
    }

    const sc = finScale(ys);
    const bars = FIN_BARS.filter((x) => ys.some((y) => y[x.key] != null));
    const chart = h('div', { class: 'chart' });
    const csv = h('button', { type: 'button', class: 'csv-btn', title: 'Descargar los resultados para Excel' }, '⤓ CSV');
    csv.addEventListener('click', () =>
      downloadCsv(
        `sec_resultados_${d.symbol}_${today()}.csv`,
        ['anio_fiscal', 'cierre', `ingresos_${d.currency}`, `utilidad_operativa_${d.currency}`, `utilidad_neta_${d.currency}`],
        ys.map((y) => [y.year, y.end, y.revenue, y.operatingIncome, y.netIncome]),
      ),
    );
    const cols = FIN_COLS.filter((c) => ys.some((y) => y[c.key] != null));
    const hasMargin = ys.some((y) => netMargin(y) != null);
    const amount = (v) => (v == null ? '—' : `${v < 0 ? '−' : ''}${nf(sc.dec).format(Math.abs(v) / sc.div)}`);
    const table = h(
      'details',
      { class: 'table-view' },
      h('summary', {}, 'Ver tabla'),
      h(
        'table',
        { class: 'fin-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Año'), ...cols.map((c) => h('th', { scope: 'col' }, c.label)), hasMargin ? h('th', { scope: 'col' }, 'Margen neto') : null)),
        h(
          'tbody',
          {},
          ...[...ys].reverse().map((y) => {
            const ym = netMargin(y);
            return h(
              'tr',
              {},
              h('th', { scope: 'row', title: `Cierre del año fiscal: ${fDayYear.format(day(y.end))}` }, String(y.year)),
              ...cols.map((c) => h('td', {}, amount(y[c.key]))),
              hasMargin ? h('td', {}, ym == null ? '—' : rate(ym * 100, 1)) : null,
            );
          }),
        ),
      ),
      h('p', { class: 'hint' }, `Montos en ${sc.name} de ${curName}.`),
    );
    // La SEC puede tardar en sumar un informe a sus datos (en 2026 pasa con los 20-F en NIIF): se avisa si ya debería estar.
    const overdue = Date.now() - Date.parse(`${last.end}T00:00:00Z`) > FIN_OVERDUE_DAYS * 86_400_000;
    const source = [
      `Fuente: SEC EDGAR, informes anuales de ${d.name} (${d.standard === 'ifrs-full' ? 'NIIF' : 'US GAAP'}, en ${d.currency}).`,
      `Su año fiscal cierra en ${fMonthName.format(day(last.end)).toLowerCase()}.`,
      overdue ? `Los datos de la SEC llegan hasta ${last.year}: el informe de ${last.year + 1} todavía no aparece.` : null,
      `${r.stale ? 'Guardado' : 'Actualizado'} ${ago(r.fetchedAt)}.`,
    ]
      .filter(Boolean)
      .join(' ');
    const nodes = [
      withName ? h('p', { class: 'co-h' }, `${d.name} · ${d.symbol} · `, hapiLink(d.symbol)) : null,
      h('dl', { class: 'stats fin-stats' }, ...items),
      h('div', { class: 'chart-head' }, h('p', { class: 'hint' }, `Por año fiscal, en ${sc.name} de ${curName}`), csv),
      h('div', { class: 'legend' }, ...bars.map((x) => h('span', { class: `legend-item ${x.cls}` }, h('span', { class: 'key fill' }), x.label))),
      chart,
      table,
      h('p', { class: 'hint' }, source),
      staleHint(r),
    ].filter(Boolean);
    const draw = () =>
      drawChart(chart, {
        dates: ys.map((y) => y.end),
        labels: ys.map((y) => String(y.year)),
        series: bars.map((x) => ({ name: x.label, cls: x.cls, kind: 'bars', values: ys.map((y) => (y[x.key] == null ? null : y[x.key] / sc.div)) })),
        inset: true,
        height: 180,
        axis: true,
        interactive: true,
        measure: 'none',
        padR: 8,
        refs: ys.some((y) => bars.some((x) => y[x.key] < 0)) ? [0] : [],
        fmt: (v) => `${v < 0 ? '−' : ''}${curName} ${nf(sc.dec).format(Math.abs(v))} ${sc.unit}`,
        endLabel: () => null,
        extraTip: (i) => {
          const ym = netMargin(ys[i]);
          return ym == null ? [] : [{ keyCls: 'none', value: rate(ym * 100, 1), label: 'Margen neto' }];
        },
        aria: `${bars.map((x) => x.label).join(' y ')} de ${d.name} por año fiscal, de ${ys[0].year} a ${last.year}, en ${sc.name} de ${curName}`,
      });
    return { nodes, draw };
  }

  function showFinancials(host, sym, withName) {
    const r = financialsFor(sym);
    if (!r) return host.replaceChildren(h('p', { class: 'muted' }, `Buscando los informes de ${sym} en la SEC…`));
    if (r.error) return host.replaceChildren(h('p', { class: 'err' }, r.error));
    const v = financialsView(r, withName);
    host.replaceChildren(...v.nodes);
    v.draw?.();
  }

  /** Bloque plegable de la ficha (solo acciones): se pide al abrirlo. */
  function renderDetailFin() {
    const box = $('d-fin');
    const sym = state.selected;
    box.hidden = !sym || sym.includes('/');
    if (!box.hidden && box.open) showFinancials($('d-fin-body'), sym, false);
  }

  function renderFinSection() {
    const sym = state.finSym;
    if (!sym) return;
    for (const b of $('fin-chips').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === sym));
    showFinancials($('fin-body'), sym, true);
  }

  function pickFin(raw) {
    const sym = String(raw ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(sym)) {
      $('fin-body').replaceChildren(h('p', { class: 'err' }, 'Escribe el símbolo de una acción, como SCCO o AAPL.'));
      return;
    }
    // Si la SEC no respondió la vez anterior, se vuelve a intentar.
    if (state.fin.get(sym)?.error) state.fin.delete(sym);
    state.finSym = sym;
    prefs.set('mercados.sec', sym);
    renderFinSection();
  }

  function setupFinSection() {
    $('fin-chips').replaceChildren(
      ...FIN_SUGGEST.map((sym) => {
        const b = h('button', { type: 'button', 'aria-pressed': 'false' }, sym);
        b.addEventListener('click', () => {
          $('fin-sym').value = sym;
          pickFin(sym);
        });
        return b;
      }),
    );
    $('fin-form').addEventListener('submit', (e) => {
      e.preventDefault();
      pickFin($('fin-sym').value);
    });
    const saved = prefs.get('mercados.sec', 'SCCO');
    $('fin-sym').value = saved;
    pickFin(saved);
  }

  // ---------- P/S (precio / ventas) ----------
  // Pedido del usuario el 4 nov («facilita con alguna herramienta el método P/S»): calculadora en la ficha, comparador
  // con pares (#ps, para todos) y la herramienta valorar_ps del conector. Ventas y acciones de la SEC (/api/financials),
  // dólar del BCRP; el precio, de tu lista o escrito a mano. Las mismas cuentas que src/services/valuation.ts: si
  // cambias una, cambia la otra.
  const psFmt = (v) => `${nf(2).format(v)}×`;
  const usdBig = (v) => `US$ ${millions(v / 1e6)}`;
  const usdPenNow = () => state.peruData?.fx?.at(-1)?.sell ?? null;
  const SYM_EQ = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

  /** Ventas del último año fiscal (también en dólares) y acciones de la portada más nueva; o por qué no se puede. */
  function psBase(fin) {
    if (!fin?.cik) return { error: 'No reporta a la SEC (pasa con los ETF, los fondos y las empresas que no cotizan en EE. UU.).' };
    const last = [...fin.years].reverse().find((y) => y.revenue > 0);
    if (!last) return { error: 'La SEC no tiene sus ventas: los bancos y las aseguradoras no informan «ventas», y el P/S no les sirve.' };
    const sh = fin.shares?.at(-1);
    if (!sh) return { error: 'La SEC no tiene sus acciones en circulación.' };
    const fx = usdPenNow();
    const k = fin.currency === 'USD' ? 1 : fin.currency === 'PEN' && fx ? 1 / fx : null;
    if (k == null) {
      return { error: fin.currency === 'PEN' ? 'Reporta en soles: falta el dólar del BCRP (llega con «Perú»).' : `Reporta en ${fin.currency}: por ahora Rueda solo pasa a dólares las ventas en soles.` };
    }
    return { year: last.year, end: last.end, revenue: last.revenue, revenueUsd: last.revenue * k, k, currency: fin.currency, shares: sh.value, sharesDate: sh.date, adr: fin.adrRatio ?? 1, foreign: !!fin.foreign };
  }
  const capOf = (b, price) => (price * b.shares) / b.adr;
  const psOf = (b, price) => capOf(b, price) / b.revenueUsd;
  const priceAtPsOf = (b, ps) => (ps * b.revenueUsd * b.adr) / b.shares;
  function medianOf(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** P/S al cierre de cada año fiscal: el precio de ese día y las acciones de la portada siguiente más cercana. */
  function psByYear(fin, b, points) {
    const out = [];
    for (const y of fin.years) {
      if (!(y.revenue > 0)) continue;
      let c = null;
      for (const p of points) {
        if (p[0] > y.end) break;
        c = p;
      }
      // Sin precio de ese día (antes de los 5 años guardados) o con un hueco de más de 10 días, no se cuenta.
      if (!c || Date.parse(y.end) - Date.parse(c[0]) > 10 * 86_400_000) continue;
      const sh = fin.shares.find((s) => s.date >= y.end) ?? fin.shares.at(-1);
      out.push({ year: y.year, end: y.end, price: c[1], ps: (c[1] * sh.value) / b.adr / (y.revenue * b.k) });
    }
    return out;
  }

  /** Precio de hoy, si está en tu lista o en tu lista diaria (sin gastar créditos). */
  function knownPrice(sym) {
    if (!hasPrices()) return null;
    const q = quoteFor(sym);
    if (q?.price != null) return { price: q.price, src: inLists(sym) ? 'de tu lista' : 'de hoy' };
    const e = eodRowFor(sym);
    return e?.close != null ? { price: e.close, src: `cierre del ${calDay(e.date)}` } : null;
  }

  /** «▲ +12.3 % frente a hoy» con su color. */
  const vsToday = (implied, price) => h('span', { class: trend(implied - price) }, `${arrowOf(implied - price)} ${pctFrac(implied / price - 1)} frente a hoy`);

  function psNotes(b) {
    return [
      `Ventas del año fiscal ${b.year} (SEC)${b.currency === 'PEN' ? ', pasadas a dólares con el dólar de hoy del BCRP' : ''}.`,
      `Acciones de la portada al ${fDayYear.format(day(b.sharesDate))}${b.adr !== 1 ? `; cada ADR vale ${b.adr}` : ''}.`,
      b.foreign && b.adr === 1 ? 'Es un emisor extranjero: si cotiza con ADR y cada uno vale varias acciones, el P/S sale mal.' : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  // Calculadora de la ficha: el P/S de hoy, el de cada cierre fiscal de los últimos 5 años y un P/S objetivo.
  const psTargets = new Map(); // símbolo → P/S objetivo escrito en esta sesión

  function renderDetailPs() {
    const box = $('d-ps');
    const sym = state.selected;
    box.hidden = !sym || sym.includes('/');
    if (box.hidden || !box.open) return;
    const host = $('d-ps-body');
    const fr = financialsFor(sym);
    if (!fr) return host.replaceChildren(h('p', { class: 'muted' }, `Buscando las ventas de ${sym} en la SEC…`));
    if (fr.error) return host.replaceChildren(h('p', { class: 'err' }, fr.error));
    const fin = fr.data;
    const b = psBase(fin);
    if (b.error) return host.replaceChildren(h('p', { class: 'muted' }, b.error));
    const kp = knownPrice(sym);
    if (!kp) return host.replaceChildren(h('p', { class: 'muted' }, 'Todavía no llega el precio de hoy.'));
    const full = fullHistory(sym);
    const years = full?.points ? psByYear(fin, b, full.points) : [];
    const med = medianOf(years.map((y) => y.ps));
    const now = psOf(b, kp.price);

    const target = h('input', { type: 'number', min: '0.1', max: '500', step: '0.1', inputmode: 'decimal', class: 'ps-target', id: 'd-ps-target' });
    target.value = psTargets.get(sym) ?? (med ?? now).toFixed(2);
    const out = h('p', { class: 'ps-out' });
    const update = () => {
      const v = Number(target.value);
      if (!(v > 0)) return out.replaceChildren('Escribe un P/S mayor que 0.');
      const implied = priceAtPsOf(b, v);
      out.replaceChildren('Con ese P/S, ', h('strong', {}, fmtPrice(implied)), ' por acción: ', vsToday(implied, kp.price), '.');
    };
    // Solo lo que escribes queda guardado: si no, el valor de partida (la mediana) sigue a los datos que llegan.
    target.addEventListener('input', () => {
      psTargets.set(sym, target.value);
      update();
    });
    update();

    const table =
      years.length > 0
        ? h(
            'details',
            { class: 'table-view' },
            h('summary', {}, 'P/S al cierre de cada año fiscal'),
            h(
              'table',
              { class: 'fin-table' },
              h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Año'), h('th', { scope: 'col' }, 'Precio al cierre'), h('th', { scope: 'col' }, 'P/S'))),
              h('tbody', {}, ...[...years].reverse().map((y) => h('tr', {}, h('th', { scope: 'row', title: `Cierre: ${fDayYear.format(day(y.end))}` }, String(y.year)), h('td', {}, fmtPrice(y.price)), h('td', {}, psFmt(y.ps))))),
            ),
          )
        : full === undefined
          ? h('p', { class: 'muted' }, 'Cargando los 5 años de precios para el P/S de cada año…')
          : null;
    const toPeers = h('button', { type: 'button', class: 'linkish' }, 'compararlo con otras empresas');
    toPeers.addEventListener('click', () => {
      $('ps-sym').value = sym;
      $('ps-peers').value = '';
      // En el celular la ficha tapa la hoja: se cierra y queda «Acciones», donde está el comparador.
      if (fichaFull()) {
        closeDetail();
        showSheet('acciones');
      }
      $('ps').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('ps-peers').focus();
    });
    host.replaceChildren(
      ...[
      h(
        'dl',
        { class: 'stats' },
        stat('P/S hoy', psFmt(now), `Precio ${fmtPrice(kp.price)} (${kp.src})`),
        stat('Capitalización', usdBig(capOf(b, kp.price)), `${compact.format(b.shares)} acciones${b.adr !== 1 ? `, ${b.adr} por ADR` : ''}`),
        stat(`Ventas ${b.year}`, usdBig(b.revenueUsd), b.currency === 'PEN' ? `S/ ${millions(b.revenue / 1e6)}` : 'Último año fiscal'),
        med != null ? stat(`P/S mediano (${years.length} cierres fiscales)`, psFmt(med), `De ${years[0].year} a ${years.at(-1).year}`) : null,
      ),
      h('div', { class: 'ps-calc' }, h('label', { for: 'd-ps-target' }, 'P/S objetivo'), target, out),
      table,
      h('p', { class: 'hint' }, psNotes(b), ' También puedes ', toPeers, '.'),
      ].filter(Boolean),
    );
  }

  // Comparador (#ps, para todos): la acción y hasta 3 comparables; sin clave, los precios se escriben a mano.
  const PS_EXAMPLES = [
    ['SCCO', ['FCX']],
    ['BVN', ['NEM']],
    ['AAPL', ['MSFT', 'GOOGL']],
  ];
  const psState = { sym: null, peers: [], prices: new Map(), target: '' };

  function pickPs(rawSym, rawPeers) {
    const up = (s) => String(s ?? '').trim().toUpperCase();
    const sym = up(rawSym);
    const peers = [...new Set(String(rawPeers ?? '').split(/[\s,;]+/).map(up).filter(Boolean))].filter((s) => s !== sym);
    const bad = [sym, ...peers].filter((s) => !SYM_EQ.test(s));
    if (bad.length || peers.length > 3) {
      $('ps-body').replaceChildren(h('p', { class: 'err' }, peers.length > 3 ? 'Hasta 3 comparables.' : 'Escribe símbolos de acciones, como SCCO o FCX.'));
      return;
    }
    // Si la SEC no respondió la vez anterior, se vuelve a intentar.
    for (const s of [sym, ...peers]) if (state.fin.get(s)?.error) state.fin.delete(s);
    Object.assign(psState, { sym, peers, target: '' });
    prefs.set('mercados.ps', { sym, peers });
    renderPsSection();
  }

  function renderPsSection() {
    const host = $('ps-body');
    if (!psState.sym) return;
    for (const b of $('ps-chips').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.sym === psState.sym && b.dataset.peers === psState.peers.join(',')));
    const all = [psState.sym, ...psState.peers];
    const loaded = all.map((s) => [s, financialsFor(s)]);
    if (loaded.some(([, r]) => !r)) return host.replaceChildren(h('p', { class: 'muted' }, `Buscando ${listJoin(all)} en la SEC…`));
    const rows = loaded.map(([s, r]) => {
      if (r.error) return { s, error: r.error };
      const b = psBase(r.data);
      if (b.error) return { s, name: r.data.name, error: b.error };
      const kp = knownPrice(s);
      const typed = psState.prices.get(s);
      const price = kp?.price ?? (typed > 0 ? typed : null);
      return { s, name: r.data.name, b, kp, price, ps: price ? psOf(b, price) : null };
    });

    const priceCell = (row) => {
      if (row.kp) return h('td', {}, fmtPrice(row.kp.price), h('small', {}, row.kp.src));
      const input = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', class: 'ps-price', 'aria-label': `Precio de ${row.s} en US$`, placeholder: 'US$' });
      if (psState.prices.has(row.s)) input.value = psState.prices.get(row.s);
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (v > 0) psState.prices.set(row.s, v);
        else psState.prices.delete(row.s);
        renderPsSection();
      });
      return h('td', {}, input);
    };
    const tr = (row, i) =>
      h(
        'tr',
        { class: i === 0 ? 'ps-main' : null },
        h('th', { scope: 'row' }, row.s, row.name ? h('small', {}, shortName(row.name, 26)) : null),
        ...(row.error
          ? [h('td', { colspan: 4, class: 'muted' }, row.error)]
          : [
              priceCell(row),
              h('td', {}, row.price ? usdBig(capOf(row.b, row.price)) : '—'),
              h('td', {}, usdBig(row.b.revenueUsd), h('small', {}, String(row.b.year))),
              h('td', { class: 'ps-val' }, row.ps != null ? psFmt(row.ps) : '—'),
            ]),
      );
    const table = h(
      'div',
      { class: 'ps-wrap' },
      h(
        'table',
        { class: 'fin-table ps-table' },
        h('thead', {}, h('tr', {}, ...['Empresa', 'Precio', 'Capitalización', 'Ventas', 'P/S'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, ...rows.map(tr)),
      ),
    );

    const main = rows[0];
    const peerPs = rows.slice(1).filter((r) => r.ps != null).map((r) => r.ps);
    const med = medianOf(peerPs);
    const parts = [table];
    if (!main.error) {
      const target = h('input', { type: 'number', min: '0.1', max: '500', step: '0.1', inputmode: 'decimal', class: 'ps-target', id: 'ps-target' });
      target.value = psState.target || (med != null ? med.toFixed(2) : '');
      target.placeholder = med != null ? '' : 'p. ej. 3';
      const out = h('p', { class: 'ps-out' });
      const update = () => {
        const v = Number(target.value);
        if (!(v > 0)) {
          out.replaceChildren(peerPs.length ? 'Escribe un P/S mayor que 0.' : 'Escribe el precio de los comparables, o un P/S objetivo.');
          return;
        }
        const implied = priceAtPsOf(main.b, v);
        out.replaceChildren(`${main.s} valdría `, h('strong', {}, fmtPrice(implied)), ' por acción', main.price ? ': ' : '', main.price ? vsToday(implied, main.price) : '', '.');
      };
      // Solo lo que escribes queda guardado: si no, sigue a la mediana de los comparables.
      target.addEventListener('input', () => {
        psState.target = target.value;
        update();
      });
      update();
      parts.push(
        h(
          'div',
          { class: 'ps-calc' },
          h('label', { for: 'ps-target' }, med != null ? `P/S de los comparables (mediana ${psFmt(med)})` : 'P/S objetivo'),
          target,
          out,
        ),
        h('p', { class: 'hint' }, psNotes(main.b)),
      );
    }
    if (!hasPrices()) parts.push(h('p', { class: 'hint' }, 'Con tu clave de Twelve Data, los precios de tu lista se ponen solos.'));
    host.replaceChildren(...parts);
  }

  function setupPsSection() {
    $('ps-chips').replaceChildren(
      ...PS_EXAMPLES.map(([sym, peers]) => {
        const b = h('button', { type: 'button', 'aria-pressed': 'false', 'data-sym': sym, 'data-peers': peers.join(',') }, `${sym} · ${peers.join(', ')}`);
        b.addEventListener('click', () => {
          $('ps-sym').value = sym;
          $('ps-peers').value = peers.join(', ');
          pickPs(sym, peers.join(','));
        });
        return b;
      }),
    );
    $('ps-form').addEventListener('submit', (e) => {
      e.preventDefault();
      pickPs($('ps-sym').value, $('ps-peers').value);
    });
    const saved = prefs.get('mercados.ps', null);
    const [sym, peers] = saved?.sym ? [saved.sym, saved.peers ?? []] : PS_EXAMPLES[0];
    $('ps-sym').value = sym;
    $('ps-peers').value = peers.join(', ');
    pickPs(sym, peers.join(','));
  }

  // ---------- resumen rápido, ratios y DCF, y «Analizar con Claude» (4 nov: «añade las estrellas») ----------
  // Para que analizar sea accesible y rápido: el resumen arriba de la ficha (describe, no predice), los ratios y un DCF
  // simple con supuestos que se cambian a mano (datos de la SEC y tu precio), y un enlace que abre Claude con la pregunta
  // y los números ya escritos, con la cuenta de quien lo usa (a Rueda no le cuesta nada; sirve en el celular).
  const fundCache = new Map(); // símbolo → /api/fundamentals | { error } | 'cargando'

  function fundamentalsFor(sym) {
    const c = fundCache.get(sym);
    if (c) return c === 'cargando' ? undefined : c;
    fundCache.set(sym, 'cargando');
    api(`/api/fundamentals?symbol=${encodeURIComponent(sym)}`)
      .then((r) => fundCache.set(sym, r))
      .catch((e) => fundCache.set(sym, { error: e.message }))
      .finally(() => {
        if (state.selected === sym) renderDetailVal();
      });
    return undefined;
  }

  /** Las cuatro miradas del resumen, con lo que ya trae la ficha (las de la SEC, solo para acciones). */
  function quickTiles(sym) {
    const tiles = [];
    const hist = state.hist.get(sym);
    const l = hist?.latest;
    if (l?.sma200) {
      const dist = l.close / l.sma200 - 1;
      const up = dist > 0 && l.sma50 != null && l.sma50 > l.sma200;
      const down = dist < 0 && l.sma50 != null && l.sma50 < l.sma200;
      const rsi = l.rsi14 == null ? '' : ` · RSI ${nf(0).format(l.rsi14)}${l.rsi14 > 70 ? ', sobrecompra' : l.rsi14 < 30 ? ', sobreventa' : ''}`;
      tiles.push({ k: 'Tendencia', v: up ? '▲ Alcista' : down ? '▼ Bajista' : 'Mixta', cls: up ? 'up' : down ? 'down' : null, s: `${pctFrac(dist)} frente a su media de 200 días${rsi}` });
    }
    const st = hist?.stats;
    if (st?.annualVol != null) {
      const v = st.annualVol;
      tiles.push({ k: 'Riesgo (1 año)', v: v < 0.2 ? 'Bajo' : v < 0.35 ? 'Medio' : 'Alto', s: `Volatilidad ${pctFrac(v).replace('+', '')} al año${st.maxDrawdown ? ` · mayor caída ${pctFrac(st.maxDrawdown.value)}` : ''}` });
    }
    if (sym.includes('/')) return tiles;
    const fr = financialsFor(sym);
    const fin = fr && !fr.error ? fr.data : null;
    if (!fin?.cik) return tiles;
    const b = psBase(fin);
    const kp = knownPrice(sym);
    if (b.error) tiles.push({ k: 'Valoración (P/S)', v: '—', s: /bancos/.test(b.error) ? 'Sin ventas: el P/S no le sirve' : 'Sin datos para el P/S' });
    else if (kp) {
      const full = fullHistory(sym);
      const years = full?.points ? psByYear(fin, b, full.points) : [];
      const med = medianOf(years.map((y) => y.ps));
      const now = psOf(b, kp.price);
      if (med) {
        const rel = now / med - 1;
        tiles.push({ k: 'Valoración (P/S)', v: rel > 0.15 ? 'Sobre su historia' : rel < -0.15 ? 'Bajo su historia' : 'En su promedio', s: `${psFmt(now)} frente a ${psFmt(med)} de mediana (${years.length} cierres fiscales)` });
      } else tiles.push({ k: 'Valoración (P/S)', v: psFmt(now), s: `Con las ventas de ${b.year}` });
    }
    const last = fin.years.at(-1);
    const prev = fin.years.at(-2);
    if (last?.revenue > 0 && prev?.revenue > 0) {
      const g = last.revenue / prev.revenue - 1;
      const m = last.netIncome != null ? ` · margen neto ${rate((last.netIncome / last.revenue) * 100, 1)}` : '';
      tiles.push({ k: `Fundamentales (${last.year})`, v: `${arrowOf(g)} Ventas ${pctFrac(g)}`, cls: trend(g), s: `Frente a ${prev.year}${m}` });
    } else if (last?.netIncome != null && prev?.netIncome > 0) {
      const g = last.netIncome / prev.netIncome - 1;
      tiles.push({ k: `Fundamentales (${last.year})`, v: `${arrowOf(g)} Utilidad ${pctFrac(g)}`, cls: trend(g), s: `Frente a ${prev.year}` });
    }
    return tiles;
  }

  function renderQuick() {
    const sym = state.selected;
    const box = $('d-quick');
    const tiles = sym ? quickTiles(sym) : [];
    box.hidden = !tiles.length;
    box.replaceChildren(...tiles.map((t) => h('div', { class: 'dq' }, h('span', { class: 'dq-k' }, t.k), h('span', { class: `dq-v ${t.cls ?? ''}` }, t.v), h('span', { class: 'dq-s' }, t.s))));
  }

  // Ratios y DCF de la ficha. Los montos de la SEC se pasan a dólares como en el P/S (en soles, con el dólar de hoy).
  const dcfSaved = new Map(); // símbolo → supuestos escritos en esta sesión
  const half = (v) => Math.round(v * 2) / 2;

  /**
   * Valor por acción (o por ADR) de un DCF simple: el flujo de caja libre del último año crece `g` % por 5 años y
   * después `gt` % para siempre, todo descontado a `r` %; al valor de la empresa se le resta la deuda neta (`nd`, en
   * millones de US$). null si la tasa no supera al crecimiento perpetuo por al menos medio punto.
   */
  function dcfValue(fcf, sharesAdr, { g, gt, r, nd }) {
    if (!(r > gt + 0.5)) return null;
    let f = fcf;
    let pv = 0;
    for (let t = 1; t <= 5; t++) {
      f *= 1 + g / 100;
      pv += f / (1 + r / 100) ** t;
    }
    const tv = (f * (1 + gt / 100)) / (r / 100 - gt / 100) / (1 + r / 100) ** 5;
    return { perShare: (pv + tv - nd * 1e6) / sharesAdr, pv, tv };
  }

  function renderDetailVal() {
    const box = $('d-val');
    const sym = state.selected;
    box.hidden = !sym || sym.includes('/');
    if (box.hidden || !box.open) return;
    const host = $('d-val-body');
    const say = (cls, text) => host.replaceChildren(h('p', { class: cls }, text));
    const fr = financialsFor(sym);
    const xr = fundamentalsFor(sym);
    if (!fr || !xr) return say('muted', `Buscando los informes de ${sym} en la SEC…`);
    if (fr.error || xr.error) return say('err', fr.error ?? xr.error);
    const fin = fr.data;
    if (!fin.cik || !fin.years.length) return say('muted', 'La SEC no tiene sus informes (pasa con los ETF y los fondos).');
    const kp = knownPrice(sym);
    if (!kp) return say('muted', 'Todavía no llega el precio de hoy.');
    const sh = fin.shares?.at(-1);
    if (!sh) return say('muted', 'La SEC no tiene sus acciones en circulación.');
    const fx = usdPenNow();
    const k = fin.currency === 'USD' ? 1 : fin.currency === 'PEN' && fx ? 1 / fx : null;
    if (k == null) return say('muted', `Reporta en ${fin.currency}: por ahora Rueda solo pasa a dólares los montos en soles.`);
    const last = fin.years.at(-1);
    const fy = xr.data.years.find((y) => y.end === last.end) ?? null;
    const adr = fin.adrRatio ?? 1;
    const sharesAdr = sh.value / adr;
    const cap = kp.price * sharesAdr;
    const usdOf = (v) => (v == null ? null : v * k);
    const [ni, rev, op] = [usdOf(last.netIncome), usdOf(last.revenue), usdOf(last.operatingIncome)];
    const [eq, assets, debt, cash, ocf, capex, da] = ['equity', 'assets', 'debt', 'cash', 'ocf', 'capex', 'da'].map((key) => usdOf(fy?.[key]));
    const ebitda = op != null && da != null ? op + da : null;
    const ev = debt != null && cash != null ? cap + debt - cash : null;
    const fcf = ocf != null && capex != null ? ocf - capex : null;
    const per = (a, b) => (a != null && b != null && b > 0 ? a / b : null);
    const xTimes = (v) => `${nf(1).format(v)}×`;
    const pctV = (v) => rate(v * 100, 1);

    // Ratios con valor; los que no se pueden calcular se explican en una línea.
    const rows = [
      ['P/E (precio / utilidad)', ni > 0 ? cap / ni : null, xTimes, `Utilidad ${last.year}: ${ni != null ? usdBig(ni) : '—'}`],
      ['P/B (precio / valor contable)', per(cap, eq), xTimes, eq != null ? `Patrimonio ${usdBig(eq)}` : null],
      ['EV / EBITDA', ev != null && ebitda > 0 ? ev / ebitda : null, xTimes, ev != null ? `Valor de la empresa ${usdBig(ev)}` : null],
      ['Rendimiento del flujo libre', fcf != null ? fcf / cap : null, pctV, fcf != null ? `Flujo de caja libre ${usdBig(fcf)}` : null],
      ['ROE (utilidad / patrimonio)', per(ni, eq), pctV, null],
      ['ROA (utilidad / activos)', per(ni, assets), pctV, null],
      ['Margen operativo', per(op, rev), pctV, null],
      ['Deuda / patrimonio', per(debt, eq), xTimes, debt != null ? `Deuda ${usdBig(debt)} · caja ${cash != null ? usdBig(cash) : '—'}` : null],
      ['Deuda neta / EBITDA', debt != null && cash != null && ebitda > 0 ? (debt - cash) / ebitda : null, xTimes, null],
    ];
    const shown = rows.filter(([, v]) => v != null);
    const missing = rows.filter(([, v]) => v == null).map(([label]) => label.split(' (')[0]);
    const ratios = h('dl', { class: 'stats' }, ...shown.map(([label, v, f, sub]) => stat(label, f(v), sub)));

    let dcf;
    if (fcf == null || fcf <= 0) {
      dcf = h('p', { class: 'muted' }, fcf == null ? 'Sin flujo de caja en los datos de la SEC: no hay DCF.' : `Con flujo de caja libre negativo en ${last.year}, un DCF simple no sirve.`);
    } else {
      const revs = fin.years.filter((y) => y.revenue > 0);
      const a = revs.at(-4) ?? revs[0];
      const z = revs.at(-1);
      const cagr = a && z && z.year > a.year ? (z.revenue / a.revenue) ** (1 / (z.year - a.year)) - 1 : 0.03;
      const rf = state.usaData?.treasury10y?.at(-1)?.value ?? null;
      const def = { g: Math.min(15, Math.max(0, half(cagr * 100))), gt: 2.5, r: half((rf ?? 4) + 5), nd: debt != null && cash != null ? Math.round((debt - cash) / 1e6) : 0 };
      const v = { ...def, ...dcfSaved.get(sym) };
      const out = h('div', { class: 'dcf-out' });
      const field = (key, label, step, title) => {
        const input = h('input', { type: 'number', step, inputmode: 'decimal', class: 'ps-target', 'aria-label': label, title });
        input.value = String(v[key]);
        input.addEventListener('input', () => {
          const n = Number(input.value);
          if (!Number.isFinite(n)) return;
          v[key] = n;
          dcfSaved.set(sym, { ...v });
          update();
        });
        return h('label', {}, label, input);
      };
      const update = () => {
        const base = dcfValue(fcf, sharesAdr, v);
        if (!base) return out.replaceChildren(h('p', { class: 'err' }, 'La tasa de descuento tiene que ser mayor que el crecimiento perpetuo (por al menos medio punto).'));
        const cell = (r, gt) => {
          const x = dcfValue(fcf, sharesAdr, { ...v, r, gt });
          return h('td', { class: r === v.r && gt === v.gt ? 'ps-val' : null }, x ? fmtPrice(x.perShare) : '—');
        };
        const gts = [v.gt - 0.5, v.gt, v.gt + 0.5];
        const table = h(
          'table',
          { class: 'fin-table dcf-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Tasa / perpetuo'), ...gts.map((g) => h('th', { scope: 'col' }, rate(g, 1))))),
          h('tbody', {}, ...[v.r - 1, v.r, v.r + 1].map((r) => h('tr', {}, h('th', { scope: 'row' }, rate(r, 1)), ...gts.map((g) => cell(r, g))))),
        );
        const tvShare = base.tv / (base.pv + base.tv);
        out.replaceChildren(
          h('p', { class: 'ps-out' }, 'Valor por acción: ', h('strong', {}, fmtPrice(base.perShare)), ' · ', vsToday(base.perShare, kp.price), '.'),
          h('p', { class: 'hint' }, `El valor terminal es el ${rate(tvShare * 100, 0)} del total: el resultado depende mucho de la tasa y del crecimiento perpetuo.`),
          h('div', { class: 'ps-wrap' }, table),
        );
      };
      update();
      dcf = h(
        'div',
        { class: 'dcf' },
        h('p', { class: 'hint' }, `Flujo de caja libre ${last.year}: ${usdBig(fcf)} (flujo operativo menos inversión en activo fijo).`),
        h(
          'div',
          { class: 'dcf-inputs' },
          field('g', 'Crecimiento años 1 a 5 (%)', '0.5', `Para partir: el de las ventas desde ${a?.year ?? '—'} (${rate(cagr * 100, 1)} al año), entre 0 y 15 %`),
          field('gt', 'Crecimiento perpetuo (%)', '0.5', 'Para partir: 2,5 %, cerca del crecimiento de largo plazo de la economía'),
          field('r', 'Tasa de descuento (%)', '0.5', `Para partir: el bono a 10 años de EE. UU. (${rf != null ? rate(rf, 2) : '≈4 %'}) más 5 puntos de prima por riesgo`),
          field('nd', 'Deuda neta (US$ millones)', '100', debt != null && cash != null ? 'Deuda menos caja del último balance (SEC)' : 'La SEC no tiene su deuda en el formato estándar: escríbela'),
        ),
        out,
        h('p', { class: 'hint' }, `Supuestos simples para empezar: cámbialos. Para empresas peruanas, súmale el riesgo país a la tasa.${debt == null || cash == null ? ' Ojo: la SEC no trae su deuda o su caja en el formato estándar.' : ''}`),
      );
    }

    // replaceChildren escribe «null» si le llega uno: lo que falta se deja fuera.
    host.replaceChildren(
      ...[
        h('p', { class: 'hint' }, `Con tu precio (${fmtPrice(kp.price)}, ${kp.src}) y los informes de la SEC del año fiscal ${last.year}${fin.currency === 'PEN' ? ', pasados a dólares con el dólar de hoy' : ''}.`),
        ratios,
        missing.length ? h('p', { class: 'hint' }, `Sin datos suficientes en la SEC para: ${listJoin(missing.map((m) => m.toLowerCase()))}.`) : null,
        h('h4', { class: 'dcf-h' }, 'DCF simple'),
        dcf,
      ].filter(Boolean),
    );
  }

  /** Enlace a Claude con el análisis de la ficha ya pedido y los números que Rueda tiene a mano. */
  function detailClaudeHref(sym) {
    const q = quoteFor(sym);
    const hist = state.hist.get(sym);
    const st = hist?.stats;
    const l = hist?.latest;
    const name = q?.name ?? eodRowFor(sym)?.name ?? sym;
    const lines = [`Analiza ${sym} (${name}) conmigo, en español y con números. Datos de mi panel Rueda al ${fDayYear.format(new Date())}:`];
    if (q?.price != null) lines.push(`- Precio ${fmtPrice(q.price)} ${q.currency ?? ''}${q.changePct != null ? `, ${pctFrac(q.changePct / 100, 2)} hoy` : ''}.`);
    if (st) lines.push(`- Último año: rendimiento ${pctFrac(st.totalReturn)}, volatilidad ${st.annualVol != null ? pctFrac(st.annualVol).replace('+', '') : '—'} anual${st.maxDrawdown ? `, mayor caída ${pctFrac(st.maxDrawdown.value)}` : ''}.`);
    if (l?.sma200) lines.push(`- Está ${pctFrac(l.close / l.sma200 - 1)} frente a su media de 200 días${l.rsi14 != null ? `; RSI 14 de ${nf(0).format(l.rsi14)}` : ''}.`);
    const fr = state.fin.get(sym);
    const fin = fr && fr !== 'cargando' && !fr.error ? fr.data : null;
    if (fin?.cik) {
      const b = psBase(fin);
      const kp = knownPrice(sym);
      if (!b.error && kp) lines.push(`- P/S de ${psFmt(psOf(b, kp.price))} con las ventas de ${b.year} (US$ ${millions(b.revenueUsd / 1e6)}).`);
      const [a, z] = [fin.years.at(-2), fin.years.at(-1)];
      if (z?.revenue > 0 && a?.revenue > 0) lines.push(`- Ventas ${z.year}: ${pctFrac(z.revenue / a.revenue - 1)} frente a ${a.year}${z.netIncome != null ? `; margen neto ${rate((z.netIncome / z.revenue) * 100, 1)}` : ''}.`);
    }
    lines.push(
      'Explícame: 1) qué dicen la tendencia y el riesgo; 2) si se ve cara o barata frente a su historia y a empresas parecidas; 3) qué viene (resultados, noticias, riesgos); 4) qué revisar antes de decidir. Si tienes el conector de Rueda, úsalo para completar (historial, empresa, resultados_anuales, valorar_ps, noticias). No me des una recomendación de compra o venta.',
    );
    return `https://claude.ai/new?q=${encodeURIComponent(lines.join('\n'))}`;
  }

  /** Enlace a Claude con la comparación ya pedida: rendimiento, riesgo y correlaciones del periodo. */
  function compareClaudeHref(data) {
    const syms = data.series.map((s) => s.symbol);
    const lines = [`Compara ${listJoin(syms)} conmigo, en español y con números. Datos de mi panel Rueda (${RANGE_NAMES[data.range]}, hasta el ${fDayYear.format(day(data.dates.at(-1)))}):`];
    for (const s of data.series) {
      if (!s.stats) continue;
      lines.push(`- ${s.symbol}: rendimiento ${pctFrac(s.stats.totalReturn)}, volatilidad ${s.stats.annualVol != null ? pctFrac(s.stats.annualVol).replace('+', '') : '—'} anual, mayor caída ${s.stats.maxDrawdown != null ? pctFrac(s.stats.maxDrawdown) : '—'}.`);
    }
    const pairs = [];
    for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) if (data.correlation[i]?.[j] != null) pairs.push(`${syms[i]} y ${syms[j]}: ${nf(2).format(data.correlation[i][j])}`);
    if (pairs.length) lines.push(`- Correlación de los rendimientos diarios: ${pairs.join('; ')}.`);
    lines.push('Explícame cuál rindió mejor por el riesgo que tuvo, si se diversifican entre sí y qué mueve a cada uno. Si tienes el conector de Rueda, usa comparar y empresa. No me des una recomendación de compra o venta.');
    return `https://claude.ai/new?q=${encodeURIComponent(lines.join('\n'))}`;
  }

  // ---------- cartera simulada ----------
  const usd = (v) => (v == null ? '—' : `US$ ${nf(2).format(v)}`);
  const signedUsd = (v) => `${sign(v)}US$ ${nf(2).format(Math.abs(v))}`;
  const pen = (v) => `S/ ${nf(2).format(v)}`;
  const qtyFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 6 });
  /** Acciones y ETF (sin «/») o cripto en dólares; USD/PEN no entra: la cartera es en US$. */
  const isUsdSymbol = (s) => !s.includes('/') || s.endsWith('/USD');

  function renderPortfolioForm() {
    const sel = $('pf-symbol');
    const syms = state.symbols.filter(isUsdSymbol);
    const current = sel.value;
    sel.replaceChildren(...syms.map((s) => h('option', { value: s }, s)));
    if (syms.includes(current)) sel.value = current;
    const date = $('pf-date');
    date.max = today();
    if (!date.value) date.value = today();
  }

  function pfError(msg) {
    const p = $('pf-err');
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  async function loadPortfolio(init, path = '/api/portfolio') {
    try {
      state.portfolio = await api(path, init);
      pfError(null);
      renderPortfolio();
      return true;
    } catch (e) {
      if (init) pfError(e.message);
      else $('pf-body').replaceChildren(h('p', { class: 'err' }, e.message));
      return false;
    }
  }

  async function submitTrade(e) {
    e.preventDefault();
    const body = { date: $('pf-date').value, symbol: $('pf-symbol').value, side: $('pf-side').value, qty: $('pf-qty').value, price: $('pf-price').value || null };
    const ok = await loadPortfolio({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (ok) {
      $('pf-qty').value = '';
      $('pf-price').value = '';
    }
  }

  function removeTrade(t) {
    if (!window.confirm(`¿Borrar la ${t.side === 'buy' ? 'compra' : 'venta'} de ${qtyFmt.format(t.qty)} ${t.symbol} del ${fDayYear.format(day(t.date))}?`)) return;
    loadPortfolio({ method: 'DELETE', headers: { 'Content-Type': 'application/json' } }, `/api/portfolio?id=${encodeURIComponent(t.id)}`);
  }

  // ---------- rayos X de la cartera ----------
  async function loadXray() {
    const body = $('pf-xray-body');
    if (!$('pf-xray').open) return;
    body.replaceChildren(h('p', { class: 'muted' }, 'Calculando…'));
    try {
      renderXray(await api('/api/portfolio/xray'));
    } catch (e) {
      body.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /** Barras horizontales de una sola serie (un solo color), ordenadas, con el % al final de cada una. */
  function weightBars(title, items, label = (x) => x.name) {
    return h(
      'div',
      { class: 'xr-group' },
      h('p', { class: 'co-h' }, title),
      ...items.map((x) => {
        const bar = h('span', { class: 'xr-bar' });
        bar.style.width = `${Math.max(1, x.weight * 100)}%`;
        return h('div', { class: 'xr-row' }, h('span', { class: 'xr-name' }, label(x)), h('span', { class: 'xr-track' }, bar), h('span', { class: 'xr-pct' }, `${nf(1).format(x.weight * 100)}%`));
      }),
    );
  }

  function renderXray(x) {
    const body = $('pf-xray-body');
    if (!x.total) return body.replaceChildren(h('p', { class: 'muted' }, 'No hay posiciones abiertas.'));
    const c = x.concentration;
    const country = (code) => (code === 'Varios' ? 'Varios (ETF y cripto)' : regionName(code));
    const parts = [
      h(
        'div',
        { class: 'xr-grid' },
        weightBars('Por posición', x.positions.map((p) => ({ name: p.symbol, weight: p.weight }))),
        weightBars('Por sector', x.bySector),
        weightBars('Por país', x.byCountry, (g) => country(g.name)),
      ),
      h(
        'dl',
        { class: 'stats' },
        c.largest ? stat('Mayor posición', `${nf(0).format(c.largest.weight * 100)}%`, c.largest.symbol) : null,
        stat('Las 3 mayores', `${nf(0).format(c.top3 * 100)}%`, 'del valor de la cartera'),
        stat('Posiciones efectivas', nf(1).format(c.effective), `Equivale a ${nf(1).format(c.effective)} posiciones del mismo tamaño`),
      ),
    ];
    const r = x.risk;
    if (r) {
      parts.push(
        h('p', { class: 'co-h' }, `Riesgo con los pesos de hoy (${fDayYear.format(day(r.from))} → ${fDayYear.format(day(r.to))})`),
        h(
          'dl',
          { class: 'stats' },
          stat('Volatilidad anual', r.volatility != null ? `${nf(1).format(r.volatility * 100)}%` : '—', 'Cuánto se mueve la cartera en un año típico'),
          stat('Beta frente al SPY', r.beta != null ? nf(2).format(r.beta) : '—', r.beta != null ? (r.beta > 1.05 ? 'Se mueve más que el mercado' : r.beta < 0.95 ? 'Se mueve menos que el mercado' : 'Se mueve como el mercado') : 'Sin historial del SPY'),
          stat('Peor caída', pctFrac(r.maxDrawdown), 'Del punto más alto al más bajo en el año'),
        ),
      );
      if (r.correlation.symbols.length > 1) {
        const syms = r.correlation.symbols;
        parts.push(
          h('p', { class: 'co-h' }, 'Correlación entre tus posiciones (rendimientos diarios)'),
          h(
            'div',
            { class: 'xr-corr' },
            h(
              'table',
              { class: 'corr' },
              h('thead', {}, h('tr', {}, h('td', {}), ...syms.map((s) => h('th', { scope: 'col' }, s)))),
              h('tbody', {}, ...syms.map((a, i) => h('tr', {}, h('th', { scope: 'row' }, a), ...syms.map((b, j) => corrCell(r.correlation.matrix[i][j], i === j, a, b, r.days))))),
            ),
          ),
        );
      }
    }
    parts.push(h('p', { class: 'hint' }, ['Sector y país según Finnhub. El riesgo usa los historiales ya guardados, sin gastar créditos.', ...x.notes].join(' ')));
    body.replaceChildren(...parts);
  }

  function renderPortfolio() {
    const p = state.portfolio;
    const host = $('pf-body');
    // Si los rayos X están abiertos, se recalculan con la cartera nueva.
    if ($('pf-xray').open) loadXray();
    $('pf-csv').disabled = !p?.trades?.length;
    if (!p) return;
    // Si la ficha está abierta, sus marcas de compras y ventas se actualizan.
    if (state.selected) renderDetail();
    if (!p.trades.length) {
      host.replaceChildren(h('p', { class: 'muted' }, 'Todavía no hay operaciones. Agrega una compra para empezar.'));
      return;
    }
    const t = p.totals;
    const row = h('div', { class: 'metric-row' });
    row.append(
      metric('Invertido', usd(t.invested), `${p.trades.length} ${p.trades.length === 1 ? 'operación' : 'operaciones'}`),
      metric('Valor hoy', usd(t.total), t.proceeds ? `Posiciones ${usd(t.value)} · cobrado ${usd(t.proceeds)}` : 'Con los últimos precios guardados'),
    );
    const gain = metric('Ganancia', pctFrac(t.ret), signedUsd(t.gain));
    gain.querySelector('.value').classList.add(trend(t.gain));
    row.append(gain);
    if (p.fx) row.append(metric('En soles', pen(t.total * p.fx.rate), `Ganancia ${sign(t.gain)}${pen(Math.abs(t.gain * p.fx.rate))} · S/ ${nf(4).format(p.fx.rate)} por US$`));
    if (p.benchmark) {
      const diff = t.ret - p.benchmark.ret;
      const vs = metric('Frente al S&P 500', `${sign(diff)}${nf(1).format(Math.abs(diff * 100))} pts`, `Con el SPY habrías ganado ${pctFrac(p.benchmark.ret)}`);
      vs.querySelector('.value').classList.add(trend(diff));
      row.append(vs);
    }

    const head = (...cols) => h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { scope: 'col' }, c))));
    const positions = h(
      'table',
      { class: 'cmp-stats' },
      head('Símbolo', 'Cantidad', 'Costo prom.', 'Precio', 'Valor', 'Ganancia'),
      h(
        'tbody',
        {},
        ...p.positions.map((x) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, x.symbol),
            h('td', {}, qtyFmt.format(x.qty)),
            h('td', {}, fmtPrice(x.avgCost)),
            h('td', {}, x.price == null ? '—' : fmtPrice(x.price)),
            h('td', {}, usd(x.value)),
            h('td', { class: x.gain == null ? 'flat' : trend(x.gain) }, x.gain == null ? '—' : `${signedUsd(x.gain)} (${pctFrac(x.ret)})`),
          ),
        ),
      ),
    );
    const trades = h(
      'table',
      { class: 'cmp-stats' },
      head('Fecha', 'Operación', 'Símbolo', 'Cantidad', 'Precio', 'Monto', ''),
      h(
        'tbody',
        {},
        ...[...p.trades].reverse().map((x) => {
          const del = h('button', { type: 'button', class: 'pf-del', 'aria-label': `Borrar la ${x.side === 'buy' ? 'compra' : 'venta'} de ${x.symbol} del ${x.date}` }, 'Borrar');
          del.addEventListener('click', () => removeTrade(x));
          return h(
            'tr',
            {},
            h('th', { scope: 'row' }, fDayYear.format(day(x.date))),
            h('td', {}, x.side === 'buy' ? 'Compra' : 'Venta'),
            h('td', {}, x.symbol),
            h('td', {}, qtyFmt.format(x.qty)),
            h('td', {}, fmtPrice(x.price)),
            h('td', {}, usd(x.qty * x.price)),
            h('td', {}, del),
          );
        }),
      ),
    );
    const notes = [...p.notes];
    if (p.pricesAt) notes.push(`Precios de ${stamp(p.pricesAt)}.`);
    if (t.realized) notes.push(`Ganancia realizada en ventas: ${signedUsd(t.realized)}.`);
    host.replaceChildren(
      row,
      h('div', { class: 'pf-tables' }, h('div', {}, h('p', { class: 'hint' }, 'Posiciones abiertas'), p.positions.length ? positions : h('p', { class: 'muted' }, 'No hay posiciones abiertas.')), h('div', {}, h('p', { class: 'hint' }, 'Operaciones'), trades)),
      ...(notes.length ? [h('p', { class: 'hint' }, notes.join(' '))] : []),
    );
    $('pf-csv').onclick = () =>
      downloadCsv(
        `cartera_${today()}.csv`,
        ['fecha', 'operacion', 'simbolo', 'cantidad', 'precio_usd', 'monto_usd'],
        p.trades.map((x) => [x.date, x.side === 'buy' ? 'compra' : 'venta', x.symbol, x.qty, x.price, round6(x.qty * x.price)]),
      );
  }

  // ---------- cuenta de Hapi (cifrada en este navegador: ni el servidor ni el dueño de la app pueden leerla) ----------
  // La lógica vive en módulos aparte (public/hapi-*.js), que se cargan al usar esta sección.
  /** Página pública de la acción en Hapi (no abre la app: Hapi no tiene enlaces que lleguen a ella). */
  const hapiUrl = (sym) => `https://hapi.trade/es/stock/${encodeURIComponent(sym)}`;
  const hapiLink = (sym, text = 'Ver en Hapi ↗') => h('a', { href: hapiUrl(sym), target: '_blank', rel: 'noopener noreferrer', class: 'hapi-link' }, text);
  const HAPI_KINDS = { buy: 'Compra', sell: 'Venta', dividend: 'Dividendo', deposit: 'Depósito', withdrawal: 'Retiro' };
  const hapiGroup = (kind) => (kind === 'buy' || kind === 'sell' ? 'trade' : kind === 'dividend' ? 'dividend' : 'transfer');
  const HAPI_AMOUNT_LABEL = { dividend: 'Dividendo bruto en US$', deposit: 'Llegó a Hapi (US$)', withdrawal: 'Salió de Hapi (US$)' };
  const HAPI_PEN_LABEL = { deposit: 'Soles que pagaste', withdrawal: 'Soles que recibiste' };
  const MIN_PASSPHRASE = 10;
  // hp: { core, crypto, statement } (módulos), store { blob, version, legacy }, key, kdf, account, market { prices, fx }.
  const hp = { mods: null, store: null, key: null, kdf: null, account: null, market: null, marketKey: null, proposal: null };

  async function hapiMods() {
    if (!hp.mods) {
      const [core, crypto, statement] = await Promise.all([import('/hapi-core.js'), import('/hapi-crypto.js'), import('/hapi-statement.js')]);
      hp.mods = { core, crypto, statement };
    }
    return hp.mods;
  }

  function hapiError(msg) {
    const p = $('hp-err');
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  /** Muestra solo los campos del tipo de movimiento elegido. */
  function renderHapiForm() {
    const kind = $('hp-kind').value;
    const group = hapiGroup(kind);
    for (const label of $('hp-form').querySelectorAll('label[data-for]')) label.hidden = !label.dataset.for.split(' ').includes(group);
    if (HAPI_AMOUNT_LABEL[kind]) $('hp-amount-label').textContent = HAPI_AMOUNT_LABEL[kind];
    if (HAPI_PEN_LABEL[kind]) $('hp-pen-label').textContent = HAPI_PEN_LABEL[kind];
    const date = $('hp-date');
    date.max = today();
    if (!date.value) date.value = today();
  }

  /** Carga lo guardado (cifrado) y, si este equipo recuerda la clave, abre la cuenta sin pedir la frase. */
  async function loadHapi() {
    try {
      const { crypto } = await hapiMods();
      hp.store = await api('/api/hapi');
      if (hp.store.blob && !hp.key) {
        const key = await crypto.recallKey(hp.store.blob.kdf.salt);
        if (key) {
          try {
            hp.account = await crypto.decryptAccount(hp.store.blob, key);
            hp.key = key;
            hp.kdf = hp.store.blob.kdf;
          } catch {
            /* la frase cambió en otro equipo: se pide de nuevo */
          }
        }
      } else if (hp.store.blob && hp.key) {
        hp.account = await crypto.decryptAccount(hp.store.blob, hp.key);
      }
      renderHapiLock();
    } catch (e) {
      $('hp-lock').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /** Crear la cuenta cifrada (o cifrar la de la primera versión), abrirla con la frase u olvidarla. */
  function renderHapiLock() {
    const lock = $('hp-lock');
    const open = !!hp.account && !!hp.key;
    $('hp-open').hidden = !open;
    $('hp-csv').disabled = !open || !hp.account.ops.length;
    if (open) {
      lock.replaceChildren();
      renderHapi();
      return;
    }
    const remember = h('label', { class: 'hp-check' }, h('input', { type: 'checkbox', id: 'hp-remember' }), ' Recordar en este equipo (no lo marques en una computadora compartida)');
    const status = h('p', { class: 'hint', role: 'status' });
    const pass = (id, label, autocomplete) =>
      h('label', {}, label, h('input', { type: 'password', id, minlength: MIN_PASSPHRASE, required: true, autocomplete, spellcheck: 'false' }));
    if (!hp.store?.blob) {
      const legacy = hp.store?.legacy;
      const form = h(
        'form',
        { class: 'hp-pass' },
        pass('hp-pass1', 'Frase (10 caracteres o más)', 'new-password'),
        pass('hp-pass2', 'Repite la frase', 'new-password'),
        remember,
        h('button', { type: 'submit' }, legacy ? 'Cifrar mi cuenta' : 'Crear mi cuenta cifrada'),
      );
      form.addEventListener('submit', (e) => createHapi(e, status));
      lock.replaceChildren(
        h(
          'p',
          { class: 'hp-intro' },
          legacy
            ? 'Tu cuenta Hapi todavía no está cifrada. Ponle una frase y se cifra en este navegador; lo que anotaste se conserva.'
            : 'Tu cuenta se cifra en este navegador con una frase que solo sabes tú: Rueda guarda solo texto ilegible y nadie más puede leerla, ni el dueño de la app.',
        ),
        h('p', { class: 'hint' }, 'Si olvidas la frase, nadie puede recuperar la cuenta. Usa varias palabras que recuerdes, que no sean la contraseña de Hapi ni la de tu correo.'),
        form,
        status,
      );
      return;
    }
    const form = h('form', { class: 'hp-pass' }, pass('hp-pass1', 'Tu frase', 'current-password'), remember, h('button', { type: 'submit' }, 'Abrir mi cuenta'));
    form.addEventListener('submit', (e) => unlockHapi(e, status));
    const wipe = h('button', { type: 'button', class: 'pf-del' }, 'Olvidé la frase: borrar la cuenta y empezar de nuevo');
    wipe.addEventListener('click', wipeHapi);
    lock.replaceChildren(h('p', { class: 'hp-intro' }, 'Tu cuenta está cifrada. Escribe tu frase para abrirla en este navegador.'), form, status, h('p', { class: 'hint' }, wipe));
  }

  async function createHapi(e, status) {
    e.preventDefault();
    const p1 = $('hp-pass1').value;
    if (p1.length < MIN_PASSPHRASE) return (status.textContent = `La frase debe tener ${MIN_PASSPHRASE} caracteres o más.`);
    if (p1 !== $('hp-pass2').value) return (status.textContent = 'Las dos frases no coinciden.');
    status.textContent = 'Cifrando…';
    try {
      const { core, crypto } = await hapiMods();
      const { key, kdf } = await crypto.newKey(p1);
      // La cuenta de la primera versión (sin cifrar) se conserva al cifrarla.
      const legacy = hp.store?.legacy;
      const account = legacy ? { ...core.emptyAccount(), plan: legacy.plan === 'prime' ? 'prime' : 'standard', ops: legacy.ops, snapshot: legacy.snapshot ?? null } : core.emptyAccount();
      hp.key = key;
      hp.kdf = kdf;
      if ($('hp-remember').checked) await crypto.rememberKey(kdf.salt, key);
      await saveHapi(account);
      renderHapiLock();
    } catch (err) {
      hp.key = null;
      status.textContent = err.message;
    }
  }

  async function unlockHapi(e, status) {
    e.preventDefault();
    status.textContent = 'Abriendo…';
    try {
      const { crypto } = await hapiMods();
      const key = await crypto.keyForBlob($('hp-pass1').value, hp.store.blob);
      hp.account = await crypto.decryptAccount(hp.store.blob, key);
      hp.key = key;
      hp.kdf = hp.store.blob.kdf;
      if ($('hp-remember').checked) await crypto.rememberKey(hp.kdf.salt, key);
      renderHapiLock();
    } catch (err) {
      status.textContent = err.message;
    }
  }

  async function lockHapi() {
    const { crypto } = await hapiMods();
    await crypto.forgetKeys();
    Object.assign(hp, { key: null, kdf: null, account: null, proposal: null });
    $('hp-import').hidden = true;
    renderHapiLock();
  }

  async function wipeHapi() {
    if (!window.confirm('¿Borrar tu cuenta Hapi de Rueda? Sin la frase no se puede recuperar: empezarás de cero.')) return;
    try {
      await api('/api/hapi', { method: 'DELETE' });
      const { crypto } = await hapiMods();
      await crypto.forgetKeys();
      Object.assign(hp, { key: null, kdf: null, account: null, proposal: null });
      await loadHapi();
    } catch (err) {
      window.alert(err.message);
    }
  }

  /** Cifra y guarda la cuenta. Si otro equipo la cambió antes, recarga y avisa. */
  async function saveHapi(account) {
    const { crypto } = await hapiMods();
    const blob = await crypto.encryptAccount(account, hp.key, hp.kdf);
    try {
      const r = await api('/api/hapi', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blob, base: hp.store?.version ?? null }) });
      hp.store = { blob, version: r.version, legacy: null };
      hp.account = account;
    } catch (err) {
      if (err.status === 409) await loadHapi();
      throw err;
    }
  }

  /** Cambia la cuenta con `fn` (de hapi-core), la guarda y vuelve a dibujar. */
  async function changeHapi(fn) {
    try {
      const { core } = await hapiMods();
      await saveHapi(fn(core, hp.account));
      hapiError(null);
      renderHapi();
      return true;
    } catch (err) {
      hapiError(err.message);
      return false;
    }
  }

  async function submitHapi(e) {
    e.preventDefault();
    const kind = $('hp-kind').value;
    const val = (id) => $(id).value.trim() || null;
    const body = { kind, date: $('hp-date').value, fee: val('hp-fee') };
    const group = hapiGroup(kind);
    if (group !== 'transfer') body.symbol = val('hp-symbol');
    if (group === 'trade') Object.assign(body, { qty: val('hp-qty'), price: val('hp-price') });
    if (group !== 'trade') body.amount = val('hp-amount');
    if (group === 'transfer') body.pen = val('hp-pen');
    if (group === 'dividend') body.tax = val('hp-tax');
    if (await changeHapi((core, a) => core.addOps(a, [body], today()))) for (const id of ['hp-qty', 'hp-price', 'hp-amount', 'hp-pen', 'hp-tax', 'hp-fee']) $(id).value = '';
  }

  function hapiDetail(o) {
    let text;
    if (o.kind === 'buy' || o.kind === 'sell') text = `${qtyFmt.format(o.qty)} ${o.symbol} a ${usd(o.price)}`;
    else if (o.kind === 'dividend') text = `${o.symbol}: ${usd(o.amount)} bruto, retenido ${usd(o.tax)}`;
    else text = o.pen != null ? `${pen(o.pen)} · ${usd(o.amount)}` : usd(o.amount);
    return o.note ? `${text} · ${o.note}` : text;
  }

  /** Efecto en el efectivo de la cuenta. */
  function hapiCash(o) {
    if (o.kind === 'buy') return -(o.qty * o.price + o.fee);
    if (o.kind === 'sell') return o.qty * o.price - o.fee;
    if (o.kind === 'dividend') return o.amount - o.tax;
    return o.kind === 'deposit' ? o.amount : -o.amount;
  }

  function removeHapiOp(o) {
    if (!window.confirm(`¿Borrar ${HAPI_KINDS[o.kind].toLowerCase()} del ${fDayYear.format(day(o.date))} (${hapiDetail(o)})?`)) return;
    changeHapi((core, a) => core.deleteOp(a, o.id));
  }

  /**
   * Precios para valorizar (solo el dueño: su navegador manda sus símbolos; el de los demás no manda nada) y el dólar
   * del BCRP. Se piden de nuevo solo si cambian los símbolos.
   */
  async function hapiMarket(symbols) {
    const owner = state.role === 'owner';
    const key = owner ? symbols.join(',') : '';
    if (hp.market && hp.marketKey === key) return hp.market;
    try {
      hp.market = await api(owner && symbols.length ? `/api/hapi/market?symbols=${encodeURIComponent(key)}` : '/api/hapi/market');
    } catch {
      hp.market = { prices: null, fx: null };
    }
    hp.marketKey = key;
    return hp.market;
  }

  async function renderHapi() {
    const { core } = await hapiMods();
    const a = hp.account;
    if (!a) return;
    $('hp-plan').value = a.plan;
    $('hp-csv').disabled = !a.ops.length;
    if (a.snapshot) {
      $('hp-snap-value').value = a.snapshot.value;
      $('hp-snap-date').value = a.snapshot.date;
    }
    $('hp-snap-clear').hidden = !a.snapshot;
    const host = $('hp-body');
    if (!a.ops.length) {
      host.replaceChildren(h('p', { class: 'muted' }, 'Todavía no anotaste nada. Importa tu último estado de cuenta de Hapi o empieza por tus depósitos y compras.'));
      return;
    }
    const symbols = [...core.holdings(a).keys()].sort();
    const market = await hapiMarket(symbols);
    const owner = state.role === 'owner';
    const v = core.accountView(a, { prices: owner ? new Map(Object.entries(market.prices ?? {})) : null, fx: market.fx });
    const t = v.totals;
    const open = v.positions.filter((x) => x.qty > 0);
    const pr = v.pricing;
    const row = h('div', { class: 'metric-row hp-metrics' });
    // Valor de la cuenta: con precios en vivo (solo el dueño) o con los del último estado de cuenta. Si alguna posición
    // quedó sin precio, mejor el valor que se anotó de Hapi; si tampoco hay, a costo y sin ganancia.
    let value = null;
    let valueLabel = null;
    let valueSub = null;
    if (t.account != null && open.length && !pr.cost) {
      value = t.account;
      valueLabel = !pr.statement ? 'Valor hoy' : pr.live ? 'Valor estimado' : `Valor (precios al ${fDay.format(day(pr.marksDate))})`;
      valueSub = `Posiciones ${usd(t.value)} · efectivo ${usd(t.cash)}`;
    } else if (v.snapshot) {
      value = v.snapshot.value;
      valueLabel = `Según Hapi (${fDay.format(day(v.snapshot.date))})`;
      valueSub = v.snapshot.source === 'estado de cuenta' ? 'Del estado de cuenta' : 'El valor que anotaste';
    } else if (t.account != null && open.length) {
      value = t.account;
      valueLabel = 'Valor a costo';
      valueSub = 'Sin precios: importa tu estado de cuenta';
    }
    const atCost = valueLabel === 'Valor a costo';
    if (t.cash != null) row.append(metric('Depositado neto', usd(t.netDeposits), t.netPen != null ? `${pen(t.netPen)} en soles` : 'Anota los soles para ver el rendimiento en soles'));
    if (value != null && valueLabel) {
      row.append(metric(valueLabel, usd(value), valueSub));
      if (!atCost && t.cash != null && t.netDeposits > 0) {
        const gain = value - t.netDeposits;
        const m = metric('Ganancia', pctFrac(gain / t.netDeposits), signedUsd(gain));
        m.querySelector('.value').classList.add(trend(gain));
        row.append(m);
        if (t.netPen != null && t.netPen > 0 && v.fx) {
          const gPen = value * v.fx.rate - t.netPen;
          const mp = metric('Ganancia en soles', pctFrac(gPen / t.netPen), `${sign(gPen)}${pen(Math.abs(gPen))} · dólar BCRP ${nf(3).format(v.fx.rate)}`);
          mp.querySelector('.value').classList.add(trend(gPen));
          row.append(mp);
        }
      }
    } else if (t.cash != null) {
      row.append(metric('Efectivo', usd(t.cash), 'Según lo anotado'));
    }
    if (t.realized) row.append(metric('Ganancia realizada', signedUsd(t.realized), 'En ventas, neta de costos'));
    if (t.dividends.gross) row.append(metric('Dividendos netos', usd(t.dividends.net), `Bruto ${usd(t.dividends.gross)} · retenido ${usd(t.dividends.tax)}`));
    row.append(metric('Costos de Hapi', usd(t.fees.total), `Órdenes ${usd(t.fees.orders)} · depósitos y retiros ${usd(t.fees.transfers)}`));

    const head = (...cols) => h('thead', {}, h('tr', {}, ...cols.filter(Boolean).map((c) => h('th', { scope: 'col' }, c))));
    // De dónde sale cada precio: en vivo, sin marca; del estado de cuenta, *; sin precio (a costo), †.
    const priceCell = (x) => {
      const mark = x.priceSource === 'statement' ? '*' : x.priceSource === 'cost' ? '†' : '';
      const title = x.priceSource === 'statement' ? `Precio de cierre del estado de cuenta (${fDayYear.format(day(pr.marksDate))})` : x.priceSource === 'cost' ? 'Sin precio: lo que pagaste' : null;
      return h('td', { title }, `${fmtPrice(x.price)}${mark}`);
    };
    const positions = h(
      'table',
      { class: 'cmp-stats' },
      head('Símbolo', 'Cantidad', 'Costo prom.', 'Costo', 'Precio', 'Valor', 'Ganancia'),
      h(
        'tbody',
        {},
        ...open.map((x) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, hapiLink(x.symbol, x.symbol)),
            h('td', {}, qtyFmt.format(x.qty)),
            h('td', {}, fmtPrice(x.avgCost)),
            h('td', {}, usd(x.cost)),
            priceCell(x),
            h('td', {}, usd(x.value)),
            h('td', { class: x.gain == null ? 'flat' : trend(x.gain) }, x.gain == null ? '—' : `${signedUsd(x.gain)} (${pctFrac(x.ret)})`),
          ),
        ),
      ),
    );
    const ops = h(
      'table',
      { class: 'cmp-stats' },
      head('Fecha', 'Movimiento', 'Detalle', 'Efectivo', 'Costo', ''),
      h(
        'tbody',
        {},
        ...v.ops.map((o) => {
          const del = h('button', { type: 'button', class: 'pf-del', 'aria-label': `Borrar ${HAPI_KINDS[o.kind].toLowerCase()} del ${o.date}` }, 'Borrar');
          del.addEventListener('click', () => removeHapiOp(o));
          return h(
            'tr',
            {},
            h('th', { scope: 'row' }, fDayYear.format(day(o.date))),
            h('td', {}, HAPI_KINDS[o.kind]),
            h('td', {}, hapiDetail(o)),
            h('td', {}, signedUsd(hapiCash(o))),
            h('td', {}, o.fee ? usd(o.fee) : '—'),
            h('td', {}, del),
          );
        }),
      ),
    );
    const notes = [...v.notes];
    if (pr.statement) notes.push(`* Precio de cierre de tu estado de cuenta del ${fDayYear.format(day(pr.marksDate))}.${v.priced ? '' : ' Importa el siguiente para actualizarlo.'}`);
    if (pr.cost) notes.push('† Sin precio (no estaba en tu último estado de cuenta): se valoriza a lo que pagaste.');
    if (!v.priced && !pr.marksDate && open.length) notes.push('Importa tu estado de cuenta de Hapi para valorizar tus posiciones con sus precios de cierre: Rueda no puede mostrarte precios en vivo, su licencia no lo permite.');
    host.replaceChildren(
      row,
      h(
        'div',
        { class: 'pf-tables' },
        h('div', {}, h('p', { class: 'hint' }, 'Lo que tienes (costo con las comisiones de compra)'), open.length ? positions : h('p', { class: 'muted' }, 'No tienes posiciones abiertas.')),
        h('div', {}, h('p', { class: 'hint' }, 'Movimientos'), ops),
      ),
      ...(notes.length ? [h('p', { class: 'hint' }, notes.join(' '))] : []),
    );
    $('hp-csv').onclick = () =>
      downloadCsv(
        `hapi_${today()}.csv`,
        ['fecha', 'tipo', 'simbolo', 'cantidad', 'precio_usd', 'monto_usd', 'soles', 'costo_usd', 'retencion_usd', 'nota'],
        [...v.ops].reverse().map((o) => [o.date, HAPI_KINDS[o.kind].toLowerCase(), o.symbol ?? '', o.qty ?? '', o.price ?? '', o.amount ?? '', o.pen ?? '', o.fee, o.tax ?? '', o.note ?? '']),
      );
  }

  // ---------- importar el estado de cuenta (PDF) en el navegador ----------
  async function importHapiFile() {
    const input = $('hp-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const box = $('hp-import');
    box.hidden = false;
    box.replaceChildren(h('p', { class: 'muted' }, 'Leyendo tu estado de cuenta en este navegador (el PDF no se sube)…'));
    try {
      const { statement } = await hapiMods();
      const st = await statement.readStatementFile(file);
      hp.proposal = statement.proposeImport(st, hp.account);
      renderHapiImport();
    } catch (err) {
      box.replaceChildren(h('p', { class: 'err' }, `No se pudo leer el PDF: ${err.message}`));
    }
  }

  function renderHapiImport() {
    const box = $('hp-import');
    const p = hp.proposal;
    if (!p) {
      box.hidden = true;
      return;
    }
    const period = `del ${fDay.format(day(p.period.from))} al ${fDayYear.format(day(p.period.to))}`;
    const rows = p.items.map((it) => {
      const check = h('input', { type: 'checkbox', checked: it.checked || null, 'aria-label': 'Agregar este movimiento' });
      check.addEventListener('change', () => (it.checked = check.checked));
      let sym = it.op.symbol ?? '';
      if (it.info === 'Falta el símbolo') {
        const input = h('input', { class: 'hp-sym-fix', maxlength: 12, placeholder: 'Símbolo', 'aria-label': `Símbolo de ${it.name}` });
        input.addEventListener('input', () => {
          it.op.symbol = input.value.trim().toUpperCase() || null;
          it.checked = !!it.op.symbol;
          check.checked = it.checked;
        });
        sym = input;
      }
      return h(
        'tr',
        {},
        h('td', {}, check),
        h('td', {}, fDayYear.format(day(it.op.date))),
        h('td', {}, HAPI_KINDS[it.op.kind]),
        h('td', {}, sym),
        h('td', {}, it.op.kind === 'buy' || it.op.kind === 'sell' ? `${qtyFmt.format(it.op.qty)} a ${usd(it.op.price)}` : it.op.kind === 'dividend' ? `${usd(it.op.amount)} (retenido ${usd(it.op.tax)})` : usd(it.op.amount)),
        h('td', { class: 'muted' }, it.info ?? it.op.note ?? it.name ?? ''),
      );
    });
    const add = h('button', { type: 'button' }, 'Guardar en mi cuenta');
    const cancel = h('button', { type: 'button', class: 'pf-del' }, 'Cancelar');
    cancel.addEventListener('click', () => {
      hp.proposal = null;
      renderHapiImport();
    });
    add.addEventListener('click', async () => {
      const { statement } = await hapiMods();
      let result;
      const ok = await changeHapi((core, a) => {
        result = statement.applyImport(a, p, today());
        return result.account;
      });
      if (ok) {
        hp.proposal = null;
        renderHapiDiffs(result.diffs);
      }
    });
    const parts = [
      h('p', { class: 'co-h' }, `Estado de cuenta ${period} · valor total ${usd(p.total)}`),
      h(
        'p',
        { class: 'hint' },
        p.mode === 'start'
          ? `Tu cuenta está vacía: empieza con el saldo al ${fDayYear.format(day(p.period.to))} (lo que valía la cuenta, como depósito inicial, y cada posición a su precio de cierre). Los movimientos del mes ya están en ese saldo.`
          : 'Marca lo que quieras agregar; lo que ya estaba anotado queda sin marcar. Al guardar, también se actualizan el valor total y los precios de cierre con que se valorizan tus posiciones.',
      ),
      h('div', { class: 'pf-tables' }, h('div', {}, h('table', { class: 'cmp-stats hp-import-table' }, h('tbody', {}, ...rows)))),
    ];
    if (p.unknown.length) {
      parts.push(
        h('p', { class: 'hint' }, `No reconocidos (anótalos a mano si hace falta): ${p.unknown.map((u) => `${u.type} del ${fDay.format(day(u.date))} (${usd(u.credit || u.debit || 0)})`).join('; ')}.`),
      );
    }
    parts.push(h('div', { class: 'hp-tools' }, add, cancel), h('p', { class: 'hint' }, 'Se leyó en tu navegador: el PDF no se subió y de él solo se guardan estos movimientos, cifrados.'));
    box.replaceChildren(...parts);
  }

  /** Después de importar: qué quedó distinto entre lo anotado y las posiciones del estado de cuenta. */
  function renderHapiDiffs(diffs) {
    const box = $('hp-import');
    if (!diffs) return;
    box.hidden = false;
    box.replaceChildren(
      diffs.length
        ? h('p', { class: 'hint' }, `Agregado. Diferencias con el estado de cuenta: ${diffs.map((d) => `${d.symbol} (en Rueda ${qtyFmt.format(d.rueda)}, en Hapi ${qtyFmt.format(d.statement)})`).join('; ')}.`)
        : h('p', { class: 'hint' }, 'Agregado: tus posiciones coinciden con las del estado de cuenta.'),
    );
  }

  /** Cambiar la frase: se vuelve a cifrar todo con una clave nueva. */
  async function changePassphrase(e) {
    e.preventDefault();
    const status = $('hp-pass-status');
    const p1 = $('hp-new1').value;
    if (p1.length < MIN_PASSPHRASE) return (status.textContent = `La frase debe tener ${MIN_PASSPHRASE} caracteres o más.`);
    if (p1 !== $('hp-new2').value) return (status.textContent = 'Las dos frases no coinciden.');
    status.textContent = 'Cifrando con la frase nueva…';
    const old = { key: hp.key, kdf: hp.kdf };
    try {
      const { crypto } = await hapiMods();
      const { key, kdf } = await crypto.newKey(p1);
      Object.assign(hp, { key, kdf });
      await saveHapi(hp.account);
      await crypto.forgetKeys();
      $('hp-new1').value = '';
      $('hp-new2').value = '';
      status.textContent = 'Listo: tu cuenta quedó cifrada con la frase nueva. En los otros equipos te la pedirá.';
    } catch (err) {
      Object.assign(hp, old);
      status.textContent = err.message;
    }
  }

  function setupHapi() {
    $('hp-kind').addEventListener('change', renderHapiForm);
    $('hp-form').addEventListener('submit', submitHapi);
    $('hp-plan').addEventListener('change', () => changeHapi((core, a) => core.setPlan(a, $('hp-plan').value)));
    $('hp-snap-form').addEventListener('submit', (e) => {
      e.preventDefault();
      changeHapi((core, a) => core.setSnapshot(a, { value: $('hp-snap-value').value, date: $('hp-snap-date').value }, today()));
    });
    $('hp-snap-clear').addEventListener('click', () => {
      $('hp-snap-value').value = '';
      changeHapi((core, a) => core.setSnapshot(a, null, today()));
    });
    $('hp-file').addEventListener('change', importHapiFile);
    // En iPhone y iPad el selector de archivos solo ve la app Archivos: el PDF de Hapi tiene que estar guardado ahí.
    $('hp-ios-hint').hidden = !isIos();
    $('hp-lock-btn').addEventListener('click', lockHapi);
    $('hp-pass-form').addEventListener('submit', changePassphrase);
    $('hp-snap-date').max = today();
    if (!$('hp-snap-date').value) $('hp-snap-date').value = today();
    renderHapiForm();
    loadHapi();
  }

  // ---------- Perú / EE. UU. ----------
  function metric(label, value, sub) {
    return h('div', { class: 'metric' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), sub ? h('span', { class: 'sub' }, sub) : null);
  }

  /**
   * Gráfico pequeño con su título (sin título si la sección ya dice el periodo) y, si se da `csv`, un botón para
   * descargar sus datos: solo la flecha, porque hay muchos; qué baja lo dice al pasar el mouse y al lector de pantalla.
   */
  function chartBlock(title, pts, opts, csv) {
    const host = h('div', { class: 'chart' });
    const head = h('div', { class: 'chart-head' }, title ? h('p', { class: 'hint' }, title) : null);
    if (csv) {
      const label = `Descargar ${title ? title.toLowerCase() : opts.aria ?? 'los datos'} en CSV (Excel)`;
      const b = h('button', { type: 'button', class: 'csv-btn', title: label, 'aria-label': label }, '⤓');
      b.addEventListener('click', () => downloadCsv(csv.filename, csv.header, csv.rows));
      head.append(b);
    }
    const wrap = h('div', {}, head, host);
    return { wrap, draw: () => drawLine(host, pts, { height: 140, axis: true, interactive: true, ...opts }) };
  }

  // ---------- exportar ----------
  const round6 = (x) => Math.round(x * 1e6) / 1e6;

  /**
   * Descarga un CSV para Excel: separado por comas, decimales con punto (configuración es-PE) y con
   * BOM UTF-8 para que Excel lea bien las tildes. Se arma en el navegador: no pasa por el servidor.
   */
  function downloadCsv(filename, header, rows) {
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const today = () => limaDate(new Date());

  function staleHint(r) {
    return r.stale && r.note && r.note !== 'Datos de prueba' ? h('p', { class: 'hint' }, `Dato guardado (${ago(r.fetchedAt)}): ${r.note}`) : null;
  }

  async function loadPeru() {
    const host = $('peru');
    try {
      const r = await api('/api/peru');
      state.peruData = r.data;
      renderCalendar();
      renderTape();
      refreshForecastContext();
      // Con el dólar, el P/S, los ratios y el DCF de las empresas que reportan en soles.
      if (psState.sym) renderPsSection();
      if (state.selected) {
        renderDetailPs();
        renderDetailVal();
        renderQuick();
      }
      const { fx, policyRate, inflation } = r.data;
      const lastFx = fx.at(-1);
      const lastInf = inflation.at(-1);
      const row = h('div', { class: 'metric-row' });
      if (lastFx) row.append(metric('Dólar interbancario (venta)', nf(4).format(lastFx.sell), `Compra ${nf(4).format(lastFx.buy)} · ${fDay.format(day(lastFx.date))}`));
      if (policyRate) row.append(metric('Tasa de referencia', rate(policyRate.value), fDay.format(day(policyRate.date))));
      if (lastInf) row.append(metric('Inflación 12 meses (Lima)', rate(lastInf.value), fMonthYear.format(day(lastInf.date))));
      const parts = [row];
      // Encuesta de expectativas del BCRP: lo que esperan analistas y empresas a 12 meses, frente al mes anterior.
      const survey = r.data.expectations ?? [];
      const exp = survey.at(-1);
      if (exp) {
        const prev = survey.at(-2);
        const before = (k, show) => (prev?.[k] != null ? `Mes anterior: ${show(prev[k])}` : null);
        const expRow = h('div', { class: 'metric-row' });
        if (exp.inflation != null) expRow.append(metric('Inflación esperada', rate(exp.inflation), before('inflation', (v) => rate(v))));
        if (exp.gdp != null) expRow.append(metric('PBI esperado', rate(exp.gdp), before('gdp', (v) => rate(v))));
        if (exp.fx != null) expRow.append(metric('Dólar esperado', nf(3).format(exp.fx), before('fx', (v) => nf(3).format(v))));
        parts.push(h('p', { class: 'hint' }, `Lo que esperan los analistas a 12 meses (encuesta del BCRP de ${fMonthYear.format(day(exp.date))}):`), expRow);
      }
      const live = quoteFor('USD/PEN');
      if (live && lastFx) {
        parts.push(h('p', { class: 'hint' }, `En vivo (Twelve Data): ${nf(4).format(live.price)} · ${pctFrac(live.price / lastFx.sell - 1, 2)} frente al BCRP del ${fDay.format(day(lastFx.date))}.`));
      }
      const fxChart = chartBlock(
        'Dólar interbancario (venta), últimos 30 días hábiles',
        fx.map((p) => ({ date: p.date, v: p.sell })),
        { fmt: (v) => nf(4).format(v), axisDateFmt: fDay, aria: 'Tipo de cambio interbancario de venta, últimos 30 días hábiles' },
        { filename: `bcrp_dolar_interbancario_${today()}.csv`, header: ['fecha', 'compra', 'venta'], rows: fx.map((p) => [p.date, p.buy, p.sell]) },
      );
      const infChart = chartBlock(
        'Inflación 12 meses en Lima, por mes',
        inflation.map((p) => ({ date: p.date, v: p.value })),
        { fmt: (v) => rate(v), dateFmt: fMonthYear, monthly: true, measureRow: measureRowPoints, aria: 'Inflación a 12 meses en Lima Metropolitana, mensual' },
        { filename: `bcrp_inflacion_lima_${today()}.csv`, header: ['mes', 'inflacion_12m_pct'], rows: inflation.map((p) => [p.date.slice(0, 7), round6(p.value)]) },
      );
      host.replaceChildren(...parts, fxChart.wrap, infChart.wrap, ...[staleHint(r)].filter(Boolean));
      fxChart.draw();
      infChart.draw();
    } catch (e) {
      host.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  async function loadUsa() {
    const host = $('usa');
    try {
      const r = await api('/api/usa');
      state.usaData = r.data;
      renderCalendar();
      renderTape();
      refreshForecastContext();
      const { treasury10y, fedFunds, cpiYoY } = r.data;
      const t10 = treasury10y.at(-1);
      const cpi = cpiYoY.at(-1);
      const row = h('div', { class: 'metric-row' });
      if (t10) row.append(metric('Bono del Tesoro a 10 años', rate(t10.value), fDay.format(day(t10.date))));
      if (fedFunds) row.append(metric('Tasa de la Fed (efectiva)', rate(fedFunds.value), fDay.format(day(fedFunds.date))));
      if (cpi) row.append(metric('Inflación anual (IPC)', rate(cpi.value, 1), fMonthYear.format(day(cpi.date))));
      const tChart = chartBlock(
        'Rendimiento del bono a 10 años, últimos 60 días hábiles',
        treasury10y.map((p) => ({ date: p.date, v: p.value })),
        { fmt: (v) => rate(v), axisDateFmt: fDay, measureRow: measureRowPoints, aria: 'Rendimiento del bono del Tesoro a 10 años, últimos 60 días hábiles' },
        { filename: `fred_bono_10_anios_${today()}.csv`, header: ['fecha', 'rendimiento_pct'], rows: treasury10y.map((p) => [p.date, p.value]) },
      );
      const cChart = chartBlock(
        'Inflación anual de EE. UU., por mes',
        cpiYoY.map((p) => ({ date: p.date, v: p.value })),
        { fmt: (v) => rate(v, 1), dateFmt: fMonthYear, monthly: true, measureRow: measureRowPoints, aria: 'Inflación anual de Estados Unidos, mensual' },
        { filename: `fred_inflacion_eeuu_${today()}.csv`, header: ['mes', 'inflacion_anual_pct'], rows: cpiYoY.map((p) => [p.date.slice(0, 7), round6(p.value)]) },
      );
      host.replaceChildren(row, tChart.wrap, cChart.wrap, ...[staleHint(r)].filter(Boolean));
      tChart.draw();
      cChart.draw();
    } catch (e) {
      host.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  // ---------- curva de rendimientos de EE. UU. ----------
  // Tres curvas que se cruzan: s1, s4 y s2, validadas para daltonismo en todas las parejas (las mismas de la ficha).
  const CURVE_CLS = ['s1', 's4', 's2'];

  async function loadCurve() {
    const host = $('curve');
    try {
      const r = await api('/api/curve');
      const { tenors, curves, spread10y2y } = r.data;
      if (!curves.length) {
        host.replaceChildren();
        return;
      }
      const series = curves.map((c, k) => ({ name: c.label, values: c.values, cls: CURVE_CLS[k], tipLabel: () => `${c.label} (${fDay.format(day(c.date))})` }));
      const chart = h('div', { class: 'chart' });
      const legend = h('div', { class: 'legend' }, ...curves.map((c, k) => h('span', { class: `legend-item ${CURVE_CLS[k]}` }, h('span', { class: 'key' }), `${c.label} · ${fDay.format(day(c.date))}`)));
      const csv = h('button', { type: 'button', class: 'csv-btn', title: 'Descargar la curva para Excel' }, '⤓ CSV');
      csv.addEventListener('click', () =>
        downloadCsv(`fred_curva_tesoro_${today()}.csv`, ['plazo', ...curves.map((c) => `${c.label} (${c.date})`)], tenors.map((t, i) => [t, ...curves.map((c) => c.values[i])])),
      );
      const last = spread10y2y.at(-1);
      const parts = [
        h('div', { class: 'chart-head' }, h('p', { class: 'hint' }, 'Curva del Tesoro: rendimiento por plazo'), csv),
        legend,
        chart,
      ];
      if (last) {
        const inverted = last[1] < 0;
        parts.push(
          h('p', { class: 'hint' }, `10 años menos 2 años: ${sign(last[1])}${nf(2).format(Math.abs(last[1]))} pp (${fDay.format(day(last[0]))}). `, inverted ? 'Negativa: la curva está invertida, algo que suele leerse como señal de recesión.' : 'Positiva: la curva no está invertida.'),
        );
      }
      const spread = chartBlock(
        '10 años menos 2 años, último año (pp)',
        spread10y2y.map(([date, v]) => ({ date, v })),
        { fmt: (v) => `${sign(v)}${nf(2).format(Math.abs(v))} pp`, refs: [0], measureRow: measureRowPoints, aria: 'Diferencia entre los bonos del Tesoro a 10 y a 2 años, último año' },
        { filename: `fred_10a_menos_2a_${today()}.csv`, header: ['fecha', 'diferencia_pp'], rows: spread10y2y },
      );
      host.replaceChildren(...parts, spread.wrap, ...[staleHint(r)].filter(Boolean));
      drawChart(chart, {
        dates: tenors,
        labels: tenors,
        series,
        height: 170,
        axis: true,
        interactive: true,
        measure: 'none',
        fmt: (v) => rate(v),
        endLabel: (sr, v) => (sr.cls === 's1' ? rate(v) : null),
        aria: `Curva de rendimientos del Tesoro de EE. UU. de 1 mes a 30 años: ${curves.map((c) => c.label.toLowerCase()).join(', ')}`,
      });
      spread.draw();
    } catch (e) {
      host.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  // ---------- materias primas y «Más del Perú» (BCRP, un solo pedido) ----------
  // Materias primas a la vista, donde antes estaba lo del Perú (pedido del usuario, 4 nov). Lo del Perú quedó plegado
  // en «Más del Perú» y se dibuja recién al abrirlo (con la sección cerrada los gráficos no tienen ancho).
  const COMMODITIES = [
    { key: 'copper', label: 'Cobre (Londres)', unit: 'US$ por libra', dec: 2, csv: 'cobre_usd_libra' },
    { key: 'gold', label: 'Oro (Londres)', unit: 'US$ por onza troy', dec: 2, csv: 'oro_usd_onza' },
    { key: 'silver', label: 'Plata', unit: 'US$ por onza troy', dec: 2, csv: 'plata_usd_onza' },
    { key: 'zinc', label: 'Zinc (Londres)', unit: 'US$ por libra', dec: 2, csv: 'zinc_usd_libra' },
    { key: 'oil', label: 'Petróleo WTI', unit: 'US$ por barril', dec: 2, csv: 'petroleo_wti_usd_barril' },
  ];
  const PERU_MARKETS = [
    { key: 'bvl', label: 'Índice general BVL', unit: 'puntos', dec: 2, csv: 'indice_general_bvl' },
    { key: 'reserves', label: 'Reservas internacionales netas', unit: 'millones de US$', dec: 0, csv: 'reservas_millones_usd' },
    // Tasas: su variación va en puntos porcentuales (pp); el riesgo país, en puntos básicos (pb).
    { key: 'bond10pen', label: 'Bono del Perú a 10 años (S/)', unit: '% anual', dec: 2, csv: 'bono_peru_10a_soles_pct', kind: 'pp' },
    { key: 'bond10usd', label: 'Bono del Perú a 10 años (US$)', unit: '% anual', dec: 2, csv: 'bono_peru_10a_dolares_pct', kind: 'pp' },
    { key: 'spread10', label: 'Riesgo país (aprox.)', unit: 'puntos básicos', dec: 0, csv: 'riesgo_pais_aprox_pb', kind: 'pb' },
  ];

  /** Cambio en la unidad que corresponde: % para precios e índices, pp para tasas, pb para el riesgo país. */
  function changeText(ch, kind) {
    if (kind === 'pp') return `${arrowOf(ch.diff)} ${sign(ch.diff)}${nf(2).format(Math.abs(ch.diff))} pp`;
    if (kind === 'pb') return `${arrowOf(ch.diff)} ${sign(ch.diff)}${nf(0).format(Math.abs(ch.diff))} pb`;
    return `${arrowOf(ch.pct)} ${pctFrac(ch.pct)}`;
  }

  /** «1 mes ▲ +3.4%» con el color de la dirección; nada si no hay historia suficiente. */
  function changeChip(label, ch, kind) {
    if (!ch) return null;
    const d = kind ? ch.diff : ch.pct;
    return h('span', { class: 'pm-chg' }, `${label} `, h('span', { class: trend(d) }, changeText(ch, kind)));
  }

  let peruMarketsReply = null;

  async function loadPeruMarkets() {
    try {
      const r = await api('/api/peru-markets');
      peruMarketsReply = r;
      state.peruMarkets = r.data;
      renderTape();
      renderMarketCards($('cmd-grid'), COMMODITIES, r);
      if ($('pm-fold').open) renderMarketCards($('peru-markets'), PERU_MARKETS, r);
    } catch (e) {
      for (const id of ['cmd-grid', 'peru-markets']) $(id).replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /**
   * «Más del Perú» se abre y se cierra a mano (y se recuerda en el equipo); sus gráficos se dibujan al abrirla y los
   * hechos de importancia se piden recién entonces.
   */
  function setupPeruFold() {
    const fold = $('pm-fold');
    fold.open = prefs.get('mercados.mas-peru', null) === 'abierto';
    fold.addEventListener('toggle', () => {
      prefs.set('mercados.mas-peru', fold.open ? 'abierto' : 'cerrado');
      if (fold.open && peruMarketsReply) renderMarketCards($('peru-markets'), PERU_MARKETS, peruMarketsReply);
      if (fold.open) loadSmv();
    });
    if (fold.open) loadSmv();
    $('smv-more').addEventListener('click', () => {
      smv.shown += 10;
      renderSmv();
    });
  }

  // ---------- cripto (CoinGecko, para todos) ----------
  // Su plan Demo deja mostrar los datos citando la fuente (el enlace va debajo de las tarjetas). Sin COINGECKO_API_KEY
  // la sección no aparece para los amigos; el dueño ve cómo prenderla.
  const CRYPTO = [
    { key: 'bitcoin', label: 'Bitcoin', unit: 'US$ · BTC', dec: 0, csv: 'bitcoin_usd' },
    { key: 'ethereum', label: 'Ether', unit: 'US$ · ETH', dec: 2, csv: 'ether_usd' },
    { key: 'solana', label: 'Solana', unit: 'US$ · SOL', dec: 2, csv: 'solana_usd' },
    { key: 'ripple', label: 'XRP', unit: 'US$ · XRP', dec: 4, csv: 'xrp_usd' },
  ];

  async function loadCrypto() {
    const sec = $('cg');
    try {
      const r = await api('/api/crypto');
      if (!r.enabled) {
        sec.hidden = state.role !== 'owner';
        $('cg-setup').hidden = false;
        $('cg-grid').replaceChildren();
        return;
      }
      sec.hidden = false;
      $('cg-setup').hidden = true;
      state.crypto = r.data;
      renderMarketCards($('cg-grid'), CRYPTO, { ...r, data: r.data.coins }, { empty: 'Sin datos de CoinGecko', csvPrefix: 'coingecko' });
      renderTape();
    } catch (e) {
      sec.hidden = false;
      $('cg-grid').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  // ---------- lo que espera el mercado (Polymarket, para todos) ----------
  // Tarjetas con el diseño de Rueda (src/services/polymarket.ts) y, al tocar «Ver en vivo», el widget oficial de
  // Polymarket debajo, sin botones de compra. El dueño fija eventos pegando su enlace.
  const pmk = { reply: null, tab: prefs.get('mercados.pmk', 'bolsa') };

  /** 0,045 → «4.5%»; 0,62 → «62%»; casi 0 o casi 1 → «<1%» o «>99%». */
  const probText = (p) => (p < 0.01 ? '<1%' : p > 0.99 ? '>99%' : `${nf(p < 0.1 ? 1 : 0).format(p * 100)}%`);

  function pmkLive(e, host, btn) {
    if (!host.hidden) {
      host.hidden = true;
      host.replaceChildren();
      btn.textContent = 'Ver en vivo';
      return;
    }
    const q = new URLSearchParams('market' in e.embed ? { market: e.embed.market } : { event: e.embed.event, rotate: 'true' });
    q.set('theme', 'dark');
    q.set('buttons', 'false');
    q.set('fit', 'true');
    const frame = h('iframe', {
      class: 'pmk-frame',
      title: `Polymarket: ${e.title}`,
      src: `https://embed.polymarket.com/market?${q}`,
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    });
    host.replaceChildren(frame);
    host.hidden = false;
    btn.textContent = 'Cerrar el gráfico';
  }

  function pmkCard(e, pinned) {
    const rows = e.outcomes.map((o) => {
      const fill = h('i');
      fill.style.width = `${Math.max(1, Math.min(100, o.p * 100))}%`;
      const moved = o.d1 != null && Math.abs(o.d1) >= 0.005;
      return h(
        'div',
        { class: 'pmk-row' },
        h('span', { class: 'pmk-label', title: o.label }, o.label),
        h('span', { class: 'pmk-bar', 'aria-hidden': 'true' }, fill),
        h('span', { class: 'pmk-p' }, probText(o.p)),
        h('span', { class: `pmk-d ${moved ? trend(o.d1) : ''}`, title: moved ? 'Cambio en 24 horas, en puntos' : null }, moved ? `${arrowOf(o.d1)} ${sign(o.d1)}${nf(0).format(Math.abs(o.d1 * 100))} pp` : ''),
      );
    });
    const meta = [
      e.kind === 'varias' && e.total > e.outcomes.length ? `${e.total - e.outcomes.length} opciones más` : null,
      e.kind === 'escalera' ? `${e.total} preguntas: las más parejas` : null,
      `US$ ${compact.format(e.volume1wk)} en la semana`,
      e.end ? `se resuelve el ${calDay(e.end.slice(0, 10))}` : null,
    ].filter(Boolean);
    const live = h('button', { type: 'button', class: 'linkish' }, 'Ver en vivo');
    const host = h('div', { class: 'pmk-live', hidden: true });
    live.addEventListener('click', () => pmkLive(e, host, live));
    const actions = [live];
    if (pinned && state.role === 'owner') {
      const off = h('button', { type: 'button', class: 'linkish' }, 'quitar');
      off.addEventListener('click', () => pmkSend('DELETE', { slug: e.slug }));
      actions.push(' · ', off);
    }
    return h(
      'article',
      { class: 'pmk-card' },
      h('a', { class: 'pmk-title', href: `https://polymarket.com/event/${encodeURIComponent(e.slug)}`, target: '_blank', rel: 'noopener noreferrer' }, e.title),
      ...rows,
      h('p', { class: 'hint pmk-meta' }, meta.join(' · ')),
      h('p', { class: 'pmk-actions' }, ...actions),
      host,
    );
  }

  function renderPmk() {
    const r = pmk.reply;
    if (!r) return;
    const d = r.data;
    const owner = state.role === 'owner';
    const tabs = [...(d.pinned.length || owner ? [{ id: 'fijados', label: d.pinned.length ? `Fijados (${d.pinned.length})` : 'Fijados' }] : []), ...d.topics.map((t) => ({ id: t.id, label: t.label }))];
    if (!tabs.some((t) => t.id === pmk.tab)) pmk.tab = d.topics[0]?.id ?? tabs[0]?.id;
    $('pmk-tabs').replaceChildren(
      ...tabs.map((t) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(t.id === pmk.tab) }, t.label);
        b.addEventListener('click', () => {
          pmk.tab = t.id;
          prefs.set('mercados.pmk', t.id);
          renderPmk();
        });
        return b;
      }),
    );
    const pinnedTab = pmk.tab === 'fijados';
    $('pmk-pin').hidden = !(owner && pinnedTab);
    const events = pinnedTab ? d.pinned : (d.topics.find((t) => t.id === pmk.tab)?.events ?? []);
    $('pmk-body').replaceChildren(
      ...(events.length
        ? events.map((e) => pmkCard(e, pinnedTab))
        : [h('p', { class: 'muted' }, pinnedTab ? 'Pega arriba el enlace de un evento de Polymarket para fijarlo aquí (lo ven todos).' : 'No hay eventos abiertos en este tema ahora.')]),
    );
    $('pmk-note').textContent = `Probabilidades de Polymarket: lo que pagan sus apostadores por «sí». ${r.stale ? 'Guardadas' : 'Actualizadas'} ${ago(r.fetchedAt)}.`;
  }

  async function loadPmk() {
    try {
      pmk.reply = await api('/api/polymarket');
      renderPmk();
    } catch (e) {
      $('pmk-body').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  async function pmkSend(method, body) {
    const err = $('pmk-err');
    err.hidden = true;
    try {
      pmk.reply = await api('/api/polymarket/pins', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      pmk.tab = 'fijados';
      renderPmk();
      return true;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return false;
    }
  }

  function setupPmk() {
    $('pmk-pin').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (await pmkSend('POST', { url: $('pmk-url').value })) $('pmk-url').value = '';
    });
    loadPmk();
  }

  // ---------- hechos de importancia (SMV, para todos) ----------
  // La lista general va plegada en «Más del Perú»; en la ficha, los de las empresas peruanas que cotizan en EE. UU.
  /** Las de SMV_ISSUERS (src/services/smv.ts): solo para ellas se piden hechos en la ficha. */
  const SMV_SYMBOLS = new Set(['BAP', 'BVN', 'SCCO', 'CPAC', 'IFS']);
  const smv = { feed: null, shown: 6, by: new Map() };

  /** «2026-11-04T17:02» (ya en hora de Lima) → «4 nov, 17:02». */
  const smvWhen = (at) => `${fDay.format(day(at.slice(0, 10))).replace('.', '')}, ${at.slice(11, 16)}`;

  function smvItem(x, withName = true) {
    let name = null;
    if (withName) {
      // Si es una empresa de tu lista, su nombre abre la ficha.
      const opens = x.symbol && hasPrices() && state.symbols.includes(x.symbol);
      name = opens ? h('button', { type: 'button', class: 'linkish smv-co', title: `Abrir la ficha de ${x.symbol}` }, x.nombre) : h('span', { class: 'smv-co' }, x.nombre);
      if (opens) {
        name.addEventListener('click', () => openDetail(x.symbol));
      }
    }
    return h(
      'li',
      { class: 'smv-item' },
      h('p', { class: 'smv-top' }, name, h('span', { class: 'smv-tipo' }, x.tipo)),
      x.texto ? h('p', { class: 'smv-text' }, x.texto) : null,
      h('small', { class: 'smv-when' }, smvWhen(x.at)),
    );
  }

  async function loadSmv() {
    if (smv.feed) return renderSmv();
    try {
      smv.feed = await api('/api/smv');
    } catch (e) {
      $('smv-list').replaceChildren(h('li', { class: 'err' }, e.message));
      return;
    }
    renderSmv();
  }

  function renderSmv() {
    const r = smv.feed;
    if (!r) return;
    const list = $('smv-list');
    $('smv-note').textContent = r.fetchedAt ? ` · revisado ${ago(r.fetchedAt)}` : '';
    if (!r.items.length) {
      list.replaceChildren(h('li', { class: 'muted' }, r.fetchedAt ? 'No hubo hechos de importancia en los últimos 14 días.' : 'Se cargan en las próximas horas.'));
      $('smv-more').hidden = true;
      return;
    }
    list.replaceChildren(...r.items.slice(0, smv.shown).map((x) => smvItem(x)));
    $('smv-more').hidden = r.items.length <= smv.shown;
  }

  /** En la ficha de BAP, BVN, SCCO, CPAC o IFS: sus hechos de los últimos 60 días (se piden una vez por sesión). */
  function renderDetailSmv() {
    const sym = state.selected;
    const wrap = $('d-smv');
    if (!sym || !SMV_SYMBOLS.has(sym)) {
      wrap.hidden = true;
      return;
    }
    const r = smv.by.get(sym);
    if (!r) {
      smv.by.set(sym, 'cargando');
      api(`/api/smv?symbol=${encodeURIComponent(sym)}`)
        .then((x) => smv.by.set(sym, x))
        .catch((e) => smv.by.set(sym, { error: e.message }))
        .finally(() => {
          if (state.selected === sym) renderDetailSmv();
        });
    }
    if (!r || r === 'cargando') {
      wrap.hidden = true;
      return;
    }
    $('d-smv-name').textContent = r.issuer?.name ?? sym;
    if (r.error) {
      wrap.hidden = false;
      $('d-smv-list').replaceChildren(h('li', { class: 'err' }, r.error));
      return;
    }
    wrap.hidden = !r.items.length;
    $('d-smv-list').replaceChildren(...r.items.slice(0, 5).map((x) => smvItem(x, false)));
  }

  /**
   * Una tarjeta por serie: último dato, variaciones (24 horas si la serie la trae, 1 y 12 meses) y el gráfico del último
   * año. La usan materias primas y «Más del Perú» (BCRP) y cripto (CoinGecko).
   */
  function renderMarketCards(host, list, r, opts = {}) {
    const draws = [];
    const cards = list.map((m) => {
      const s = r.data[m.key];
      const last = s?.summary?.last;
      if (!last) return h('div', { class: 'pm-card' }, metric(m.label, '—', opts.empty ?? 'Sin datos del BCRP'));
      const fmt = (v) => nf(m.dec).format(v);
      const pbRow = (sr, v0, v1) => ({ value: `${arrowOf(v1 - v0)} ${sign(v1 - v0)}${nf(0).format(Math.abs(v1 - v0))} pb`, label: `${fmt(v0)} → ${fmt(v1)}` });
      // Sin título: «último año» lo dice una sola vez el encabezado de la sección.
      const block = chartBlock(
        null,
        s.points.map(([date, v]) => ({ date, v })),
        {
          fmt,
          height: 120,
          aria: `${m.label}, último año (${m.unit})`,
          ...(m.kind === 'pp' ? { measureRow: measureRowPoints } : m.kind === 'pb' ? { measureRow: pbRow } : {}),
        },
        { filename: `${opts.csvPrefix ?? 'bcrp'}_${m.csv}_${today()}.csv`, header: ['fecha', m.csv], rows: s.points },
      );
      draws.push(block.draw);
      return h(
        'div',
        { class: 'pm-card' },
        metric(m.label, fmt(last.value), `${m.unit} · ${fDay.format(day(last.date))}`),
        h(
          'div',
          { class: 'pm-chgs' },
          s.change24h != null ? changeChip('24 h', { pct: s.change24h }) : null,
          changeChip('1 mes', s.summary.m1, m.kind),
          changeChip('12 meses', s.summary.y1, m.kind),
        ),
        block.wrap,
      );
    });
    host.replaceChildren(...cards, ...[staleHint(r)].filter(Boolean));
    for (const draw of draws) draw();
  }

  // ---------- termómetro del S&P 500 (solo el dueño: SPY de Twelve Data) ----------
  // Cuánto se mueve el mercado, no hacia dónde (src/services/thermometer.ts): la volatilidad de 20 días frente a las
  // últimas 500 sesiones, el tamaño de un día normal, los días extremos, la distancia al máximo y la racha.
  const REGIMES = ['tranquilo', 'normal', 'agitado'];
  const pctAbs = (f, dec = 2) => `${nf(dec).format(Math.abs(f) * 100)}%`;

  async function loadThermometer() {
    const host = $('thermo-body');
    try {
      const r = await api('/api/thermometer');
      const t = r.data;
      if (!t) {
        host.replaceChildren(h('p', { class: 'muted' }, 'Todavía no hay historia suficiente del SPY.'));
        return;
      }
      const p = Math.round(t.percentile * 100);
      const mark = h('b', { class: 'th-mark' });
      mark.style.left = `${Math.min(100, Math.max(0, t.percentile * 100))}%`;
      const gauge = h(
        'div',
        { class: 'th-gauge', role: 'img', 'aria-label': `Volatilidad ${t.regime}: más alta que la del ${p} % de las últimas ${t.sessions} sesiones` },
        h('div', { class: 'th-bar' }, h('i'), h('i'), h('i'), mark),
        h('div', { class: 'th-zones', 'aria-hidden': 'true' }, ...REGIMES.map((z) => h('span', { class: z === t.regime ? 'on' : null }, z))),
      );
      const big = h('p', { class: 'th-big' }, t.regime[0].toUpperCase() + t.regime.slice(1), h('span', { class: 'muted' }, ` · ${pctAbs(t.vol20, 1)} al año`));
      const versus = p >= 50 ? `Más movido que el ${p} %` : `Más tranquilo que el ${100 - p} %`;
      const sub = h(
        'p',
        { class: 'hint th-sub' },
        `${versus} de las últimas ${t.sessions} sesiones. Último cierre (${fDay.format(day(t.last.date))}): `,
        h('span', { class: trend(t.last.ret) }, `${arrowOf(t.last.ret)} ${pctFrac(t.last.ret, 2)}`),
      );
      const ex = t.extremes;
      const fromHigh = t.fromHigh.pct > -0.0005 ? 'En su máximo' : h('span', { class: 'down' }, `▼ ${pctFrac(t.fromHigh.pct, 1)}`);
      // El valor corto (cabe en la columna angosta); la dirección y cuánto suma, debajo.
      const streak = t.streak ? `${t.streak.days} ${t.streak.days === 1 ? 'día' : 'días'}` : 'Sin racha';
      const streakSub = t.streak
        ? h('span', {}, t.streak.dir === 'up' ? 'al alza · ' : 'a la baja · ', h('span', { class: trend(t.streak.ret) }, `${arrowOf(t.streak.ret)} ${pctFrac(t.streak.ret, 1)}`))
        : null;
      const lastBig = ex.last3 ? ` · el último, ${fDayYear.format(day(ex.last3.date))} (${pctFrac(ex.last3.ret, 1)})` : '';
      const metrics = h(
        'div',
        { class: 'metric-row th-metrics' },
        metric('Un día normal', `±${pctAbs(t.typical.recent)}`, `en ${t.sessions} sesiones: ±${pctAbs(t.typical.sample)}`),
        metric('2 de cada 3 días', `±${pctAbs(t.oneSd)}`, 'o menos, con la volatilidad de hoy'),
        metric('Desde el máximo', fromHigh, `máximo del ${fDayYear.format(day(t.fromHigh.date))}`),
        metric('Racha', streak, streakSub),
        metric('Días de más de ±3 %', String(ex.over3), `una curva normal esperaría ${nf(1).format(ex.expected3)}${lastBig}`),
      );
      const block = chartBlock(
        'Volatilidad de 20 días, últimas 500 sesiones (% al año)',
        t.series.map(([date, v]) => ({ date, v: v * 100 })),
        {
          fmt: (v) => `${nf(1).format(v)}%`,
          refs: [t.bands.low * 100, t.bands.high * 100],
          height: 120,
          aria: `Volatilidad de 20 días del SPY en las últimas ${t.sessions} sesiones; las líneas marcan los tercios`,
        },
        { filename: `spy_volatilidad_20_dias_${today()}.csv`, header: ['fecha', 'volatilidad_20_dias_pct_anual'], rows: t.series.map(([d, v]) => [d, round6(v * 100)]) },
      );
      host.replaceChildren(gauge, big, sub, metrics, block.wrap, h('p', { class: 'hint' }, `Al cierre del ${fDayYear.format(day(t.asOf))}. Mide cuánto se mueve, no hacia dónde (detalle en el «?»).`), ...[staleHint(r)].filter(Boolean));
      block.draw();
    } catch (e) {
      host.replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  // ---------- calendario ----------
  const KIND_LABEL = { bcrp: 'BCRP', fed: 'Fed', inei: 'INEI', bls: 'BLS', empresa: 'Empresa', cumple: '🎂' };
  const CAL_FIRST = 6; // eventos a la vista antes de «Ver más»
  const fCalDay = fmt({ weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const calDay = (date) => fCalDay.format(day(date)).replace(/[.,]/g, '');

  const daysUntil = (date) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${limaDate(new Date())}T12:00:00Z`)) / 86_400_000);

  function untilText(date) {
    const days = daysUntil(date);
    return days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
  }

  // ---------- resultados de empresas (Finnhub, solo el dueño) ----------
  const MOMENT = { bmo: 'antes de la apertura', amc: 'después del cierre', dmh: 'durante la sesión' };
  /** «3T 2026»: trimestre fiscal de la empresa. */
  const quarterOf = (r) => (r.quarter && r.year ? `${r.quarter}T ${r.year}` : null);
  /** Próxima presentación de resultados de un símbolo (los eventos del calendario ya vienen en orden). */
  const nextEarnings = (sym) => state.calendar?.events.find((e) => e.company?.symbol === sym) ?? null;
  /** Último resultado presentado en el último mes. */
  const lastEarnings = (sym) => state.calendar?.companies?.recent?.find((r) => r.symbol === sym) ?? null;

  /** En la fila de la lista: la empresa presenta resultados en los próximos 7 días. */
  function earningsChip(sym) {
    const e = nextEarnings(sym);
    const days = e ? daysUntil(e.date) : Infinity;
    if (days > 7) return null;
    const label = days === 0 ? 'Resultados hoy' : days === 1 ? 'Resultados mañana' : `Resultados en ${days} d`;
    const moment = e.company.hour ? `, ${MOMENT[e.company.hour]}` : '';
    return h('span', { class: 'sig', title: `Presenta resultados el ${calDay(e.date)}${moment}` }, label);
  }

  /** En la ficha: próximos resultados y, si hubo en el último mes, el último con la sorpresa del BPA. */
  function renderEarnings(sym) {
    const el = $('d-earn');
    const lines = [];
    const next = nextEarnings(sym);
    if (next) {
      const c = next.company;
      const facts = [`${calDay(next.date)} (${untilText(next.date)})`, c.hour ? MOMENT[c.hour] : null, quarterOf(c), c.epsEstimate != null ? `BPA estimado ${nf(2).format(c.epsEstimate)}` : null];
      lines.push(h('span', {}, h('strong', {}, 'Próximos resultados: '), facts.filter(Boolean).join(' · ')));
    }
    const last = lastEarnings(sym);
    if (last) {
      const surprise = last.epsEstimate ? (last.epsActual - last.epsEstimate) / Math.abs(last.epsEstimate) : null;
      lines.push(
        h(
          'span',
          {},
          h('strong', {}, 'Último resultado: '),
          [calDay(last.date), quarterOf(last), `BPA ${nf(2).format(last.epsActual)}`].filter(Boolean).join(' · '),
          last.epsEstimate != null ? ` frente a ${nf(2).format(last.epsEstimate)} esperado` : '',
          surprise != null ? h('span', { class: trend(surprise) }, ` (${pctFrac(surprise)})`) : null,
        ),
      );
    }
    el.hidden = !lines.length;
    el.replaceChildren(...lines);
  }

  /** El dato que el evento puede mover, si ya cargaron Perú o EE. UU. */
  function currentFor(kind) {
    const pe = state.peruData;
    const us = state.usaData;
    if (kind === 'bcrp' && pe?.policyRate) return `Tasa de referencia hoy: ${rate(pe.policyRate.value)}`;
    if (kind === 'fed' && us?.fedFunds) return `Tasa efectiva hoy: ${rate(us.fedFunds.value)}`;
    const last = kind === 'inei' ? pe?.inflation?.at(-1) : kind === 'bls' ? us?.cpiYoY?.at(-1) : null;
    return last ? `Último dato: ${rate(last.value, kind === 'bls' ? 1 : 2)} (${fMonthYear.format(day(last.date))})` : null;
  }

  function renderCalendar() {
    const r = state.calendar;
    if (!r) return;
    const list = $('calendar');
    // Va en una columna angosta: primero lo más cercano y el resto con «Ver más».
    const all = withBirthday(r.events, r.birthday);
    const events = all.slice(0, state.calAll ? 12 : CAL_FIRST);
    $('cal-more').hidden = state.calAll || all.length <= CAL_FIRST;
    if (!events.length) {
      list.replaceChildren(h('li', { class: 'muted' }, 'No hay eventos cargados para los próximos meses.'));
    } else {
      list.replaceChildren(
        ...events.map((e) => {
          const when = [untilText(e.date), e.at ? `${fTime.format(new Date(e.at))} h` : null].filter(Boolean).join(' · ');
          const c = e.company;
          const extra = c ? (c.epsEstimate != null ? `BPA estimado ${nf(2).format(c.epsEstimate)}` : null) : currentFor(e.kind);
          const sub = [e.detail, extra].filter(Boolean).join(' · ');
          // Los resultados de una acción de tu lista abren su ficha.
          const src = c
            ? h('button', { type: 'button', class: 'cal-src sym', title: `Abrir la ficha de ${c.symbol}` }, c.symbol)
            : h('span', { class: 'cal-src' }, KIND_LABEL[e.kind]);
          if (c) {
            src.addEventListener('click', () => openDetail(c.symbol));
          }
          return h(
            'li',
            { class: 'cal-row' },
            h('span', { class: 'cal-date' }, calDay(e.date)),
            src,
            h('span', { class: 'cal-body' }, h('span', {}, e.title, e.tentative ? h('small', {}, ' (tentativa)') : null), sub ? h('small', {}, sub) : null),
            h('span', { class: 'cal-when' }, when),
          );
        }),
      );
    }
    const until = Object.values(r.coverage).sort()[0];
    const notes = [until ? `Cargado hasta el ${fDayYear.format(day(until))}.` : null];
    const co = r.companies; // solo llega al dueño
    $('cal-src-co').hidden = !co?.enabled;
    if (co) {
      notes.push(
        co.enabled
          ? `Resultados de tu lista: Finnhub, solo para ti${co.note ? ` (${co.note.replace(/\.$/, '')})` : ''}.`
          : 'Para ver aquí las fechas de resultados de tu lista, carga la clave gratis de Finnhub (FINNHUB_API_KEY).',
      );
    }
    $('cal-note').textContent = notes.filter(Boolean).join(' ');
  }

  async function loadCalendar() {
    const sec = $('calendar').closest('section');
    try {
      const r = await api('/api/calendar?days=120');
      // Sin fechas oficiales cargadas no se muestra la sección (mejor nada que un calendario vacío).
      sec.hidden = !r.loaded;
      if (!r.loaded) return;
      state.calendar = r;
      renderCalendar();
      // Con resultados de empresas: avisos en la lista y la línea de la ficha abierta.
      if (r.companies?.enabled) {
        renderTiles();
        renderEod();
        if (state.selected) renderEarnings(state.selected);
      }
    } catch (e) {
      $('calendar').replaceChildren(h('li', { class: 'err' }, e.message));
    }
  }

  // ---------- pronósticos del grupo ----------
  const FC_KIND = { bcrp: 'BCRP', fed: 'Fed', inei: 'INEI', bls: 'BLS', dolar: 'Dólar' };
  const FC_CHOICES = ['sube', 'mantiene', 'baja'];
  const CHOICE_LABEL = { sube: '▲ Sube', mantiene: '■ Mantiene', baja: '▼ Baja' };
  const fcClose = fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });

  /** Un pronóstico o resultado como se lee: «▲ Sube», «2.15%», «S/ 3.712». */
  function fcValue(q, v) {
    if (v == null) return '—';
    if (q.type === 'choice') return CHOICE_LABEL[v] ?? v;
    return q.unit === 'S/' ? `S/ ${nf(3).format(v)}` : rate(v, q.step === 0.1 ? 1 : 2);
  }

  /** Lo que la pregunta puede mover hoy (sale de lo que ya cargaron Perú y EE. UU.). */
  function fcContext(q) {
    const pe = state.peruData;
    const us = state.usaData;
    if (q.kind === 'bcrp' && pe?.policyRate) return `Hoy: ${rate(pe.policyRate.value)}`;
    if (q.kind === 'fed') {
      const t = us?.fedTarget?.at(-1);
      return t ? `Hoy: ${nf(2).format(t.lower)}–${rate(t.upper)}` : null;
    }
    // Para la inflación de Lima y el dólar, también lo que esperan los analistas a 12 meses (encuesta del BCRP).
    const exp = pe?.expectations?.at(-1);
    const last = q.kind === 'inei' ? pe?.inflation?.at(-1) : q.kind === 'bls' ? us?.cpiYoY?.at(-1) : null;
    if (last) {
      const now = `Último dato: ${rate(last.value, q.kind === 'bls' ? 1 : 2)} (${fMonthYear.format(day(last.date))})`;
      return q.kind === 'inei' && exp?.inflation != null ? `${now} · analistas: ${rate(exp.inflation)} a 12 meses` : now;
    }
    const fx = q.kind === 'dolar' ? pe?.fx?.at(-1) : null;
    if (!fx) return null;
    return `Hoy: S/ ${nf(3).format(fx.sell)}${exp?.fx != null ? ` · analistas: S/ ${nf(3).format(exp.fx)} en 12 meses` : ''}`;
  }

  /**
   * «cierra en 3 días» y, aparte (para mostrarlo al pasar el mouse), la hora exacta: «mié 11 nov 23:59», un minuto
   * antes de la medianoche del cierre.
   */
  function fcCloses(iso) {
    const ms = Date.parse(iso) - Date.now();
    const days = Math.floor(ms / 86_400_000);
    const left = ms < 3_600_000 ? 'en menos de 1 h' : days < 1 ? `en ${Math.floor(ms / 3_600_000)} h` : days === 1 ? 'mañana' : `en ${days} días`;
    return { text: `cierra ${left}`, exact: fcClose.format(new Date(Date.parse(iso) - 60_000)).replace(/[.,]/g, '') };
  }

  async function loadForecasts() {
    try {
      state.forecasts = await api('/api/forecasts');
      renderForecasts();
    } catch (e) {
      $('fc-open').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /** Guarda un pronóstico o el nombre; el servidor responde todo actualizado. */
  async function sendForecast(path, method, body, errEl) {
    try {
      state.forecasts = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.fcEditName = false;
      renderForecasts();
      // El nombre es el mismo en todos los juegos de la hoja: con él ya se puede jugar en los demás.
      if (path === '/api/forecasts/name') loadGames();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
    }
  }

  /** Cuando llegan Perú o EE. UU., las tarjetas suman el dato de hoy (salvo que estés escribiendo en una). */
  function refreshForecastContext() {
    const typing = $('forecasts').contains(document.activeElement) || $('fc-me').contains(document.activeElement);
    if (state.forecasts && !typing) renderForecasts();
  }

  function renderForecasts() {
    const v = state.forecasts;
    if (!v) return;
    renderFcName(v);
    const open = v.questions.filter((q) => q.status === 'open');
    $('fc-open').replaceChildren(
      ...(open.length ? open.map((q) => fcCard(q, v)) : [h('p', { class: 'muted' }, 'No hay preguntas abiertas: cada una se abre 45 días antes de su anuncio.')]),
    );
    renderGameBadge();
    const past = v.questions.filter((q) => q.status !== 'open').reverse();
    $('fc-past').replaceChildren(...(past.length ? past.map(fcPast) : [h('p', { class: 'muted' }, 'Todavía no cerró ninguna pregunta.')]));
    renderFcRanking(v);
  }

  function renderFcName(v) {
    const host = $('fc-me');
    if (v.me.alias && !state.fcEditName) {
      const change = h('button', { type: 'button', class: 'linkish' }, 'cambiar');
      change.addEventListener('click', () => {
        state.fcEditName = true;
        renderFcName(v);
      });
      host.replaceChildren(h('p', { class: 'hint fc-who' }, 'Juegas como ', h('strong', {}, v.me.alias), ' · ', change));
      return;
    }
    const input = h('input', { id: 'fc-name', maxlength: 20, autocomplete: 'nickname', value: v.me.alias ?? '', placeholder: 'Tu nombre' });
    const err = h('p', { class: 'err', hidden: true });
    const form = h(
      'form',
      { class: 'fc-name' },
      h('label', { for: 'fc-name' }, v.me.alias ? 'Tu nombre en el ranking' : 'Para jugar, elige el nombre con el que te verán los demás en el ranking'),
      h('div', { class: 'wl-row' }, input, h('button', { type: 'submit' }, 'Guardar')),
      err,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendForecast('/api/forecasts/name', 'PUT', { alias: input.value }, err);
    });
    host.replaceChildren(form);
  }

  function fcCard(q, v) {
    const err = h('p', { class: 'err', hidden: true });
    const off = !v.me.alias; // sin nombre no se puede jugar
    let control;
    if (q.type === 'choice') {
      control = h(
        'div',
        { class: 'fc-choices', role: 'group', 'aria-label': 'Tu pronóstico' },
        ...FC_CHOICES.map((c) => {
          const b = h('button', { type: 'button', 'aria-pressed': String(q.mine === c), disabled: off }, CHOICE_LABEL[c]);
          b.addEventListener('click', () => sendForecast('/api/forecasts', 'POST', { questionId: q.id, value: c }, err));
          return b;
        }),
      );
    } else {
      const input = h('input', { type: 'number', inputmode: 'decimal', step: q.step, min: q.min, max: q.max, value: q.mine ?? '', 'aria-label': `Tu pronóstico (${q.unit})`, disabled: off });
      control = h(
        'form',
        { class: 'fc-number' },
        q.unit === 'S/' ? h('span', { class: 'muted' }, 'S/') : null,
        input,
        q.unit === '%' ? h('span', { class: 'muted' }, '%') : null,
        h('button', { type: 'submit', disabled: off }, q.mine == null ? 'Guardar' : 'Cambiar'),
      );
      control.addEventListener('submit', (e) => {
        e.preventDefault();
        sendForecast('/api/forecasts', 'POST', { questionId: q.id, value: input.value }, err);
      });
    }
    const ctx = fcContext(q);
    // Tu pronóstico ya se ve en el control (el botón marcado o el número escrito): aquí solo cuántos y cuándo cierra.
    const who = q.count ? `${q.count} ${q.count === 1 ? 'pronosticó' : 'pronosticaron'}` : 'Nadie pronosticó aún';
    const closes = fcCloses(q.closesAt);
    return h(
      'article',
      { class: 'fc-card' },
      h('div', { class: 'fc-head' }, h('span', { class: 'cal-src' }, FC_KIND[q.kind]), h('span', { class: 'fc-when' }, `${calDay(q.date)}${q.tentative ? ' (tentativa)' : ''}`)),
      h('h3', {}, q.title),
      ctx ? h('p', { class: 'hint' }, ctx) : null,
      control,
      err,
      h('p', { class: 'hint', title: `Cierra el ${closes.exact}` }, `${who} · ${closes.text}`),
    );
  }

  /** Cerradas (con lo que puso cada uno) y resueltas (con el resultado y los puntos). */
  function fcPast(q) {
    const status = q.status === 'resolved' ? `Resultado: ${fcValue(q, q.result)}${q.minePoints != null ? ` · tú: ${nf(1).format(q.minePoints)} pts` : ''}` : 'Esperando el dato';
    const group =
      q.consensus == null
        ? null
        : q.type === 'choice'
          ? FC_CHOICES.filter((c) => q.consensus[c]).map((c) => `${CHOICE_LABEL[c]}: ${q.consensus[c]}`).join(' · ')
          : `Mediana del grupo: ${fcValue(q, q.consensus)}`;
    const rows = (q.entries ?? []).map((e) =>
      h(
        'li',
        { class: e.mine ? 'mine' : null },
        h('span', {}, e.mine ? `${e.alias} (tú)` : e.alias),
        h('span', {}, fcValue(q, e.value)),
        h('span', { class: 'pts' }, e.points != null ? `${nf(1).format(e.points)} pts` : ''),
      ),
    );
    return h(
      'details',
      { class: 'fc-past' },
      h('summary', {}, h('span', { class: 'cal-src' }, FC_KIND[q.kind]), h('span', { class: 'fc-title' }, q.title), h('span', { class: 'fc-res' }, status)),
      group ? h('p', { class: 'hint' }, group) : null,
      rows.length ? h('ol', { class: 'fc-entries' }, ...rows) : h('p', { class: 'muted' }, 'Nadie pronosticó esta pregunta.'),
    );
  }

  function renderFcRanking(v) {
    const host = $('fc-rank');
    if (!v.ranking.length) {
      host.replaceChildren(h('p', { class: 'hint' }, 'El ranking empieza con la primera pregunta resuelta.'));
      return;
    }
    host.replaceChildren(
      h(
        'table',
        { class: 'co-table fc-rank' },
        h('thead', {}, h('tr', {}, ...['#', 'Nombre', 'Puntos', 'Resueltos', 'Promedio'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          ...v.ranking.map((r, i) =>
            h(
              'tr',
              { class: r.mine ? 'mine' : null },
              h('td', {}, String(i + 1)),
              h('td', {}, r.mine ? `${r.alias} (tú)` : r.alias),
              h('td', {}, nf(1).format(r.points)),
              h('td', {}, String(r.count)),
              h('td', {}, nf(1).format(r.points / r.count)),
            ),
          ),
        ),
      ),
    );
  }

  // ---------- gráfico del día, 2/3 del promedio y liga de acciones ----------
  // Servidor: src/game/minijuegos.ts y src/game/acciones.ts, en el mismo Durable Object del mercado. El gráfico usa
  // datos públicos (BCRP y FRED); la liga, la clave gratis de Twelve Data de cada jugador.
  const TD_SIGNUP = 'https://twelvedata.com/register';
  const TD_KEYS = 'https://twelvedata.com/account/api-keys';
  const fMonthLong = fmt({ month: 'long', timeZone: 'UTC' });
  const usdFmt = (v) => `US$ ${nf(0).format(Math.round(v))}`;
  const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  /** Rendimiento (fracción) con flecha y signo, como el resto del panel: «▲ +2.1%». */
  const retFmt = (r) => {
    if (r == null) return '—';
    const t = trend(Math.round(r * 1000));
    return `${t === 'up' ? '▲' : t === 'down' ? '▼' : '■'} ${r > 0 ? '+' : r < 0 ? '−' : ''}${nf(1).format(Math.abs(r * 100))}%`;
  };
  const retSpan = (r) => h('span', { class: r == null ? 'muted' : trend(Math.round(r * 1000)) }, retFmt(r));

  async function loadGames() {
    try {
      state.games = await api('/api/games');
      renderGames();
    } catch (e) {
      for (const id of ['gd-body', 'k23-body', 'lg-body']) $(id).replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /** Elige, responde o da una orden; el servidor responde los tres juegos actualizados. */
  async function sendGames(path, body, errEl) {
    errEl.hidden = true;
    try {
      state.games = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      renderGames();
      return true;
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
      return false;
    }
  }

  function renderGames() {
    const v = state.games;
    if (!v) return;
    renderChartDay(v);
    renderK23(v);
    renderLeague(v);
    renderGameBadge();
    syncPanelKey(v);
  }

  /** La pestaña «Juego» cuenta lo que te falta: pronósticos abiertos, el gráfico de hoy y el número de la semana. */
  function renderGameBadge() {
    const fc = state.forecasts ? state.forecasts.questions.filter((q) => q.status === 'open' && q.mine == null).length : 0;
    const g = state.games;
    const n = fc + (g ? (g.grafico.available && !g.grafico.mine ? 1 : 0) + (g.dosTercios.mine == null ? 1 : 0) : 0);
    $('game-badge').hidden = !n;
    $('game-badge').textContent = String(n);
    $('tab-juego').setAttribute('aria-label', n ? `Juego: ${n} ${n === 1 ? 'pendiente' : 'pendientes'}` : 'Juego');
  }

  function renderChartDay(v) {
    const g = v.grafico;
    const body = $('gd-body');
    if (!g.available) {
      body.replaceChildren(h('p', { class: 'muted' }, 'Hoy no hay gráfico: faltan datos. Vuelve más tarde.'));
      return;
    }
    const err = h('p', { class: 'err', hidden: true });
    const chart = h('div', { class: 'chart gd-chart', role: 'img', 'aria-label': 'Gráfico de una serie sin nombre' });
    const can = !!v.alias && !g.mine;
    const options = h(
      'div',
      { class: `gd-options${g.mine ? ' gd-done' : ''}`, role: 'group', 'aria-label': '¿Qué serie es?' },
      ...g.options.map((o) => {
        const cls = g.answer ? (o.id === g.answer.id ? 'ok' : g.mine?.option === o.id ? 'bad' : null) : null;
        const b = h('button', { type: 'button', class: cls, disabled: !can, 'aria-pressed': String(g.mine?.option === o.id) }, o.name);
        b.addEventListener('click', () => sendGames('/api/games/grafico', { option: o.id }, err));
        return b;
      }),
    );
    const lines = [];
    if (g.mine && g.answer) lines.push(h('p', { class: 'gd-result' }, `${g.mine.correct ? '¡Bien! Era' : 'Era'} «${g.answer.name}». Hoy acertaron ${g.today.correct} de ${g.today.played}.`));
    else if (!v.alias) lines.push(h('p', { class: 'hint' }, 'Para jugar, elige tu nombre arriba.'));
    else lines.push(h('p', { class: 'hint' }, g.today.played ? `${g.today.played} ya ${g.today.played === 1 ? 'respondió' : 'respondieron'} hoy.` : 'Nadie respondió todavía.'));
    if (g.me) lines.push(h('p', { class: 'hint' }, `Tu racha: ${g.me.streak} · la mejor: ${g.me.best} · aciertos: ${g.me.correct} de ${g.me.played}`));
    if (g.top.length) lines.push(h('p', { class: 'hint' }, `Mejores rachas: ${g.top.map((t) => `${t.alias} ${t.best}`).join(' · ')}`));
    if (g.yesterday) lines.push(h('p', { class: 'hint' }, `Ayer era «${g.yesterday.name}»: acertaron ${g.yesterday.correct} de ${g.yesterday.played}.`));
    const when = (d) => fDayYear.format(day(d)).replace(/\./g, '');
    body.replaceChildren(chart, h('p', { class: 'hint gd-span' }, `Del ${when(g.from)} al ${when(g.to)}`), options, ...lines, err);
    // Sin escala: solo la forma (el servidor la manda de 0 a 100).
    requestAnimationFrame(() => {
      if (chart.isConnected) drawLine(chart, g.points.map((p, i) => ({ date: String(i), v: p })), { domain: [0, 100], height: 90 });
    });
  }

  function renderK23(v) {
    const k = v.dosTercios;
    const err = h('p', { class: 'err', hidden: true });
    const parts = [];
    const closes = fcClose.format(new Date(Date.parse(k.closesAt) - 60_000)).replace(/[.,]/g, '');
    if (!v.alias) parts.push(h('p', { class: 'hint' }, 'Para jugar, elige tu nombre arriba.'));
    else if (k.mine != null && !state.k23Edit) {
      const change = h('button', { type: 'button', class: 'linkish' }, 'cambiar');
      change.addEventListener('click', () => {
        state.k23Edit = true;
        renderK23(v);
      });
      parts.push(h('p', { class: 'k23-mine' }, 'Elegiste ', h('strong', {}, String(k.mine)), ' · ', change));
    } else {
      const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 100, step: 1, value: k.mine ?? '', required: true, 'aria-label': 'Tu número, del 0 al 100' });
      const form = h('form', { class: 'pr-trade' }, input, h('button', { type: 'submit' }, k.mine == null ? 'Elegir' : 'Cambiar'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        state.k23Edit = false;
        if (!(await sendGames('/api/games/dos-tercios', { value: Number(input.value) }, err))) state.k23Edit = true;
      });
      parts.push(form);
    }
    parts.push(h('p', { class: 'hint' }, `${k.count ? `${k.count} ${k.count === 1 ? 'eligió' : 'eligieron'} esta semana` : 'Nadie eligió todavía'} · cierra el ${closes}`));
    const last = k.last;
    if (last && last.avg == null) parts.push(h('p', { class: 'hint' }, 'La semana pasada jugó una sola persona: no hubo ganador.'));
    else if (last) {
      parts.push(h('p', { class: 'k23-last' }, `Semana pasada: promedio ${nf(1).format(last.avg)} → 2/3: `, h('strong', {}, nf(1).format(last.target)), `. Ganó ${listJoin(last.winners)}.`));
      parts.push(
        h('details', { class: 'pr-how' }, h('summary', {}, 'Lo que eligió cada uno'), h('p', { class: 'hint' }, last.picks.map((p) => `${p.mine ? `${p.alias} (tú)` : p.alias} ${p.value}`).join(' · '))),
      );
    }
    if (k.wins.length) parts.push(h('p', { class: 'hint' }, `Victorias: ${k.wins.map((w) => `${w.alias} ${w.wins}`).join(' · ')}`));
    parts.push(err);
    $('k23-body').replaceChildren(...parts);
  }

  /* Liga de acciones: lo principal de la hoja «Juego» (opción A, «Carrera», 4 nov). Arriba, quién lidera la temporada,
     tu puesto y la carrera de la quincena; abajo, tu cartera y para comprar (o cómo entrar). Las temporadas van del 1 al
     15 y del 16 a fin de mes; al cerrar cada una, el servidor guarda el resultado y aparece en «Campeones». Entre todos
     solo se ven porcentajes y símbolos. */
  const LG_NAMES = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', NVDA: 'Nvidia', AAPL: 'Apple', MSFT: 'Microsoft', GLD: 'Oro', EPU: 'Perú', BAP: 'Credicorp', SCCO: 'Southern Copper', BVN: 'Buenaventura' };
  /** «1–15 nov» (con el día, es-PE escribe el mes en minúscula; solo, «Nov.»). */
  const seasonRange = (se) => `${Number(se.from.slice(8))}–${fDay.format(day(se.to)).replace('.', '')}`;
  const dayGap = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
  const addDay = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  /** Diferencia de rendimientos en puntos porcentuales: «5.0». */
  const ptsGap = (a, b) => nf(1).format(Math.abs((a - b) * 100));
  const foldTxt = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const shortName = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  /** Lo que está en cola para comprar (ya no se puede usar para otra compra). */
  const committedOf = (m) => m.orders.filter((o) => o.kind === 'comprar').reduce((t, o) => t + (o.usd ?? 0), 0);
  /** Donde se dibuja la carrera: se rehace al cambiar el ancho de la ventana. */
  let raceHost = null;

  function renderLeague(v) {
    const l = v.liga;
    const err = h('p', { class: 'err', hidden: true });
    const m = l.me;
    const member = !!m?.connected;
    $('lg-month').textContent = `Temporada ${seasonRange(l.season)}`;
    raceHost = h('div', { class: 'lg-race' });
    const mine = member ? [leaguePortfolio(l, m, err), leagueTicket(l, m, err)] : [leaguePitch(v, err)];
    $('lg-body').replaceChildren(leagueHeadline(l), raceHost, leagueRank(l), ...leagueChamps(l, err), h('div', { class: member ? 'lg-duo' : 'lg-solo' }, ...mine), err);
    drawRace(raceHost, l);
    renderLeagueTeaser(v);
    if (state.openTutorial) {
      state.openTutorial = false;
      if (member || v.owner) $('league').scrollIntoView({ block: 'start' });
      else openLeagueTutorial();
    }
  }

  /** «Caro lidera con ▲ +5.5%», tu puesto y cuánto te falta, y la barra de la temporada (cuántos cierres quedan). */
  function leagueHeadline(l) {
    const st = l.standings;
    const se = l.season;
    const lead = st[0];
    const meIx = st.findIndex((x) => x.mine);
    const me = st[meIx];
    const started = st.some((x) => x.retSeason);
    let big;
    if (!st.length) big = ['Todavía no juega nadie: abre tú la temporada.'];
    else if (!started) big = ['Nueva temporada: todos salen de 0.'];
    else if (meIx === 0) big = ['Lideras con ', retSpan(lead.retSeason)];
    else big = [h('strong', {}, lead.alias), ' lidera con ', retSpan(lead.retSeason)];
    const text = h('div', {}, h('p', { class: 'lg-big' }, ...big));
    if (me && started && st.length > 1) {
      const other = meIx === 0 ? st[1] : lead;
      const gap = other.retSeason == null ? '' : meIx === 0 ? ` · ${ptsGap(me.retSeason, other.retSeason)} puntos sobre ${other.alias}` : ` · a ${ptsGap(lead.retSeason, me.retSeason)} puntos de ${lead.alias}`;
      text.append(h('p', { class: 'lg-me' }, 'Vas en el puesto ', h('strong', {}, String(meIx + 1)), ` de ${st.length} con `, retSpan(me.retSeason), gap));
    }
    const done = se.total - se.left;
    const fill = h('i');
    fill.style.width = `${se.total ? (100 * done) / se.total : 0}%`;
    const bar = h('span', { class: 'bar', role: 'progressbar', 'aria-label': 'Cierres jugados de la temporada', 'aria-valuemin': 0, 'aria-valuemax': se.total, 'aria-valuenow': done }, fill);
    const left = se.left === 0 ? 'terminó' : se.left === 1 ? 'queda 1 cierre' : `quedan ${se.left} cierres`;
    const prog = h('div', { class: 'lg-season', title: `La temporada termina con el cierre del ${calDay(se.last)}` }, h('span', { class: 'k' }, 'Temporada'), bar, h('span', { class: 'left' }, left));
    return h('div', { class: 'lg-head' }, text, prog);
  }

  /**
   * La carrera de la quincena: una línea por persona con su rendimiento al cierre de cada sesión (la tuya en cian; la de
   * quien lidera, resaltada; las demás en gris), desde la salida hasta la meta. Se dibuja al ancho de la sección.
   */
  function drawRace(host, l) {
    const lines = l.race.filter((r) => r.points.length);
    host.hidden = !lines.length;
    if (!lines.length) return host.replaceChildren();
    const se = l.season;
    const W = Math.max(300, Math.round(host.clientWidth || $('lg-body').clientWidth || 700));
    const narrow = W < 520;
    const H = narrow ? 210 : 240;
    const L = 44;
    const R = narrow ? 104 : 136;
    const T = 12;
    const B = 26;
    const start = addDay(se.from, -1);
    const span = Math.max(1, dayGap(start, se.to));
    const X = (d) => L + (Math.min(span, Math.max(0, dayGap(start, d))) / span) * (W - L - R);
    const vals = lines.flatMap((r) => r.points.map((p) => p.r));
    const pad = Math.max(0.005, (Math.max(0, ...vals) - Math.min(0, ...vals)) * 0.12);
    const lo = Math.min(0, ...vals) - pad;
    const hi = Math.max(0, ...vals) + pad;
    const Y = (r) => T + ((hi - r) / (hi - lo)) * (H - T - B);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': raceAria(l) });
    const text = (x, y, t, cls, anchor = 'start') => {
      const el = s('text', { x, y, class: cls, 'text-anchor': anchor });
      el.textContent = t;
      svg.append(el);
    };
    // Guías cada 0,5, 1, 2, 5 o 10 puntos, con el 0 marcado.
    const step = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2].find((x) => (hi - lo) / x <= 5) ?? 0.5;
    for (let g = Math.ceil(lo / step) * step; g <= hi + 1e-9; g += step) {
      const zero = Math.abs(g) < 1e-9;
      svg.append(s('line', { x1: L, x2: W - R, y1: Y(g), y2: Y(g), class: zero ? 'zero' : 'grid' }));
      text(L - 6, Y(g) + 4, zero ? '0%' : `${g > 0 ? '+' : '−'}${nf(step < 0.01 ? 1 : 0).format(Math.abs(g * 100))}%`, 'ax', 'end');
    }
    // El último cierre y la meta.
    const lastD = lines.flatMap((r) => r.points.map((p) => p.d)).sort().at(-1);
    const xl = X(lastD);
    const xf = X(se.to);
    svg.append(s('line', { x1: xl, x2: xl, y1: T, y2: H - B, class: 'today' }), s('line', { x1: xf, x2: xf, y1: T, y2: H - B, class: 'finish' }));
    text(L, H - 6, 'salida', 'ax');
    if (xf - xl > 70 && xl - L > 60) text(xl, H - 6, fDay.format(day(lastD)).replace('.', ''), 'ax', 'middle');
    text(xf, H - 6, `🏁 ${fDay.format(day(se.to)).replace('.', '')}`, 'ax fin', 'middle');
    // Los demás abajo, quien lidera encima y la tuya arriba de todo.
    const leader = l.standings[0]?.alias;
    const kind = (r) => (r.mine ? 'me' : r.alias === leader ? 'lead' : 'other');
    // El puesto va delante del nombre, como en el ranking de abajo.
    const place = (r) => 1 + l.standings.findIndex((x) => (r.mine ? x.mine : !x.mine && x.alias === r.alias));
    const rank = { other: 0, lead: 1, me: 2 };
    const ends = [];
    for (const r of [...lines].sort((a, b) => rank[kind(a)] - rank[kind(b)])) {
      const k = kind(r);
      if (r.points.length > 1) svg.append(s('polyline', { points: r.points.map((q) => `${X(q.d).toFixed(1)},${Y(q.r).toFixed(1)}`).join(' '), class: `ln ${k}` }));
      const end = r.points.at(-1);
      svg.append(s('circle', { cx: X(end.d), cy: Y(end.r), r: k === 'other' ? 3 : 4.5, class: `dot ${k}` }));
      const who = r.mine ? 'Tú' : shortName(r.alias, narrow ? 7 : 12);
      const n = place(r);
      ends.push({ x: X(end.d), y: Y(end.r), k, label: `${n > 0 ? `${n} ` : ''}${who} ${retFmt(end.r)}` });
    }
    // Etiquetas al final de las líneas, sin pisarse.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 16);
    const over = ends.length ? ends.at(-1).y - (H - B - 2) : 0;
    if (over > 0) for (const e of ends) e.y = Math.max(T + 8, e.y - over);
    const lx = Math.max(...ends.map((e) => e.x)) + 10;
    for (const e of ends) text(lx, e.y + 4, e.label, `lbl ${e.k}`);
    host.replaceChildren(svg);
  }

  function raceAria(l) {
    const who = l.standings.map((x) => `${x.mine ? 'tú' : x.alias} ${retFmt(x.retSeason)}`).join(', ');
    return `Carrera de la temporada ${seasonRange(l.season)}${who ? `: ${who}` : ''}. El detalle está en el ranking de abajo.`;
  }

  /** El ranking de la temporada en una línea por persona: puesto, rendimiento y qué tiene (lo que ven todos). */
  function leagueRank(l) {
    if (!l.standings.length) return null;
    return h(
      'ol',
      { class: 'lg-rank', 'aria-label': 'Ranking de la temporada' },
      ...l.standings.map((x, i) =>
        h(
          'li',
          { class: x.mine ? 'mine' : null, title: `Desde que entró: ${retFmt(x.retTotal)}` },
          h('span', { class: 'n' }, String(i + 1)),
          h('span', { class: 'who' }, x.mine ? 'Tú' : x.alias),
          retSpan(x.retSeason),
          x.symbols.length ? h('span', { class: 'syms' }, x.symbols.slice(0, 3).join(' ') + (x.symbols.length > 3 ? ' …' : '')) : null,
        ),
      ),
    );
  }

  /** Campeones de las temporadas cerradas (los guarda el servidor al terminar cada quincena), los trofeos y para invitar. */
  function leagueChamps(l, err) {
    const invite = h('button', { type: 'button', class: 'linkish' }, 'invitar al grupo');
    invite.addEventListener('click', () => shareLeague(invite, err));
    const row = h('div', { class: 'lg-champs' }, h('span', { class: 'k' }, 'Campeones'));
    if (!l.seasons.length) row.append(h('span', { class: 'muted' }, `El primero se corona al terminar esta temporada, el ${calDay(l.season.to)}.`));
    for (const se of l.seasons.slice(0, 2)) {
      const c = se.podium[0];
      row.append(h('span', { class: 'c' }, h('span', { class: 'd' }, seasonRange(se)), `🏆 ${c.mine ? 'Tú' : c.alias} `, retSpan(c.ret)));
    }
    const trophies = l.titles.map((t) => `${t.mine ? 'Tú' : t.alias} ${t.titles}`).join(' · ');
    row.append(h('span', { class: 'end' }, trophies ? `Trofeos: ${trophies} · ` : '', invite));
    if (!l.seasons.length) return [row];
    const medal = ['🥇', '🥈', '🥉'];
    const all = h(
      'details',
      { class: 'lg-all' },
      h('summary', {}, 'Todas las temporadas'),
      h(
        'ol',
        {},
        ...l.seasons.map((se) =>
          h(
            'li',
            {},
            h('span', { class: 'd' }, seasonRange(se)),
            ...se.podium.map((p, i) => h('span', {}, `${medal[i]} ${p.mine ? 'Tú' : p.alias} `, retSpan(p.ret))),
            h('span', { class: 'muted' }, `${se.players} ${se.players === 1 ? 'jugó' : 'jugaron'}`),
          ),
        ),
      ),
    );
    return [row, all];
  }

  /** Para quien todavía no entró: de qué se trata y un botón grande (el dueño entra con la clave de Rueda). */
  function leaguePitch(v, err) {
    const m = v.liga.me;
    const go = h('button', { type: 'button', class: 'cta lg-go' }, m ? 'Conectar mi clave' : 'Entrar a la liga');
    go.addEventListener('click', () => (v.owner ? sendGames('/api/games/liga', { action: 'entrar' }, err) : openLeagueTutorial()));
    return h(
      'div',
      { class: 'lg-card lg-pitch-card' },
      h('p', { class: 'lg-pitch' }, 'Arma una cartera con acciones y ETF de verdad de EE. UU. (las mismas de Hapi) con US$ 10 000 de mentira y compite con el grupo. Cada quincena es una temporada: gana quien más rinde.'),
      m ? h('p', { class: 'hint' }, 'Tu cartera quedó guardada: conecta tu clave para que siga al día.') : null,
      go,
      h('p', { class: 'hint' }, v.owner ? 'Tú juegas con la clave de Rueda: no tienes que pegar nada.' : 'Entrar toma 2 minutos: te guiamos paso a paso.'),
    );
  }

  /** El enlace /#liga abre la hoja «Juego» con el tutorial: en el celular, «Compartir»; en la computadora, se copia. */
  async function shareLeague(btn, err) {
    const text = `Únete a la liga de acciones de Rueda: arma tu cartera con acciones de verdad y compite con el grupo. ${location.origin}/#liga`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'enlace copiado';
      setTimeout(() => (btn.textContent = 'invitar al grupo'), 2000);
    } catch {
      err.textContent = text;
      err.hidden = false;
    }
  }

  /** Aviso en «Mercados» para quien todavía no entró a la liga (se cierra con × y no vuelve en este equipo). */
  function renderLeagueTeaser(v) {
    $('lg-teaser').hidden = !!v.liga.me?.connected || prefs.get('mercados.liga-aviso', null) === 'cerrado';
  }

  // ---------- tutorial para entrar a la liga (y conectar la clave) ----------
  // Una ventana aparte, paso a paso: tu nombre (si falta), crear la cuenta gratis, copiar la clave y pegarla. Se abre
  // con «Entrar a la liga», con el aviso de «Mercados», con el enlace /#liga que se manda al grupo o con «Conectar mi
  // clave» de «Mercados» (`from: 'panel'`): es una sola clave para la liga y para los precios.
  const tut = { step: 0, steps: [], from: 'liga' };

  function openLeagueTutorial(from = 'liga') {
    tut.from = from;
    const g = state.games;
    tut.steps = [...(g && !g.alias ? ['nombre'] : []), 'cuenta', 'clave', 'pegar', 'listo'];
    tut.step = 0;
    renderTutorial();
    const d = $('lg-tutorial');
    if (!d.open) d.showModal();
  }

  function renderTutorial() {
    const d = $('lg-tutorial');
    const id = tut.steps[tut.step];
    const err = h('p', { class: 'err', hidden: true });
    const go = (n) => {
      tut.step = n;
      renderTutorial();
    };
    const button = (label, onClick, cls = null) => {
      const b = h('button', { type: 'button', class: cls }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    const link = (href, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'cta' }, label);
    const fail = (e) => {
      err.textContent = e.message;
      err.hidden = false;
    };
    let body;
    let next;
    if (id === 'nombre') {
      const input = h('input', { type: 'text', maxlength: 20, autocomplete: 'nickname', placeholder: 'Tu nombre o apodo', 'aria-label': 'Tu nombre en el juego' });
      body = [h('h3', { id: 'lt-h' }, '¿Cómo te llamas en el juego?'), h('p', {}, 'Es el nombre que verán los demás en el ranking.'), input];
      next = button(
        'Seguir →',
        async () => {
          try {
            state.forecasts = await api('/api/forecasts/name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: input.value }) });
            renderForecasts();
            await loadGames();
            go(tut.step + 1);
          } catch (e) {
            fail(e);
          }
        },
        'cta',
      );
    } else if (id === 'cuenta') {
      body = [
        h('h3', { id: 'lt-h' }, 'Crea tu cuenta gratis en Twelve Data'),
        h('p', {}, 'Es el proveedor de los precios de Rueda. Su plan gratis alcanza de sobra.'),
        link(TD_SIGNUP, 'Crear mi cuenta ↗'),
        h('p', { class: 'hint' }, 'Puedes entrar con Google o con Apple. Cuando termines, vuelve aquí.'),
      ];
      next = button('Ya la tengo →', () => go(tut.step + 1));
    } else if (id === 'clave') {
      body = [
        h('h3', { id: 'lt-h' }, 'Copia tu clave'),
        h('p', {}, 'En Twelve Data, abre «API keys» y copia tu clave: un código largo de letras y números.'),
        link(TD_KEYS, 'Abrir mis claves ↗'),
        h('p', { class: 'hint' }, 'Si te pide entrar, usa la misma cuenta.'),
      ];
      next = button('Ya la copié →', () => go(tut.step + 1));
    } else if (id === 'pegar') {
      const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Pega tu clave aquí', 'aria-label': 'Tu clave de Twelve Data' });
      const row = h('div', { class: 'tut-paste' }, input);
      if (navigator.clipboard?.readText) {
        row.append(
          button('Pegar', async () => {
            try {
              input.value = (await navigator.clipboard.readText()).trim();
            } catch {
              input.focus();
            }
          }),
        );
      }
      body = [
        h('h3', { id: 'lt-h' }, 'Pégala aquí'),
        row,
        h('p', { class: 'hint' }, 'Se guarda cifrada y solo se usa para traer tus precios: tu lista, tus gráficos y tu cartera de la liga. Puedes quitarla cuando quieras.'),
      ];
      next = button(
        'Conectar',
        async () => {
          try {
            state.games = await api('/api/games/liga', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'conectar', key: input.value }) });
            renderGames();
            go(tut.step + 1);
          } catch (e) {
            fail(e);
          }
        },
        'cta',
      );
    } else if (tut.from === 'panel') {
      const toPrices = () => {
        d.close();
        showSheet('acciones');
        $('watchlist').scrollIntoView({ block: 'start' });
      };
      body = [
        h('h3', { id: 'lt-h' }, '¡Listo! Ya ves tus precios'),
        h('p', {}, 'En «Acciones» tienes tu lista de seguimiento con precios, los gráficos de 5 años, comparar y el termómetro del S&P 500. Con «Editar» eliges tus símbolos (hasta 8).'),
        h('p', { class: 'hint' }, 'Con la misma clave ya estás en la liga de acciones: tienes US$ 10 000 para jugar cuando quieras, en la hoja «Juego».'),
      ];
      next = button('Ver mis precios', toPrices, 'cta');
    } else {
      const pick = (sym) => {
        d.close();
        $('league').scrollIntoView({ block: 'start' });
        const field = document.querySelector('#league .lg-sym');
        if (field && sym) {
          field.value = sym;
          field.dispatchEvent(new Event('input'));
          document.querySelector('#league input[aria-label="Cuántos dólares"]')?.focus();
        }
      };
      body = [
        h('h3', { id: 'lt-h' }, '¡Listo! Ya estás en la liga'),
        h('p', {}, 'Tienes US$ 10 000 para invertir. Las compras se cumplen al cierre de Nueva York, y cada quincena es una temporada: gana quien más rinde.'),
        h('p', { class: 'hint' }, 'Elige tu primera compra:'),
        h('div', { class: 'ranges lg-chips' }, ...(state.games?.liga.popular ?? []).map((s) => button(s, () => pick(s)))),
      ];
      next = button('Ir a mi cartera', () => pick(''), 'cta');
    }
    const counted = tut.steps.filter((s) => s !== 'listo');
    const n = counted.indexOf(id);
    const back = tut.step > 0 && id !== 'listo' ? button('← Atrás', () => go(tut.step - 1)) : h('span');
    d.replaceChildren(
      h('div', { class: 'tut-head' }, h('p', { class: 'tut-step' }, n >= 0 ? `Paso ${n + 1} de ${counted.length}` : tut.from === 'panel' ? 'Tu clave de Twelve Data' : 'Liga de acciones'), button('×', () => d.close(), 'tut-x')),
      ...body,
      err,
      h('div', { class: 'tut-nav' }, back, next),
    );
    d.querySelector('input')?.focus();
  }

  /** Tu cartera: cuánto vale, en qué está (barra), tus posiciones (con precios que solo ves tú) y lo que está en cola. */
  function leaguePortfolio(l, m, err) {
    const committed = committedOf(m);
    const free = Math.max(0, m.cash - committed);
    const out = h('div', { class: 'lg-card' }, h('p', { class: 'lg-k' }, 'Tu cartera'));
    out.append(h('p', { class: 'lg-worth' }, usdFmt(m.value), ' ', retSpan(m.retSeason), h('span', { class: 'muted' }, ' en la temporada')));
    if (m.lastValued) out.append(h('p', { class: 'hint lg-when' }, `Al cierre del ${calDay(m.lastValued)}`));
    if (m.error) out.append(h('p', { class: 'err' }, m.error));

    // Barra: las posiciones más grandes, lo que está en cola para comprar y lo que queda sin invertir.
    const held = m.holdings.filter((p) => p.value != null).sort((a, b) => b.value - a.value);
    const segs = held.slice(0, 4).map((p, i) => ({ label: p.symbol, v: p.value, cls: `c${i + 1}` }));
    const rest = held.slice(4).reduce((t, p) => t + p.value, 0);
    if (rest > 0) segs.push({ label: 'Otras', v: rest, cls: 'c0' });
    const queued = m.orders.filter((o) => o.kind === 'comprar' && o.usd);
    if (committed > 0) segs.push({ label: queued.length === 1 ? `${queued[0].symbol} en cola` : 'En cola', v: committed, cls: 'q' });
    if (free >= 1) segs.push({ label: 'Sin invertir', v: free, cls: 'cash' });
    const total = segs.reduce((t, x) => t + x.v, 0);
    if (total > 0 && segs.length > 1) {
      const bar = h('div', { class: 'lg-alloc', 'aria-hidden': 'true' });
      for (const x of segs) {
        const seg = h('i', { class: x.cls });
        seg.style.width = `${(100 * x.v) / total}%`;
        bar.append(seg);
      }
      out.append(bar, h('p', { class: 'lg-legend' }, ...segs.map((x) => h('span', {}, h('b', { class: x.cls }), `${x.label} ${nf(0).format((100 * x.v) / total)}%`))));
    }

    const list = h('ul', { class: 'lg-pos' });
    for (const p of m.holdings) {
      const sell = h('button', { type: 'button', class: 'linkish' }, 'Vender');
      sell.addEventListener('click', () => {
        if (window.confirm(`¿Vender todo tu ${p.symbol}? Se vende al próximo cierre de Nueva York.`)) sendGames('/api/games/liga', { action: 'vender', symbol: p.symbol }, err);
      });
      const nm = LG_NAMES[p.symbol] ?? (p.name && p.name !== p.symbol ? shortName(p.name, 28) : '');
      const sub = [nm, `${nf(p.shares < 100 ? 2 : 0).format(p.shares)} acciones`].filter(Boolean).join(' · ');
      list.append(h('li', {}, h('span', { class: 'nm' }, h('strong', { title: p.name }, p.symbol), h('small', {}, sub)), h('span', {}, p.value == null ? '—' : usdFmt(p.value)), retSpan(p.ret), sell));
    }
    const today = nyDate(new Date());
    for (const o of m.orders) {
      const cancel = h('button', { type: 'button', class: 'linkish' }, 'Cancelar');
      cancel.addEventListener('click', () => sendGames('/api/games/liga', { action: 'cancelar', cancel: o.id }, err));
      const when = o.session === today ? 'al cierre de hoy' : `al cierre del ${calDay(o.session)}`;
      const what = o.kind === 'comprar' ? `Compra de ${usdFmt(o.usd)}` : o.usd != null ? `Venta de ${usdFmt(o.usd)}` : 'Venta de todo';
      list.append(h('li', { class: 'queued' }, h('span', { class: 'nm' }, h('strong', {}, o.symbol), h('small', {}, what)), h('span', { class: 'lg-due' }, `⏱ ${when}`), h('span'), cancel));
    }
    out.append(list.childElementCount ? list : h('p', { class: 'hint' }, 'Todavía no compraste nada: elige tu primera acción en «Comprar».'));
    const foot = h('p', { class: 'hint' });
    if (m.spySeason != null) foot.append('El SPY en la temporada: ', retSpan(m.spySeason), '. ');
    foot.append('Solo tú ves tus montos y precios; el grupo ve porcentajes y símbolos.');
    out.append(foot);
    if (!m.appKey) {
      const off = h('button', { type: 'button', class: 'linkish' }, 'quitar mi clave');
      off.addEventListener('click', () => {
        if (window.confirm('¿Quitar tu clave de Twelve Data? Tu cartera queda guardada, pero deja de valorizarse hasta que conectes otra.')) {
          sendGames('/api/games/liga', { action: 'desconectar' }, err);
        }
      });
      out.append(h('p', { class: 'hint' }, 'Tu clave está guardada cifrada · ', off));
    }
    return out;
  }

  /** Comprar en dos pasos: qué (con nombres, no solo símbolos) y cuánto (con lo que te queda), y cuándo se cumple. */
  function leagueTicket(l, m, err) {
    const committed = committedOf(m);
    const free = Math.max(0, Math.floor(m.cash - committed));
    const symbol = h('input', {
      type: 'text', class: 'lg-sym', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 24, required: true,
      placeholder: 'Símbolo o nombre: AAPL, oro, Perú…', 'aria-label': 'Símbolo de la acción o ETF',
    });
    const usd = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, max: free >= 1 ? free : null, required: true, placeholder: '0', 'aria-label': 'Cuántos dólares' });
    const go = h('button', { type: 'submit', class: 'cta lg-buy' }, 'Comprar');
    // Un nombre conocido («oro», «apple») se cambia por su símbolo; si no, lo escrito es el símbolo.
    const resolve = () => {
      const t = foldTxt(symbol.value);
      const hit = Object.entries(LG_NAMES).find(([, n]) => foldTxt(n) === t || (t.length >= 3 && foldTxt(n).startsWith(t)));
      return (hit ? hit[0] : symbol.value.trim()).toUpperCase();
    };
    const chips = l.popular.map((sym) => {
      const b = h('button', { type: 'button', class: 'lg-chip', 'aria-pressed': 'false', 'data-sym': sym }, sym, LG_NAMES[sym] ? h('small', {}, LG_NAMES[sym]) : null);
      b.addEventListener('click', () => {
        symbol.value = sym;
        sync();
        usd.focus();
      });
      return b;
    });
    const quick = [...new Set([0.25, 0.5].map((f) => Math.floor((free * f) / 10) * 10))].filter((x) => x >= 10 && x < free);
    const amounts = quick.map((x) => {
      const b = h('button', { type: 'button', class: 'lg-chip' }, usdFmt(x));
      b.addEventListener('click', () => {
        usd.value = String(x);
        sync();
      });
      return b;
    });
    if (free >= 1) {
      const all = h('button', { type: 'button', class: 'lg-chip' }, 'Todo');
      all.addEventListener('click', () => {
        usd.value = String(free);
        sync();
      });
      amounts.push(all);
    }
    function sync() {
      const sym = resolve();
      for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.sym === sym));
      const n = Number(usd.value);
      go.textContent = sym && n >= 1 ? `Comprar ${sym} por ${usdFmt(n)}` : 'Comprar';
    }
    symbol.addEventListener('input', sync);
    usd.addEventListener('input', sync);
    const left = h('p', { class: 'hint' });
    if (free >= 1) left.append('Te quedan ', h('strong', {}, usdFmt(free)), ' para invertir', committed > 0 ? ' (ya descontadas tus compras en cola).' : '.');
    else left.append('No te queda efectivo: vende algo o cancela una compra en cola.');
    const form = h(
      'form',
      { class: 'lg-card lg-ticket' },
      h('p', { class: 'lg-k' }, 'Comprar'),
      h('p', { class: 'lg-step' }, h('span', { class: 'n' }, '1'), '¿Qué compras?'),
      symbol,
      h('div', { class: 'lg-chips', role: 'group', 'aria-label': 'Acciones y ETF conocidos' }, ...chips),
      h('p', { class: 'lg-step' }, h('span', { class: 'n' }, '2'), '¿Cuánto?'),
      h('div', { class: 'lg-amount' }, h('label', { class: 'lg-usd' }, h('span', {}, 'US$'), usd), ...amounts),
      left,
      go,
      h('p', { class: 'hint' }, 'Se compra con el cierre de Nueva York (16:00 allá): hoy, si das la orden antes; si no, el siguiente día hábil. Todos pagan el mismo precio de cierre.'),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendGames('/api/games/liga', { action: 'comprar', symbol: resolve(), usd: Number(usd.value) }, err);
    });
    return form;
  }

  // ---------- lista diaria ----------
  /** Fila de la lista diaria con cierre (null si no está o todavía no se cargó). */
  const eodRowFor = (sym) => state.eod?.rows.find((r) => r.symbol === sym && !r.pending) ?? null;

  async function loadEod() {
    try {
      state.eod = await api('/api/eod');
      renderEod();
    } catch (e) {
      $('eod-rows').replaceChildren(h('p', { class: 'err' }, e.message));
    }
  }

  /** Mismas columnas que la lista de seguimiento, con el último cierre y su fecha en vez del precio y la hora. */
  function renderEod() {
    const v = state.eod;
    if (!v) return;
    const host = $('eod-rows');
    $('eod-cols').hidden = !v.rows.length;
    if (!v.rows.length) {
      host.replaceChildren(h('p', { class: 'muted' }, 'Vacía. Con «Editar» agregas hasta 20 símbolos que se actualizan una vez al día.'));
      return;
    }
    const draws = [];
    host.replaceChildren(
      ...v.rows.map((r) => {
        const spark = h('span', { class: 'c-spark chart', 'aria-hidden': 'true' });
        const row = h('button', { type: 'button', class: r.pending ? 'row pending' : 'row', 'aria-pressed': String(state.selected === r.symbol) });
        if (r.pending) {
          row.append(
            h('span', { class: 'c-sym' }, r.symbol),
            h('span', { class: 'c-name' }, h('span', { class: 'c-name-text' }, 'Se carga en los próximos minutos')),
            h('span', { class: 'c-price' }, '—'),
            h('span', { class: 'c-chg flat' }, '—'),
            spark,
            h('span', { class: 'c-ret flat' }, ''),
            h('span', { class: 'c-time' }, ''),
          );
        } else {
          row.append(
            h('span', { class: 'c-sym' }, r.symbol),
            h('span', { class: 'c-name' }, h('span', { class: 'c-name-text' }, r.name ?? ''), h('span', { class: 'c-sigs' }, earningsChip(r.symbol))),
            h('span', { class: 'c-price' }, fmtPrice(r.close)),
            r.changePct == null ? h('span', { class: 'c-chg flat' }, '—') : changeEl({ price: r.close, change: r.change, changePct: r.changePct }),
            spark,
            h('span', { class: `c-ret ${r.ret1y == null ? 'flat' : trend(r.ret1y)}` }, r.ret1y != null ? pctFrac(r.ret1y) : ''),
            h('span', { class: 'c-time', title: `Cierre del ${fDayYear.format(day(r.date))}` }, fDay.format(day(r.date)).replace('.', '')),
          );
          if (r.spark.length > 1) draws.push(() => drawLine(spark, r.spark.map(([date, v]) => ({ date, v })), { axis: false, fmt: fmtPrice }));
        }
        row.addEventListener('click', () => select(r.symbol));
        return row;
      }),
    );
    // Los minigráficos miden su ancho: se dibujan ya en la página.
    for (const draw of draws) draw();
  }

  function openEodEditor(open) {
    $('eod-form').hidden = !open;
    $('eod-err').hidden = true;
    if (open) {
      const input = $('eod-input');
      input.value = (state.eod?.symbols ?? []).join(', ');
      input.focus();
    }
  }

  async function saveEod(e) {
    e.preventDefault();
    const symbols = $('eod-input').value.split(/[\s,;]+/).filter(Boolean);
    try {
      state.eod = await api('/api/eod', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }) });
      openEodEditor(false);
      if (state.selected && !inLists(state.selected) && !state.lookups.has(state.selected)) {
        state.selected = null;
        renderDetail();
      }
      renderEod();
      // Las fechas de resultados también salen de esta lista.
      loadCalendar();
    } catch (err) {
      const p = $('eod-err');
      p.textContent = err.message;
      p.hidden = false;
    }
  }

  // ---------- editar lista ----------
  function openEditor(open) {
    $('wl-form').hidden = !open;
    $('wl-err').hidden = true;
    if (open) {
      const input = $('wl-input');
      input.value = state.symbols.join(', ');
      input.focus();
    }
  }

  async function saveList(e) {
    e.preventDefault();
    const symbols = $('wl-input').value.split(/[\s,;]+/).filter(Boolean);
    try {
      await applyWatchlist(symbols, () => openEditor(false));
    } catch (err) {
      const p = $('wl-err');
      p.textContent = err.message;
      p.hidden = false;
    }
  }

  /** Guarda la lista de seguimiento (el editor o «Agregar a mi lista» de una buscada) y recarga lo que depende de ella. */
  async function applyWatchlist(symbols, onSaved) {
    const r = await api('/api/watchlist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    });
    state.symbols = r.symbols;
    // Lo de las buscadas queda: su ficha puede seguir abierta.
    for (const k of [...state.hist.keys()]) if (!state.symbols.includes(k) && !state.lookups.has(k)) state.hist.delete(k);
    if (state.selected && !inLists(state.selected) && !state.lookups.has(state.selected)) state.selected = null;
    onSaved?.();
    renderDetail();
    state.cmp.picks = state.cmp.picks.filter((p) => state.symbols.includes(p.sym));
    prefs.set('mercados.comparar', state.cmp);
    renderCompare();
    renderPortfolioForm();
    await loadQuotes(false);
    loadHistories().then(loadCompare);
    // Los resultados de empresas dependen de la lista.
    loadCalendar();
  }

  // ---------- buscador de acciones ----------
  // Pedido del usuario el 5 nov («una sección para poder buscar acciones específicas»): en la barra de arriba, en las dos
  // hojas. Las sugerencias son de la SEC (públicas, para todos). Abrir la ficha de una acción que no está en tus listas
  // cuesta unos 2 créditos de Twelve Data (precio e historial), con un tope de 20 nuevas al día por persona: el dueño con
  // la clave de Rueda y cada amigo con la suya (services/lookup.ts). Sin clave, un amigo ve sus resultados de la SEC.
  const RECENT_KEY = 'mercados.buscadas';
  const RECENT_MAX = 6;
  const SEARCH_DELAY_MS = 220;
  const search = {
    open: false,
    text: '', // lo escrito (sin espacios de más)
    items: [], // opciones a la vista: { symbol, name, direct? }
    active: -1, // la marcada con las flechas o el mouse
    head: null, // título sobre la lista («Recientes»)
    msg: null, // { text, err }
    timer: 0,
    seq: 0, // solo cuenta la respuesta del último pedido
    results: new Map(), // texto en minúsculas → sugerencias de la SEC (en esta visita)
    statusAsked: false,
  };
  const isPhone = () => matchMedia('(max-width:720px)').matches;

  /** Lo escrito como símbolo (AAPL, BRK.B, USD/PEN), si lo parece: se puede abrir tal cual, aunque la SEC no lo tenga. */
  function typedSymbol(text) {
    const s = text.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.-]{0,11}(\/[A-Z0-9]{2,10})?$/.test(s)) return null;
    return s.includes('/') || s.includes('.') || s.length <= 5 ? s : null;
  }

  const recentSearches = () => {
    const list = prefs.get(RECENT_KEY, []);
    return (Array.isArray(list) ? list : []).filter((r) => typeof r?.symbol === 'string').slice(0, RECENT_MAX);
  };
  function rememberSearch(item) {
    const list = recentSearches().filter((r) => r.symbol !== item.symbol);
    list.unshift({ symbol: item.symbol, name: item.name ?? null });
    prefs.set(RECENT_KEY, list.slice(0, RECENT_MAX));
  }
  /** Una que Twelve Data no tiene no queda entre las recientes. */
  const forgetSearch = (sym) => prefs.set(RECENT_KEY, recentSearches().filter((r) => r.symbol !== sym));

  function searchTag(sym) {
    if (state.symbols.includes(sym)) return { text: 'En tu lista', on: true };
    if (state.eod?.symbols?.includes(sym)) return { text: 'Lista diaria', on: true };
    if (hasPrices() && state.lookupStatus?.today?.includes(sym)) return { text: 'Abierta hoy' };
    return null;
  }

  function searchFoot() {
    if (!state.role) return '';
    if (!hasPrices()) return 'Sin tu clave de Twelve Data ves sus resultados de la SEC; con ella, su ficha completa.';
    const st = state.lookupStatus;
    const left = st ? ` · te quedan ${Math.max(0, st.max - st.used)} de ${st.max} hoy` : '';
    return `Abrir una que no está en tus listas usa unos 2 créditos${left}.`;
  }

  function renderSearch() {
    const input = $('search-input');
    const list = $('search-list');
    $('search-pop').hidden = !search.open;
    input.setAttribute('aria-expanded', String(search.open && search.items.length > 0));
    const head = $('search-head');
    head.hidden = !search.head;
    head.textContent = search.head ?? '';
    list.setAttribute('aria-label', search.head ?? 'Sugerencias');
    list.replaceChildren(
      ...search.items.map((it, i) => {
        const tag = it.direct ? { text: 'Abrir tal cual' } : searchTag(it.symbol);
        const li = h(
          'li',
          { role: 'option', id: `so-${i}`, 'aria-selected': String(i === search.active) },
          h('span', { class: 'so-sym' }, it.symbol),
          h('span', { class: 'so-name' }, it.name ?? (it.symbol.includes('/') ? 'Divisa o cripto' : 'Símbolo escrito')),
          tag ? h('span', { class: `so-tag${tag.on ? ' on' : ''}` }, tag.text) : null,
        );
        // Con el mouse, el foco queda en el campo (así no se cierra antes del clic).
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => pickSearch(it));
        li.addEventListener('mousemove', () => {
          if (search.active !== i) markSearch(i, false);
        });
        return li;
      }),
    );
    markSearch(search.active, false);
    const msg = $('search-msg');
    msg.hidden = !search.msg;
    msg.textContent = search.msg?.text ?? '';
    msg.className = search.msg?.err ? 'search-msg err' : 'search-msg';
    const foot = $('search-foot');
    foot.textContent = search.open ? searchFoot() : '';
    foot.hidden = !foot.textContent;
  }

  function markSearch(i, scroll = true) {
    search.active = i;
    const input = $('search-input');
    for (const li of $('search-list').children) li.setAttribute('aria-selected', String(li.id === `so-${i}`));
    if (i >= 0 && $(`so-${i}`)) {
      input.setAttribute('aria-activedescendant', `so-${i}`);
      if (scroll) $(`so-${i}`).scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  /** Lo que se ve al escribir: sin texto, las recientes; con texto, las sugerencias (de esta visita o de la SEC). */
  function updateSearch() {
    const text = $('search-input').value.replace(/\s+/g, ' ').trim();
    search.text = text;
    clearTimeout(search.timer);
    search.seq++;
    if (!text) {
      search.items = recentSearches();
      search.head = search.items.length ? 'Recientes' : null;
      search.msg = search.items.length ? null : { text: 'Escribe el nombre o el símbolo: Apple, NVDA, Credicorp. Divisas y cripto, como USD/PEN o BTC/USD.' };
      search.active = -1;
      renderSearch();
      return;
    }
    const known = search.results.get(text.toLowerCase());
    if (known) return showSuggestions(text, known);
    // Mientras llegan, lo escrito como símbolo ya se puede abrir con Enter.
    const direct = typedSymbol(text);
    search.items = direct ? [{ symbol: direct, name: null, direct: true }] : [];
    search.head = null;
    search.active = -1;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .,&'/-]{0,39}$/u.test(text)) {
      search.msg = { text: 'Usa solo letras, números y . , & \' / -', err: true };
      return renderSearch();
    }
    search.msg = { text: 'Buscando en la SEC…' };
    renderSearch();
    const seq = search.seq;
    search.timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(text)}`)
        .then((r) => {
          search.results.set(text.toLowerCase(), r.results);
          if (seq === search.seq) showSuggestions(text, r.results);
        })
        .catch((e) => {
          if (seq !== search.seq) return;
          search.msg = { text: e.message, err: true };
          renderSearch();
        });
    }, SEARCH_DELAY_MS);
  }

  function showSuggestions(text, results) {
    const items = results.map((m) => ({ symbol: m.symbol, name: m.name }));
    const direct = typedSymbol(text);
    // Lo escrito tal cual: primero si es un par (USD/PEN), al final si parece un ticker que la SEC no tiene (VOO).
    if (direct && !items.some((it) => it.symbol === direct) && (direct.includes('/') || !items.length || text === text.toUpperCase())) {
      const it = { symbol: direct, name: null, direct: true };
      if (direct.includes('/')) items.unshift(it);
      else items.push(it);
    }
    search.items = items;
    search.head = null;
    search.active = items.length ? 0 : -1;
    search.msg = items.length ? null : { text: `La SEC no tiene «${text}». Prueba con el símbolo (como VOO) o con otro nombre.` };
    $('search-live').textContent = items.length ? `${items.length} ${items.length === 1 ? 'sugerencia' : 'sugerencias'}` : 'Sin sugerencias';
    renderSearch();
  }

  function openSearch() {
    $('search').classList.add('open');
    $('search-toggle').setAttribute('aria-expanded', 'true');
    search.open = true;
    // Cuántas acciones nuevas quedan hoy: una vez por visita (cada ficha que se abre lo actualiza).
    if (hasPrices() && !search.statusAsked) {
      search.statusAsked = true;
      api('/api/lookup')
        .then((st) => {
          state.lookupStatus = st;
          if (search.open) renderSearch();
        })
        .catch(() => {
          search.statusAsked = false;
        });
    }
    updateSearch();
    $('search-input').focus();
  }

  /** Cierra las sugerencias (y, en el celular, el buscador). true si estaba abierto el del celular. */
  function closeSearch() {
    const wasPhone = $('search').classList.contains('open') && isPhone();
    search.open = false;
    search.active = -1;
    $('search').classList.remove('open');
    $('search-toggle').setAttribute('aria-expanded', 'false');
    renderSearch();
    return wasPhone;
  }

  function onSearchKey(e) {
    const n = search.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!search.open) return openSearch();
      if (n) markSearch(e.key === 'ArrowDown' ? (search.active + 1) % n : (search.active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = search.items[search.active] ?? search.items[0];
      if (it) pickSearch(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (search.open) {
        if (closeSearch()) $('search-toggle').focus();
      } else e.target.value = '';
    } else if (e.key === 'Tab') {
      closeSearch();
    }
  }

  function pickSearch(item) {
    rememberSearch(item);
    $('search-input').value = '';
    closeSearch();
    $('search-input').blur();
    openSearched(item.symbol, item.name ?? null);
  }

  /** Abre lo elegido: su ficha (de tus listas, o una nueva con su precio) o, sin precios, sus resultados de la SEC. */
  function openSearched(sym, name) {
    if (!hasPrices()) {
      // Divisas y cripto no están en la SEC: para sus precios hace falta la clave.
      if (sym.includes('/')) return openLeagueTutorial('panel');
      showSheet('acciones');
      $('fin-sym').value = sym;
      pickFin(sym);
      $('fin').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const l = state.lookups.get(sym);
    if (!inLists(sym) && (!l || (!l.quote && !l.pending))) loadLookup(sym, name);
    openDetail(sym);
    // Para el teclado y los lectores de pantalla, el foco va al título de la ficha.
    const title = $('d-title');
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }

  /** Anota la acción en el servidor y trae su precio (1 crédito; con la bolsa cerrada, una vez por sesión). */
  function loadLookup(sym, name = null, refresh = false) {
    const prev = state.lookups.get(sym);
    state.lookups.set(sym, { ...(prev?.quote ? prev : {}), pending: true, name: name ?? prev?.name ?? null });
    if (state.selected === sym) renderDetail();
    return api(`/api/lookup?symbol=${encodeURIComponent(sym)}${refresh ? '&refresh=1' : ''}`)
      .then((r) => {
        state.lookups.set(sym, { ...r, name: r.quote?.name ?? name ?? prev?.name ?? null });
        state.lookupStatus = r.lookups;
        if (!r.quote) forgetSearch(sym);
        if (r.credits && state.quotes) {
          state.quotes.credits = r.credits;
          renderFresh();
        }
      })
      .catch((e) => {
        // Si ya tenía precio, queda ese; si no, el error (y «Reintentar», salvo con el tope del día).
        if (prev?.quote) state.lookups.set(sym, { ...prev, pending: false, stale: true, note: e.message });
        else state.lookups.set(sym, { error: e.message, retry: e.code !== 'daily_limit', name: name ?? prev?.name ?? null });
      })
      .finally(() => {
        if (state.selected === sym) renderDetail();
      });
  }

  /** Dónde se puede sumar una buscada: la lista de seguimiento o, si está llena, la diaria (solo el dueño). */
  function addTarget() {
    if (state.symbols.length < state.max) return 'watchlist';
    if (state.role === 'owner' && state.eod && state.eod.symbols.length < state.eod.max) return 'eod';
    return null;
  }

  /** Fila de la ficha de una buscada: de dónde salió y cómo sumarla a tus listas. */
  function renderLook(sym) {
    const row = $('d-look');
    const l = state.lookups.get(sym);
    const text = $('d-look-text');
    const add = $('d-add');
    const retry = $('d-retry');
    text.className = 'd-look-text';
    add.hidden = true;
    retry.hidden = true;
    if (inLists(sym)) {
      const done = state.lookAdded?.sym === sym;
      row.hidden = !done;
      if (done) text.textContent = state.lookAdded.where === 'eod' ? '✓ Agregada a tu lista diaria.' : '✓ Agregada a tu lista de seguimiento.';
      return;
    }
    row.hidden = !l;
    if (!l) return;
    if (l.pending && !l.quote) {
      text.textContent = 'Buscando su precio…';
      return;
    }
    if (!l.quote) {
      // El error ya se ve en el gráfico: aquí solo «Reintentar», si sirve.
      text.textContent = '';
      retry.hidden = !l.retry;
      row.hidden = !l.retry;
      return;
    }
    text.textContent = l.stale && l.note ? `No está en tus listas · precio guardado (${l.note})` : 'No está en tus listas.';
    const target = addTarget();
    add.hidden = false;
    add.disabled = !target;
    add.textContent = target === 'eod' ? '+ Agregar a la lista diaria' : target ? '+ Agregar a mi lista' : `Tu lista está llena (${state.max} de ${state.max})`;
    add.title =
      target === 'eod'
        ? `Tu lista de seguimiento está llena (${state.max}): en la diaria se actualiza una vez al día, con el cierre.`
        : target
          ? 'La suma a tu lista de seguimiento, con su precio cada 10 minutos.'
          : 'Para sumarla, quita una con «Editar» en tu lista de seguimiento.';
  }

  async function addSearched(sym) {
    const where = addTarget();
    if (!sym || !where) return;
    const btn = $('d-add');
    btn.disabled = true;
    try {
      if (where === 'watchlist') await applyWatchlist([...state.symbols, sym]);
      else {
        state.eod = await api('/api/eod', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols: [...state.eod.symbols, sym] }) });
        renderEod();
        loadCalendar();
      }
      state.lookAdded = { sym, where };
      renderDetail();
    } catch (e) {
      const t = $('d-look-text');
      t.textContent = e.message;
      t.className = 'd-look-text err';
    } finally {
      btn.disabled = false;
    }
  }

  function setupSearch() {
    const box = $('search');
    const input = $('search-input');
    input.addEventListener('focus', () => {
      if (!search.open) openSearch();
    });
    input.addEventListener('input', () => {
      search.open = true;
      updateSearch();
    });
    input.addEventListener('keydown', onSearchKey);
    $('search-toggle').addEventListener('click', openSearch);
    $('search-close').addEventListener('click', () => {
      closeSearch();
      $('search-toggle').focus();
    });
    // Se cierra al tocar fuera (en el celular, también el fondo oscurecido) o al pasar con Tab a otra cosa.
    document.addEventListener('pointerdown', (e) => {
      if (search.open && (!box.contains(e.target) || e.target === box)) closeSearch();
    });
    box.addEventListener('focusout', (e) => {
      if (search.open && e.relatedTarget && !box.contains(e.relatedTarget)) closeSearch();
    });
    // «/» abre el buscador desde cualquier parte, salvo escribiendo en otro campo o con una ventana abierta.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      openSearch();
    });
  }

  const REPO = 'https://github.com/ElFabrix2344/app-mercados';
  /** Al pie: el commit publicado, para que cualquiera pueda revisar el código que corre en su navegador. */
  function renderVersion(sha) {
    const p = $('version');
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
    if (!sha) p.replaceChildren('Código público en ', link(REPO, 'GitHub'), '.');
    else p.replaceChildren('Versión publicada: ', link(`${REPO}/commit/${encodeURIComponent(sha)}`, sha.slice(0, 7)), ' (código público en GitHub).');
  }

  // ---------- hojas ----------
  // Por tema (5 nov, pedido del usuario: «que la UI sea lo más fácil de usar posible, en PC y celular»): «Hoy», «Acciones»
  // y «Mercados», más «Juego». La hoja va en la dirección (#acciones, #mercados, #juego), así se puede compartir, y se
  // recuerda en este equipo. Cada una recuerda hasta dónde bajaste.
  const SHEETS = ['hoy', 'acciones', 'mercados', 'juego'];
  const SHEET_PANEL = { hoy: 'sheet-hoy', acciones: 'sheet-acciones', mercados: 'sheet-mercados', juego: 'game' };
  const SHEET_KEY = 'mercados.hoja2';
  const sheetScroll = {}; // hoja → scrollY al dejarla
  const currentSheet = () => document.body.dataset.hoja || 'hoy';

  /** La de la última visita. Antes había dos, «mercados» (el panel entero) y «juego»: el panel ahora empieza en «Hoy». */
  function savedSheet() {
    const v = prefs.get(SHEET_KEY, null);
    if (SHEETS.includes(v)) return v;
    return prefs.get('mercados.hoja', null) === 'juego' ? 'juego' : 'hoy';
  }

  function showSheet(name, focus = false) {
    const sheet = SHEETS.includes(name) ? name : 'hoy';
    const prev = document.body.dataset.hoja;
    const changed = sheet !== prev;
    if (changed && prev) sheetScroll[prev] = scrollY;
    document.body.dataset.hoja = sheet;
    for (const s of SHEETS) {
      const tab = $(`tab-${s}`);
      tab.setAttribute('aria-selected', String(s === sheet));
      tab.tabIndex = s === sheet ? 0 : -1;
      $(SHEET_PANEL[s]).hidden = s !== sheet;
    }
    if (focus) $(`tab-${sheet}`).focus();
    prefs.set(SHEET_KEY, sheet);
    const hash = sheet === 'hoy' ? '' : `#${sheet}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash || location.pathname + location.search);
    if (!changed) return;
    fitColumns();
    // Los gráficos que se dibujaron con la hoja oculta quedan con el ancho de reserva: se rehacen al mostrarla.
    if (sheet !== 'juego') redrawCharts();
    // Al entrar a «Juego», lo último que jugaron los demás.
    if (sheet === 'juego' && state.games) loadGames();
    // Cada hoja vuelve a donde estabas (la primera vez, arriba). Con la ficha a pantalla completa, la hoja de abajo no se mueve.
    if (prev && !fichaFull()) window.scrollTo(0, sheetScroll[sheet] ?? 0);
  }

  function setupSheets() {
    for (const s of SHEETS) $(`tab-${s}`).addEventListener('click', () => showSheet(s));
    // Flechas entre pestañas, como en cualquier lista de pestañas.
    $('sheets').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = SHEETS.indexOf(currentSheet());
      showSheet(SHEETS[(i + (e.key === 'ArrowRight' ? 1 : SHEETS.length - 1)) % SHEETS.length], true);
      e.preventDefault();
    });
    // /#liga (el enlace que se manda al grupo): la hoja «Juego» con el tutorial de la liga, si todavía no entraste.
    const toLeague = () => {
      state.openTutorial = true;
      showSheet('juego');
      if (state.games) renderGames();
    };
    const fromHash = () => {
      const want = location.hash.slice(1);
      if (want === 'liga') toLeague();
      else showSheet(SHEETS.includes(want) ? want : 'hoy');
    };
    window.addEventListener('hashchange', fromHash);
    if (location.hash === '#liga' || SHEETS.includes(location.hash.slice(1))) fromHash();
    else showSheet(savedSheet());
    // Atrás en el teléfono con la ficha a pantalla completa: se cierra la ficha y no se sale de Rueda.
    window.addEventListener('popstate', () => {
      if (fichaFull()) closeDetail(true);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fichaFull() && !search.open && !document.querySelector('dialog[open]')) closeDetail();
    });
    // El aviso de la liga: entrar abre el tutorial; la × lo cierra para siempre en este equipo.
    $('lg-teaser-go').addEventListener('click', toLeague);
    $('lg-teaser-x').addEventListener('click', () => {
      prefs.set('mercados.liga-aviso', 'cerrado');
      $('lg-teaser').hidden = true;
    });
  }

  /**
   * En computadora, una columna sin nada a la vista se cierra (styles.css, .sin-left y .sin-right): un amigo sin clave no
   * ve el termómetro, y sin la clave de CoinGecko no hay cripto, por ejemplo. Se mira cada sección, no la columna.
   */
  function fitColumns() {
    for (const sheet of document.querySelectorAll('.cols.sheet')) {
      if (sheet.hidden) continue;
      for (const side of ['left', 'right']) {
        const col = sheet.querySelector(`:scope > .col-${side}`);
        const shown = !!col && [...col.children].some((el) => getComputedStyle(el).display !== 'none');
        sheet.classList.toggle(`sin-${side}`, !shown);
      }
    }
  }

  /** Las secciones aparecen y desaparecen según los datos y el rol: las columnas se rehacen al cambiar. */
  function watchColumns() {
    let queued = false;
    const later = () => {
      if (queued) return;
      queued = true;
      // Con un temporizador y no con requestAnimationFrame, que se detiene con la pestaña en segundo plano.
      setTimeout(() => {
        queued = false;
        fitColumns();
      }, 30);
    };
    const mo = new MutationObserver(later);
    for (const el of document.querySelectorAll('.cols.sheet > .col > *')) mo.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    fitColumns();
  }

  // ---------- secciones plegables ----------
  // Pedido del usuario el 5 nov: tocar el título de una sección la pliega o la abre, y queda así en este equipo.
  const FOLD_KEY = 'mercados.plegadas';
  /** Las que tienen su propio «Cerrar» o «Entendido», o son lo principal de su hoja. */
  const NO_FOLD = new Set(['detail', 'welcome', 'keycard', 'install-panel', 'league']);

  function setupFolds() {
    const saved = prefs.get(FOLD_KEY, []);
    const folded = new Set(Array.isArray(saved) ? saved : []);
    for (const sec of document.querySelectorAll('.hojas section.screen[id]')) {
      if (NO_FOLD.has(sec.id)) continue;
      const title = sec.querySelector(':scope > .screen-head h2');
      if (!title || title.querySelector('.fold')) continue;
      const btn = h('button', { type: 'button', class: 'fold' });
      btn.append(...title.childNodes);
      title.append(btn);
      const apply = (on) => {
        sec.classList.toggle('plegada', on);
        btn.setAttribute('aria-expanded', String(!on));
        btn.title = on ? 'Mostrar la sección' : 'Plegar la sección';
      };
      apply(folded.has(sec.id));
      btn.addEventListener('click', () => {
        const on = !sec.classList.contains('plegada');
        apply(on);
        if (on) folded.add(sec.id);
        else folded.delete(sec.id);
        prefs.set(FOLD_KEY, [...folded]);
        // Lo que se dibujó plegado quedó sin ancho.
        if (!on) redrawCharts();
      });
    }
  }

  // ---------- personas (solo el dueño) ----------
  // Quién puede entrar a Rueda. El servidor guarda cada cambio y lo copia a Cloudflare Access, que es quien manda el
  // código por correo. Sin el token de Access, el panel recuerda agregar el correo también allá.
  async function loadPeople() {
    try {
      state.people = await api('/api/people');
      renderPeople();
    } catch (e) {
      $('pp-list').replaceChildren(h('li', { class: 'err' }, e.message));
    }
  }

  /** Agrega, quita o vuelve a copiar a Access; el servidor responde la lista actualizada. */
  async function sendPeople(method, path, body, errEl) {
    if (state.peopleBusy) return false;
    state.peopleBusy = true;
    errEl.hidden = true;
    try {
      state.people = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      renderPeople();
      return true;
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
      return false;
    } finally {
      state.peopleBusy = false;
    }
  }

  const inviteText = (email) =>
    `Te agregué a Rueda: ${location.origin}\nEntra con ${email}. Te va a llegar un código de Cloudflare (revisa spam), que vale 10 minutos.`;

  /** En el celular abre «Compartir» (WhatsApp, etc.); en la computadora copia el mensaje. */
  async function invite(email, btn) {
    const text = inviteText(email);
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      const icon = btn.textContent;
      btn.textContent = 'Copiado';
      setTimeout(() => (btn.textContent = icon), 2000);
    } catch {
      window.prompt('Copia el mensaje:', text.replace('\n', ' '));
    }
  }

  function renderPeople() {
    const v = state.people;
    if (!v) return;
    $('pp-count').textContent = v.people.length ? String(v.people.length) : '';
    $('pp-list').replaceChildren(
      ...(v.people.length
        ? v.people.map((p) => {
            // Íconos (✉ invitar, × quitar): el texto repetido en cada fila no deja ver el correo en la columna angosta.
            const inv = h('button', { type: 'button', title: 'Invitar: copia el mensaje con el enlace', 'aria-label': `Invitar a ${p.email}` }, '✉︎');
            inv.addEventListener('click', () => invite(p.email, inv));
            const del = h('button', { type: 'button', class: 'pp-del', title: 'Quitar', 'aria-label': `Quitar a ${p.email}` }, '×');
            del.addEventListener('click', () => {
              if (window.confirm(`¿Quitar a ${p.email}? Ya no va a poder entrar a Rueda.`)) sendPeople('DELETE', '/api/people', { email: p.email }, $('pp-note'));
            });
            return h('li', { class: p.email === state.peopleNew ? 'pp-new' : null }, h('span', { class: 'pp-mail', title: p.email }, p.email), inv, del);
          })
        : [h('li', { class: 'muted' }, 'Todavía no agregaste a nadie.')]),
    );
    renderPeopleSync(v);
  }

  /** Una línea con el estado de Cloudflare Access: al día, falló (con «Reintentar») o sin conectar. */
  function renderPeopleSync(v) {
    const host = $('pp-sync');
    const s = v.sync;
    if (!v.access.connected) {
      const link = v.access.url ? h('a', { href: v.access.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir Access ↗') : '';
      host.replaceChildren('Cloudflare no está conectado: agrega cada correo también en Access. ', link);
      return;
    }
    const again = (label) => {
      const b = h('button', { type: 'button', class: 'linkish' }, label);
      b.addEventListener('click', () => sendPeople('POST', '/api/people/sync', {}, $('pp-note')));
      return b;
    };
    if (!s) host.replaceChildren('Falta copiar la lista a Cloudflare. ', again('Copiar ahora'));
    else if (!s.ok) host.replaceChildren(`Cloudflare no se actualizó: ${s.message} `, again('Reintentar'));
    else host.replaceChildren(h('span', { title: `Última copia: ${stamp(s.at)}` }, '✓ Al día con Cloudflare'), s.removed.length ? ` · se quitó de Access: ${s.removed.join(', ')}` : '');
  }

  function openPeopleForm(open) {
    $('pp-form').hidden = !open;
    $('pp-add').setAttribute('aria-expanded', String(open));
    $('pp-err').hidden = true;
    if (open) {
      $('pp-input').value = '';
      $('pp-input').focus();
    }
  }

  function setupPeople() {
    $('pp-add').addEventListener('click', () => openPeopleForm($('pp-form').hidden));
    $('pp-cancel').addEventListener('click', () => openPeopleForm(false));
    $('pp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      // Se marca antes de mandarlo: si ya estaba en la lista, queda marcado el que ya estaba.
      state.peopleNew = $('pp-input').value.trim().toLowerCase();
      if (await sendPeople('POST', '/api/people', { email: state.peopleNew }, $('pp-err'))) openPeopleForm(false);
      else renderPeople();
    });
    loadPeople();
  }

  // ---------- app instalable ----------
  // Rueda se instala desde el navegador, sin tienda de apps. Si Chrome o Edge ofrecen su diálogo de instalación, el
  // botón lo abre; si no (iPhone, iPad, Safari de Mac…), muestra los pasos. Abierta como app, el botón no aparece.
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /** Pasos para instalar según el equipo y el navegador: { steps: [[texto o nodo, …], …], note }. */
  function installGuide() {
    const ua = navigator.userAgent;
    const b = (t) => h('strong', {}, t);
    if (isIos())
      return {
        steps: [
          ['Abre ', b('Compartir'), ': el cuadrado con la flecha hacia arriba. En Safari de iOS 26 está dentro del botón ', b('⋯'), '.'],
          ['Elige ', b('Agregar a inicio'), '. Si no aparece, toca ', b('Ver más'), ' o baja en la lista.'],
          ['Deja activado ', b('Abrir como app web'), ' y toca ', b('Agregar'), '.'],
        ],
        note: 'La app no comparte la sesión con el navegador: la primera vez que la abras desde el ícono, entra con tu correo y el código, como siempre. Tu frase de Hapi también se pide una vez.',
      };
    if (/Android/.test(ua))
      return {
        steps: [
          ['Abre el menú del navegador: ', b('⋮'), ', arriba a la derecha.'],
          ['Elige ', b('Instalar app'), ' o ', b('Agregar a la pantalla principal'), ' y confirma.'],
        ],
        note: 'Queda junto a tus otras apps y se abre a pantalla completa, con la misma sesión del navegador.',
      };
    if (/Firefox\//.test(ua)) return { steps: [['Firefox no instala apps web en computadora: abre Rueda en Chrome, Edge o Safari y toca ', b('Instalar app'), ' ahí.']], note: '' };
    if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua))
      return {
        steps: [['En la barra de menús de Safari: ', b('Archivo'), ' → ', b('Agregar al Dock'), ' (macOS Sonoma o más nuevo).']],
        note: 'Se abre en su propia ventana. La primera vez puede pedirte entrar otra vez con tu correo y el código.',
      };
    return {
      steps: [['Toca el ícono de instalar al final de la barra de direcciones (una pantalla con una flecha), o busca ', b('Instalar'), ' en el menú del navegador.']],
      note: 'Se abre en su propia ventana, con la misma sesión del navegador.',
    };
  }

  function setupInstall() {
    // El service worker solo muestra un aviso sin conexión: no guarda nada ni toca los pedidos (public/sw.js).
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {}));
    if (isStandalone()) {
      $('welcome-install').hidden = true;
      return;
    }
    const btn = $('install-btn');
    const panel = $('install-panel');
    let offer = null; // diálogo de instalación de Chrome o Edge, si lo ofrecen (sirve una sola vez)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      offer = e;
    });
    const close = () => {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    window.addEventListener('appinstalled', () => {
      offer = null;
      close();
      btn.hidden = true;
    });
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      if (offer) {
        const o = offer;
        offer = null;
        o.prompt();
        await o.userChoice;
        return;
      }
      if (!panel.hidden) return close();
      const { steps, note } = installGuide();
      $('install-steps').replaceChildren(...steps.map((s) => h('li', {}, ...s)));
      $('install-note').textContent = note;
      $('install-note').hidden = !note;
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      panel.focus();
    });
    $('install-close').addEventListener('click', () => {
      close();
      btn.focus();
    });
  }

  // ---------- inicio ----------
  async function init() {
    renderClock();
    setupFolds();
    setupSheets();
    watchColumns();
    setupPeruFold();
    setupInstall();
    $('refresh-btn').addEventListener('click', () => {
      loadQuotes(true);
      const sym = state.selected;
      if (sym && state.lookups.get(sym)?.quote && !inLists(sym)) loadLookup(sym, null, true);
    });
    $('d-add').addEventListener('click', () => addSearched(state.selected));
    $('d-retry').addEventListener('click', () => state.selected && loadLookup(state.selected));
    setupSearch();
    $('edit-btn').addEventListener('click', () => openEditor($('wl-form').hidden));
    $('wl-cancel').addEventListener('click', () => openEditor(false));
    $('wl-form').addEventListener('submit', saveList);
    $('eod-edit').addEventListener('click', () => openEodEditor($('eod-form').hidden));
    $('eod-cancel').addEventListener('click', () => openEodEditor(false));
    $('eod-form').addEventListener('submit', saveEod);
    $('d-close').addEventListener('click', () => select(state.selected));
    $('d-season').addEventListener('toggle', renderSeason);
    $('d-strat').addEventListener('toggle', renderStrategy);
    $('d-strat-kind').addEventListener('change', renderStrategy);
    $('d-fin').addEventListener('toggle', renderDetailFin);
    $('d-ps').addEventListener('toggle', renderDetailPs);
    $('d-val').addEventListener('toggle', renderDetailVal);
    $('pf-xray').addEventListener('toggle', loadXray);
    $('pf-form').addEventListener('submit', submitTrade);
    $('tape-toggle').addEventListener('click', () => {
      prefs.set('mercados.cinta', tapeMoving() ? 'quieta' : 'mover');
      applyTapeMotion();
    });
    applyTapeMotion();
    $('news-more').addEventListener('click', () => {
      state.newsShown += 10;
      renderNews();
    });
    $('cal-more').addEventListener('click', () => {
      state.calAll = true;
      renderCalendar();
    });
    const savedGroup = prefs.get('mercados.noticias', 'todas');
    if (NEWS_GROUPS.some(([id]) => id === savedGroup)) state.newsGroup = savedGroup;
    // Noticias y resumen del día para todos (son públicos); el servidor renueva las noticias cada 30 minutos.
    loadNews();
    loadSummary();
    // Resultados de empresas (SEC) y el comparador por P/S: públicos, también para los amigos.
    setupFinSection();
    setupPsSection();
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadNews();
      loadSummary();
      loadPmk();
    }, 30 * 60_000);

    // Amigos: solo datos públicos (BCRP y FRED). El servidor igual les niega los precios de Twelve Data.
    let role = 'owner';
    const readStatus = async () => {
      const st = await api('/api/status');
      state.marketOpen = st.market?.open ?? null;
      renderVersion(st.version);
      renderMarket();
      return st;
    };
    try {
      const st = await readStatus();
      role = st.role ?? 'owner';
      state.birthday = st.birthday ?? null;
    } catch {
      /* si falla, sigue como dueño: las rutas protegidas responden con su propio error */
    }
    state.role = role;
    renderBirthday();
    $('cumple').addEventListener('click', confetti);
    // Lo que espera el mercado (Polymarket): para todos; el dueño, además, fija eventos.
    setupPmk();
    // Cuenta de Hapi: cada uno la suya, cifrada (también los amigos).
    setupHapi();
    if (role !== 'owner') {
      document.body.classList.add('rol-amigo');
      // La bienvenida se cierra con «Entendido» y, ya leída, no vuelve a ocupar la parte de arriba.
      $('welcome').hidden = prefs.get('mercados.bienvenida', null) === 'vista';
      $('welcome-close').addEventListener('click', () => {
        prefs.set('mercados.bienvenida', 'vista');
        $('welcome').hidden = true;
      });
      $('fresh').textContent = 'Datos públicos';
      $('kc-go').addEventListener('click', () => openLeagueTutorial('panel'));
      loadPeru();
      loadUsa();
      loadCurve();
      loadPeruMarkets();
      loadCrypto();
      loadCalendar();
      loadForecasts();
      loadGames();
      // Con su propia clave (la de la liga), su lista, sus precios y sus gráficos; sin ella, el aviso para conectarla.
      unlockPanel();
      setInterval(renderClock, 30_000);
      // Sin precios no hay pedidos periódicos: la rueda abre y cierra según el estado del servidor.
      setInterval(() => {
        if (!state.keyed) readStatus().catch(() => {});
      }, QUOTE_POLL_MS);
      return;
    }

    try {
      const w = await api('/api/watchlist');
      state.symbols = w.symbols;
      state.max = w.max;
    } catch (e) {
      setNote('watchlist', `Lista de seguimiento: ${e.message}`, 'crit');
    }
    loadEod();
    loadPeru();
    loadUsa();
    loadCurve();
    loadPeruMarkets();
    loadCrypto();
    loadCalendar();
    loadForecasts();
    loadGames();
    setupPeople();
    renderPortfolioForm();
    await startPrices();
  }

  // ---------- precios: el dueño con la clave de Rueda, un amigo con la suya ----------
  let pricesTimers = false;
  const hasPrices = () => state.role === 'owner' || state.keyed;

  /** Lista con precios, ficha, comparar y termómetro. Los pedidos periódicos se arman una sola vez. */
  async function startPrices() {
    const savedInd = prefs.get('mercados.indicadores', {});
    for (const k of Object.keys(state.ind)) state.ind[k] = savedInd?.[k] === true;
    state.cmp = cmpPrefs();
    renderTiles();
    loadThermometer();
    renderCompare();
    await loadQuotes(false);
    if (state.role === 'owner') loadPortfolio();
    // La comparación espera a los historiales de las filas: así sale de la caché y no choca con el límite por minuto.
    loadHistories().then(loadCompare);
    if (pricesTimers) return;
    pricesTimers = true;
    setInterval(() => {
      if (document.visibilityState === 'visible' && hasPrices()) loadQuotes(false);
    }, QUOTE_POLL_MS);
    setInterval(renderFresh, 30_000);
    document.addEventListener('visibilitychange', () => {
      const q = state.quotes;
      if (document.visibilityState === 'visible' && hasPrices() && q && Date.now() - Date.parse(q.fetchedAt) > QUOTE_POLL_MS) loadQuotes(false);
    });
  }

  // Un amigo ve sus precios si conectó su propia clave de Twelve Data (la misma de la liga): el servidor se los trae
  // con esa clave y los guarda aparte (game/panel.ts). Sin clave, /api/watchlist responde 403 y se muestra el aviso.
  let panelOpening = null;

  function unlockPanel() {
    panelOpening ??= openPanel().finally(() => {
      panelOpening = null;
    });
    return panelOpening;
  }

  async function openPanel() {
    let w;
    try {
      w = await api('/api/watchlist');
    } catch (e) {
      if (e.status !== 403) setNote('watchlist', `Lista de seguimiento: ${e.message}`, 'crit');
      $('keycard').hidden = false;
      return;
    }
    state.keyed = true;
    state.symbols = w.symbols;
    state.max = w.max;
    document.body.classList.add('con-clave');
    $('keycard').hidden = true;
    $('credits').title = 'Créditos de tu clave de Twelve Data que usó Rueda hoy (freno: 600 de 800)';
    await startPrices();
  }

  /** Quitó su clave en la liga: se cierran sus precios y se olvida lo que se veía (el servidor ya borró su caché). */
  function lockPanel() {
    if (fichaFull()) closeDetail();
    state.keyed = false;
    document.body.classList.remove('con-clave');
    state.symbols = [];
    state.quotes = null;
    state.selected = null;
    for (const m of [state.hist, state.rangeData, state.cmpData, state.full, state.symbolNews, state.lookups]) m.clear();
    state.lookupStatus = null;
    renderTiles();
    renderTape();
    renderDetail();
    $('fresh').textContent = 'Datos públicos';
    $('keycard').hidden = false;
  }

  /** Un amigo que conecta (o quita) su clave en la liga: se abren (o se cierran) sus precios en «Mercados». */
  function syncPanelKey(v) {
    if (state.role !== 'friend') return;
    const connected = !!v.liga?.me?.connected && !v.liga.me.appKey;
    if (connected && !state.keyed) unlockPanel();
    else if (!connected && state.keyed && !panelOpening) lockPanel();
  }

  init();
})();
