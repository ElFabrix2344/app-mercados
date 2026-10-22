'use strict';
// Mercados: panel sin framework. Todo el texto que viene de la API se pone con textContent.

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
    ind: { sma50: false, sma200: false, bb: false, rsi: false }, // indicadores visibles en la ficha
    cmp: { picks: [], range: '1A' }, // comparar: [{ sym, slot }] (el color sigue al símbolo) y rango
    cmpData: new Map(), // `${símbolos ordenados}|${rango}` → respuesta de /api/compare | 'cargando'
    cmpError: null, // { key, message } del último intento fallido
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

  /**
   * Gráfico de líneas sobre fechas comunes, con una o varias series.
   * spec.dates: ['YYYY-MM-DD', …]; spec.series: [{ name, values: [número | null], cls, tipLabel? }]: la primera es
   * la principal (va encima y su etiqueta tiene prioridad). Opcionales: band { upper, lower } (debajo de las líneas),
   * refs (valores con línea de referencia), domain [mín, máx] y ticks fijos, height, axis, xLabels, interactive, fmt,
   * dateFmt, axisDateFmt, aria, padR (número o función del ancho), endLabel(serie, valor, ancho) → texto | null,
   * extraTip(i) → filas extra del tooltip, sortTip (filas del tooltip de mayor a menor), flat (sin serie principal).
   */
  function drawChart(host, spec) {
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
    if (spec.band) {
      spec.band.upper.forEach(take);
      spec.band.lower.forEach(take);
    }
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
    const X = (i) => pad.l + (i * iw) / (n - 1);
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
      if (spec.xLabels !== false) {
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
    if (spec.band) {
      const { upper, lower } = spec.band;
      svg.append(
        s('path', { class: 'band', d: bandPath(upper, lower, xy) }),
        s('path', { class: 'band-edge', d: linePath(upper, xy) }),
        s('path', { class: 'band-edge', d: linePath(lower, xy) }),
      );
    }
    // La serie principal se dibuja al final para quedar encima.
    const drawOrder = [...series.slice(1), series[0]];
    for (const sr of drawOrder) svg.append(s('path', { class: `line ${sr.cls || ''}`, d: linePath(sr.values, xy) }));
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
    if (spec.interactive) attachHover(svg, spec, { W, H, pad, X, Y });
  }

  /** Una sola serie (minigráficos, Perú, EE. UU.). pts: [{ date: 'YYYY-MM-DD', v: número }]. */
  function drawLine(host, pts, opts) {
    drawChart(host, { ...opts, dates: pts.map((p) => p.date), series: [{ name: '', values: pts.map((p) => p.v), cls: opts.cls }] });
  }

  /** Una serie: el valor y la fecha. Varias: la fecha y una fila por serie, con el valor primero y su clave de color. */
  function tipContent(spec, i) {
    const date = (spec.dateFmt || fDayYear).format(day(spec.dates[i]));
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
      ...rows.map((r) => h('span', { class: `tt-row ${r.cls || ''}` }, h('span', { class: `key ${r.keyCls || ''}` }), h('strong', {}, r.value), r.label)),
    ];
  }

  function attachHover(svg, spec, { W, H, pad, X, Y }) {
    const n = spec.dates.length;
    svg.setAttribute('tabindex', '0');
    const cross = s('line', { class: 'cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dots = spec.series.map((sr) => s('circle', { class: `hover-dot ${sr.cls || ''}`, r: 4, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const tip = $('tooltip');
    let idx = -1;
    const show = (i) => {
      idx = Math.max(0, Math.min(n - 1, i));
      const x = X(idx);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      let top = H - pad.b;
      spec.series.forEach((sr, k) => {
        const v = sr.values[idx];
        if (v == null) {
          dots[k].setAttribute('visibility', 'hidden');
          return;
        }
        dots[k].setAttribute('cx', x);
        dots[k].setAttribute('cy', Y(v));
        dots[k].setAttribute('visibility', 'visible');
        top = Math.min(top, Y(v));
      });
      tip.replaceChildren(...tipContent(spec, idx));
      tip.hidden = false;
      const r = svg.getBoundingClientRect();
      const sx = r.width / W;
      let left = r.left + x * sx + 12;
      if (left + tip.offsetWidth > window.innerWidth - 8) left = r.left + x * sx - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, r.top + top * sx - tip.offsetHeight - 10)}px`;
    };
    const hide = () => {
      idx = -1;
      cross.setAttribute('visibility', 'hidden');
      for (const d of dots) d.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    const fromPointer = (e) => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) * (W / r.width);
      show(Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (n - 1)));
    };
    svg.addEventListener('pointermove', fromPointer);
    svg.addEventListener('pointerdown', fromPointer);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('focus', () => show(n - 1));
    svg.addEventListener('keydown', (e) => {
      const keys = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: n - 1 };
      if (e.key in keys) {
        show(keys[e.key]);
        e.preventDefault();
      } else if (e.key === 'Escape') hide();
    });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const [host, spec] of charts) {
        if (host.isConnected && !host.closest('[hidden]')) drawChart(host, spec);
        else if (!host.isConnected) charts.delete(host);
      }
    }, 150);
  });

  // ---------- lista de seguimiento ----------
  function quoteFor(sym) {
    return state.quotes?.data?.quotes?.find((q) => q.symbol === sym) ?? null;
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
        h('span', { class: 'c-name' }, q?.name ?? (err ? `Sin dato: ${err}` : state.quotes ? 'Sin dato' : 'Cargando…')),
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

  /** Estado de la bolsa de Nueva York según el servidor (el mismo criterio con el que decide qué renovar). */
  function renderMarket() {
    const el = $('mkt');
    const m = state.quotes?.market;
    el.textContent = m ? (m.open ? 'NYSE abierto' : 'NYSE cerrado · acciones al cierre') : '';
    el.className = m?.open ? 'mkt open' : 'mkt';
  }

  function renderClock() {
    $('today').textContent = `${fClock.format(new Date()).replace(/\./g, '')} Lima`;
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
      setNote('quotes', state.quotes.stale && state.quotes.note ? `Precios guardados: ${state.quotes.note}` : null);
      setNote('mock', state.quotes.note === 'Datos de prueba' ? 'Datos de prueba: no son precios reales.' : null);
    } catch (e) {
      setNote('quotes', `Precios: ${e.message}`, 'crit');
    } finally {
      btn.disabled = false;
    }
    renderTiles();
    renderFresh();
    if (state.selected) renderDetail();
  }

  async function loadHistories() {
    if (state.histBusy) return;
    state.histBusy = true;
    let waiting = false;
    for (const sym of state.symbols) {
      if (state.hist.has(sym)) continue;
      try {
        const r = await api(`/api/history?symbol=${encodeURIComponent(sym)}`);
        state.hist.set(sym, { points: r.data.points, stats: r.stats });
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
  function select(sym) {
    state.selected = state.selected === sym ? null : sym;
    renderTiles();
    renderDetail();
    if (state.selected) $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      state.rangeData.set(key, 'cargando');
      api(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&ind=1`)
        .then((r) => state.rangeData.set(key, { points: r.data.points, stats: r.stats, ind: r.indicators }))
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

  // Colores validados para daltonismo sobre el panel: precio s1, MM50 s4, MM200 s2 (todas las parejas) y RSI s3 aparte.
  const INDICATORS = [
    { key: 'sma50', label: 'MM50', cls: 's4', title: 'Media móvil simple de 50 días' },
    { key: 'sma200', label: 'MM200', cls: 's2', title: 'Media móvil simple de 200 días' },
    { key: 'bb', label: 'Bollinger', cls: '', title: 'Bandas de Bollinger: media de 20 días ± 2 desviaciones estándar' },
    { key: 'rsi', label: 'RSI 14', cls: 's3', title: 'Índice de fuerza relativa de 14 días (panel debajo del gráfico)' },
  ];

  /** Leyenda de la ficha: «Cierre» fijo y un botón por indicador (su clave de color es la de la línea). */
  function renderIndicatorToggles() {
    $('d-ind').replaceChildren(
      h('span', { class: 'legend-item s1' }, h('span', { class: 'key' }), 'Cierre'),
      ...INDICATORS.map((it) => {
        const b = h(
          'button',
          { type: 'button', class: `tog ${it.cls}`, 'aria-pressed': String(!!state.ind[it.key]), title: it.title },
          h('span', { class: it.key === 'bb' ? 'key band' : 'key' }),
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
    renderRanges();
    renderIndicatorToggles();
    const q = quoteFor(sym);
    const hist = detailHistory(sym, state.range);
    $('d-title').textContent = q?.name ? `${sym} · ${q.name}` : sym;
    $('d-sub').textContent = q ? [q.exchange, q.currency].filter(Boolean).join(' · ') : '';
    const chart = $('d-chart');
    const rsiWrap = $('d-rsi-wrap');
    const rsiHost = $('d-rsi');
    const stats = $('d-stats');
    const tbody = $('d-table').tBodies[0];
    const csvBtn = $('d-csv');
    csvBtn.disabled = !hist?.points;
    // Mientras llega otro rango queda el gráfico anterior, atenuado: sin saltos ni parpadeos.
    sec.classList.toggle('is-loading', !hist && chart.childElementCount > 0);
    if (!hist) {
      if (!chart.childElementCount) chart.replaceChildren(h('p', { class: 'muted' }, 'Cargando historial…'));
      return;
    }
    stats.replaceChildren();
    tbody.replaceChildren();
    if (hist.error) {
      charts.delete(chart);
      charts.delete(rsiHost);
      rsiWrap.hidden = true;
      chart.replaceChildren(h('p', { class: 'err' }, hist.error));
      return;
    }
    const dates = hist.points.map(([date]) => date);
    const pts = hist.points.map(([date, v]) => ({ date, v }));
    const ind = hist.ind; // falta mientras llegan los indicadores
    const on = (k) => !!(ind && state.ind[k]);
    const series = [{ name: 'Cierre', values: pts.map((p) => p.v), cls: 's1' }];
    if (on('sma50')) series.push({ name: 'MM50', values: ind.sma50, cls: 's4' });
    if (on('sma200')) series.push({ name: 'MM200', values: ind.sma200, cls: 's2' });
    const extras = [on('sma50') && 'la media de 50 días', on('sma200') && 'la media de 200 días', on('bb') && 'las bandas de Bollinger'].filter(Boolean);
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
      extraTip:
        on('bb') || on('rsi')
          ? (i) => [
              ...(on('bb') && ind.bbUpper[i] != null
                ? [{ keyCls: 'band', value: `${fmtPrice(ind.bbLower[i])} – ${fmtPrice(ind.bbUpper[i])}`, label: 'Bollinger' }]
                : []),
              ...(on('rsi') && ind.rsi14[i] != null ? [{ cls: 's3', value: nf(1).format(ind.rsi14[i]), label: 'RSI 14' }] : []),
            ]
          : null,
    });
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
        fmt: (v) => nf(1).format(v),
        endLabel: (sr, v) => nf(0).format(v),
        aria: `RSI de 14 días de ${sym} en ${RANGE_NAMES[state.range]}`,
      });
    } else {
      charts.delete(rsiHost);
    }
    csvBtn.onclick = () => {
      const header = ['fecha', 'cierre', 'rendimiento_diario'];
      if (ind) header.push('mm50', 'mm200', 'bollinger_sup', 'bollinger_inf', 'rsi14');
      const rows = hist.points.map(([date, close], i) => {
        const row = [date, close, i ? round6(close / hist.points[i - 1][1] - 1) : ''];
        if (ind) row.push(ind.sma50[i], ind.sma200[i], ind.bbUpper[i], ind.bbLower[i], ind.rsi14[i]);
        return row;
      });
      downloadCsv(`${sym.replace('/', '-')}_${state.range}_${today()}.csv`, header, rows);
    };

    const st = hist.stats;
    if (st) {
      stats.append(
        stat('Rendimiento en el periodo', pctFrac(st.totalReturn), `${fDayYear.format(day(st.from))} → ${fDayYear.format(day(st.to))}`),
        stat('Volatilidad anualizada', st.annualVol != null ? pctFrac(st.annualVol).replace('+', '') : '—', 'Desviación de los rendimientos diarios'),
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
    const message = (cls, text) => {
      charts.delete(chart);
      chart.replaceChildren(h('p', { class: cls }, text));
      grid.hidden = true;
      note.textContent = '';
      csv.disabled = true;
    };
    if (picks.length < 2) return message('muted', `Elige de 2 a ${CMP_MAX} símbolos de tu lista para compararlos.`);
    if (state.cmpError?.key === key) return message('err', state.cmpError.message);
    if (!ready) {
      if (!chart.childElementCount) chart.replaceChildren(h('p', { class: 'muted' }, 'Cargando comparación…'));
      return;
    }
    const n = data.dates.length;
    if (n < 2) return message('muted', 'No hay suficientes días en común para comparar en este periodo.');

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
      `${n} días en común, del ${fDayYear.format(day(data.dates[0]))} al ${fDayYear.format(day(data.dates[n - 1]))}: ` +
      `solo cuentan los días en que todos cotizan. ${data.stale ? 'Dato guardado' : 'Actualizado'} ${ago(data.fetchedAt)}.` +
      (errs.length ? ` No se pudo cargar ${listJoin(errs)}.` : '');
    csv.onclick = () => {
      const syms = series.map((x) => x.name);
      const header = ['fecha', ...syms.map((sym) => `${sym}_cierre`), ...syms.map((sym) => `${sym}_base100`)];
      const rows = data.dates.map((d, i) => [d, ...series.map((x) => x.src.closes[i]), ...series.map((x) => x.src.rebased[i])]);
      downloadCsv(`comparar_${syms.map((sym) => sym.replace('/', '-')).join('_')}_${data.range}_${today()}.csv`, header, rows);
    };
  }

  // ---------- Perú / EE. UU. ----------
  function metric(label, value, sub) {
    return h('div', { class: 'metric' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), sub ? h('span', { class: 'sub' }, sub) : null);
  }

  /** Gráfico pequeño con su título y, si se da `csv`, un botón para descargar sus datos. */
  function chartBlock(title, pts, opts, csv) {
    const host = h('div', { class: 'chart' });
    const head = h('div', { class: 'chart-head' }, h('p', { class: 'hint' }, title));
    if (csv) {
      const b = h('button', { type: 'button', class: 'csv-btn', title: `Descargar ${csv.filename}` }, '⤓ CSV');
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
      const { fx, policyRate, inflation } = r.data;
      const lastFx = fx.at(-1);
      const lastInf = inflation.at(-1);
      const row = h('div', { class: 'metric-row' });
      if (lastFx) row.append(metric('Dólar interbancario (venta)', nf(4).format(lastFx.sell), `Compra ${nf(4).format(lastFx.buy)} · ${fDay.format(day(lastFx.date))}`));
      if (policyRate) row.append(metric('Tasa de referencia', rate(policyRate.value), fDay.format(day(policyRate.date))));
      if (lastInf) row.append(metric('Inflación 12 meses (Lima)', rate(lastInf.value), fMonthYear.format(day(lastInf.date))));
      const parts = [row];
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
        { fmt: (v) => rate(v), dateFmt: fMonthYear, aria: 'Inflación a 12 meses en Lima Metropolitana, mensual' },
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
        { fmt: (v) => rate(v), axisDateFmt: fDay, aria: 'Rendimiento del bono del Tesoro a 10 años, últimos 60 días hábiles' },
        { filename: `fred_bono_10_anios_${today()}.csv`, header: ['fecha', 'rendimiento_pct'], rows: treasury10y.map((p) => [p.date, p.value]) },
      );
      const cChart = chartBlock(
        'Inflación anual de EE. UU., por mes',
        cpiYoY.map((p) => ({ date: p.date, v: p.value })),
        { fmt: (v) => rate(v, 1), dateFmt: fMonthYear, aria: 'Inflación anual de Estados Unidos, mensual' },
        { filename: `fred_inflacion_eeuu_${today()}.csv`, header: ['mes', 'inflacion_anual_pct'], rows: cpiYoY.map((p) => [p.date.slice(0, 7), round6(p.value)]) },
      );
      host.replaceChildren(row, tChart.wrap, cChart.wrap, ...[staleHint(r)].filter(Boolean));
      tChart.draw();
      cChart.draw();
    } catch (e) {
      host.replaceChildren(h('p', { class: 'err' }, e.message));
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
      const r = await api('/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      state.symbols = r.symbols;
      for (const k of [...state.hist.keys()]) if (!state.symbols.includes(k)) state.hist.delete(k);
      if (state.selected && !state.symbols.includes(state.selected)) state.selected = null;
      openEditor(false);
      renderDetail();
      state.cmp.picks = state.cmp.picks.filter((p) => state.symbols.includes(p.sym));
      prefs.set('mercados.comparar', state.cmp);
      renderCompare();
      await loadQuotes(false);
      loadHistories().then(loadCompare);
    } catch (err) {
      const p = $('wl-err');
      p.textContent = err.message;
      p.hidden = false;
    }
  }

  // ---------- inicio ----------
  async function init() {
    renderClock();
    $('refresh-btn').addEventListener('click', () => loadQuotes(true));
    $('edit-btn').addEventListener('click', () => openEditor($('wl-form').hidden));
    $('wl-cancel').addEventListener('click', () => openEditor(false));
    $('wl-form').addEventListener('submit', saveList);
    $('d-close').addEventListener('click', () => select(state.selected));

    // Amigos: solo datos públicos (BCRP y FRED). El servidor igual les niega los precios de Twelve Data.
    let role = 'owner';
    try {
      role = (await api('/api/status')).role ?? 'owner';
    } catch {
      /* si falla, sigue como dueño: las rutas protegidas responden con su propio error */
    }
    if (role !== 'owner') {
      document.body.classList.add('rol-amigo');
      $('fresh').textContent = 'Datos públicos';
      loadPeru();
      loadUsa();
      setInterval(renderClock, 30_000);
      return;
    }

    try {
      const w = await api('/api/watchlist');
      state.symbols = w.symbols;
      state.max = w.max;
    } catch (e) {
      setNote('watchlist', `Lista de seguimiento: ${e.message}`, 'crit');
    }
    const savedInd = prefs.get('mercados.indicadores', {});
    for (const k of Object.keys(state.ind)) state.ind[k] = savedInd?.[k] === true;
    state.cmp = cmpPrefs();
    renderTiles();
    renderCompare();
    loadPeru();
    loadUsa();
    await loadQuotes(false);
    // La comparación espera a los historiales de las filas: así sale de la caché y no choca con el límite por minuto.
    loadHistories().then(loadCompare);

    setInterval(() => {
      if (document.visibilityState === 'visible') loadQuotes(false);
    }, QUOTE_POLL_MS);
    setInterval(renderFresh, 30_000);
    document.addEventListener('visibilitychange', () => {
      const q = state.quotes;
      if (document.visibilityState === 'visible' && q && Date.now() - Date.parse(q.fetchedAt) > QUOTE_POLL_MS) loadQuotes(false);
    });
  }

  init();
})();
