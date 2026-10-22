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
    hist: new Map(), // símbolo → { points, stats } | { error }
    histBusy: false,
    selected: null,
    notes: new Map(), // clave → { text, kind }
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

  /**
   * Línea de una sola serie. pts: [{ date: 'YYYY-MM-DD', v: número }].
   * opts: { height, axis, fmt, dateFmt, aria, interactive }
   */
  function drawLine(host, pts, opts) {
    charts.set(host, [pts, opts]);
    host.replaceChildren();
    if (pts.length < 2) {
      host.append(h('p', { class: 'muted' }, 'Sin datos suficientes.'));
      return;
    }
    const W = Math.max(opts.axis ? 160 : 40, Math.round(host.clientWidth || 300));
    // Sin altura fija (minigráficos) se usa la del contenedor, que cambia en el celular.
    const H = opts.height || host.clientHeight || 28;
    const pad = opts.axis ? { l: 48, r: 76, t: 12, b: 24 } : { l: 2, r: 4, t: 4, b: 4 };
    const n = pts.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    if (lo === hi) {
      const d = Math.abs(lo) * 0.01 || 1;
      lo -= d;
      hi += d;
    }
    let ticks = [];
    let tickFmt = (v) => String(v);
    if (opts.axis) {
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

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.aria || '' });
    if (opts.axis) {
      for (const t of ticks) {
        svg.append(s('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
        const label = s('text', { class: 'tick', x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end' });
        label.textContent = tickFmt(t);
        svg.append(label);
      }
      const idxs = [...new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1])];
      for (const i of idxs) {
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        const label = s('text', { class: 'tick', x: X(i), y: H - 6, 'text-anchor': anchor });
        label.textContent = (opts.axisDateFmt || fAxisMonth).format(day(pts[i].date));
        svg.append(label);
      }
    }
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    svg.append(s('path', { class: 'line', d }));
    const last = pts[n - 1];
    svg.append(s('circle', { class: 'end-dot', cx: X(n - 1), cy: Y(last.v), r: opts.axis ? 4 : 2.5 }));
    if (opts.axis) {
      const label = s('text', { class: 'end-label', x: X(n - 1) + 8, y: Y(last.v) + 4 });
      label.textContent = opts.fmt(last.v);
      svg.append(label);
    }
    host.append(svg);
    if (opts.interactive) attachHover(svg, pts, { W, H, pad, X, Y, opts });
  }

  function attachHover(svg, pts, { W, H, pad, X, Y, opts }) {
    const n = pts.length;
    svg.setAttribute('tabindex', '0');
    const cross = s('line', { class: 'cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dot = s('circle', { class: 'hover-dot', r: 4, visibility: 'hidden' });
    svg.append(cross, dot);
    const tip = $('tooltip');
    let idx = -1;
    const show = (i) => {
      idx = Math.max(0, Math.min(n - 1, i));
      const p = pts[idx];
      const x = X(idx);
      const y = Y(p.v);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('strong', {}, opts.fmt(p.v)), (opts.dateFmt || fDayYear).format(day(p.date)));
      tip.hidden = false;
      const r = svg.getBoundingClientRect();
      const sx = r.width / W;
      let left = r.left + x * sx + 12;
      if (left + tip.offsetWidth > window.innerWidth - 8) left = r.left + x * sx - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, r.top + y * sx - tip.offsetHeight - 10)}px`;
    };
    const hide = () => {
      idx = -1;
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
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
      for (const [host, [pts, opts]] of charts) {
        if (host.isConnected) drawLine(host, pts, opts);
        else charts.delete(host);
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

  function renderDetail() {
    const sym = state.selected;
    const sec = $('detail');
    if (!sym) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    const q = quoteFor(sym);
    const hist = state.hist.get(sym);
    $('d-title').textContent = q?.name ? `${sym} · ${q.name}` : sym;
    $('d-sub').textContent = q ? [q.exchange, q.currency].filter(Boolean).join(' · ') : '';
    const chart = $('d-chart');
    const stats = $('d-stats');
    const tbody = $('d-table').tBodies[0];
    stats.replaceChildren();
    tbody.replaceChildren();
    if (!hist) {
      charts.delete(chart);
      chart.replaceChildren(h('p', { class: 'muted' }, 'Cargando historial…'));
      return;
    }
    if (hist.error) {
      charts.delete(chart);
      chart.replaceChildren(h('p', { class: 'err' }, hist.error));
      return;
    }
    const pts = hist.points.map(([date, v]) => ({ date, v }));
    drawLine(chart, pts, { height: 260, axis: true, interactive: true, fmt: fmtPrice, aria: `Cierre diario de ${sym} en el último año` });

    const st = hist.stats;
    if (st) {
      stats.append(
        stat('Rendimiento en el periodo', pctFrac(st.totalReturn), `${fDayYear.format(day(st.from))} → ${fDayYear.format(day(st.to))}`),
        stat('Volatilidad anualizada', st.annualVol != null ? pctFrac(st.annualVol).replace('+', '') : '—', 'Desviación de los rendimientos diarios'),
        stat(
          'Mayor caída desde un pico',
          st.maxDrawdown ? pctFrac(st.maxDrawdown.value) : 'Sin caídas',
          st.maxDrawdown ? `${fDay.format(day(st.maxDrawdown.peakDate))} → ${fDay.format(day(st.maxDrawdown.troughDate))}` : null,
        ),
        stat('Peor día', st.worstDay ? pctFrac(st.worstDay.ret) : '—', st.worstDay ? fDayYear.format(day(st.worstDay.date)) : null),
        stat('Mejor día', st.bestDay ? pctFrac(st.bestDay.ret) : '—', st.bestDay ? fDayYear.format(day(st.bestDay.date)) : null),
        stat('Cierre máximo', fmtPrice(st.maxClose.value), fDayYear.format(day(st.maxClose.date))),
        stat('Cierre mínimo', fmtPrice(st.minClose.value), fDayYear.format(day(st.minClose.date))),
      );
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

  // ---------- Perú / EE. UU. ----------
  function metric(label, value, sub) {
    return h('div', { class: 'metric' }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), sub ? h('span', { class: 'sub' }, sub) : null);
  }

  function chartBlock(title, pts, opts) {
    const host = h('div', { class: 'chart' });
    const wrap = h('div', {}, h('p', { class: 'hint' }, title), host);
    return { wrap, draw: () => drawLine(host, pts, { height: 140, axis: true, interactive: true, ...opts }) };
  }

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
      const fxChart = chartBlock('Dólar interbancario (venta), últimos 30 días hábiles', fx.map((p) => ({ date: p.date, v: p.sell })), {
        fmt: (v) => nf(4).format(v),
        axisDateFmt: fDay,
        aria: 'Tipo de cambio interbancario de venta, últimos 30 días hábiles',
      });
      const infChart = chartBlock('Inflación 12 meses en Lima, por mes', inflation.map((p) => ({ date: p.date, v: p.value })), {
        fmt: (v) => rate(v),
        dateFmt: fMonthYear,
        aria: 'Inflación a 12 meses en Lima Metropolitana, mensual',
      });
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
      const tChart = chartBlock('Rendimiento del bono a 10 años, últimos 60 días hábiles', treasury10y.map((p) => ({ date: p.date, v: p.value })), {
        fmt: (v) => rate(v),
        axisDateFmt: fDay,
        aria: 'Rendimiento del bono del Tesoro a 10 años, últimos 60 días hábiles',
      });
      const cChart = chartBlock('Inflación anual de EE. UU., por mes', cpiYoY.map((p) => ({ date: p.date, v: p.value })), {
        fmt: (v) => rate(v, 1),
        dateFmt: fMonthYear,
        aria: 'Inflación anual de Estados Unidos, mensual',
      });
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
      await loadQuotes(false);
      loadHistories();
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
    renderTiles();
    loadPeru();
    loadUsa();
    await loadQuotes(false);
    loadHistories();

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
