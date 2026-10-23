// Lector del estado de cuenta mensual de Hapi (lo emite Apex Clearing), en el navegador: el PDF no sale del equipo.
// Toma solo lo que sirve para la cuenta: el periodo, el valor total, las posiciones y los movimientos del mes. El
// nombre, la dirección y el número de cuenta no se leen (las filas que los traen se saltan).
//
// El PDF viene girado (apaisado): cada trozo de texto se ubica como se ve en pantalla y las tablas se arman por
// filas y columnas, con las columnas tomadas de los encabezados (CANTIDAD, PRECIO, DÉBITO, CRÉDITO…).

import { addOps, holdings, setSnapshot } from './hapi-core.js';

const MONTHS = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };
const PERIOD_RE = /^([A-Z][a-z]+) (\d{1,2}), (\d{4}) - ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/;
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** Líneas de la descripción de un movimiento que no son el nombre del valor. */
const NOISE_RE = /^(CASH DIV ON|REC \d|PAY \d|NON-QUALIFIED|QUALIFIED|NON-RES|CUSIP|[\d.,]+ SHS|\(CONTINUED\))/i;

const norm = (s) => s.replace(/\s+/g, '').toUpperCase();
const round = (x, dec = 6) => Math.round(x * 10 ** dec) / 10 ** dec;

/** «$1,234.56», «-4%», «(0.12)» → número; null si no es un número. */
export function numberOf(s) {
  let t = s.replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/%$/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  return neg ? -Number(t) : Number(t);
}

/** «09/03/26» → «2026-09-03». */
const isoOf = (mdy) => {
  const [m, d, y] = mdy.split('/');
  return `${y.length === 2 ? `20${y}` : y}-${m}-${d}`;
};

/** Filas de cada página, de arriba abajo, con sus celdas de izquierda a derecha. */
function rowsOf(items) {
  const byPage = new Map();
  for (const it of items) {
    // La palabra «STATEMENT» vertical del margen llega letra por letra: no es parte de ninguna tabla.
    if (it.x < 60 && it.s.length <= 1) continue;
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  const rows = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(page).sort((a, b) => a.y - b.y);
    const pr = [];
    for (const it of list) {
      let r = pr.find((q) => Math.abs(q.y - it.y) <= 2.5);
      if (!r) pr.push((r = { page, y: it.y, cells: [] }));
      r.cells.push({ x: it.x, s: it.s });
    }
    for (const r of pr) r.cells.sort((a, b) => a.x - b.x);
    rows.push(...pr.sort((a, b) => a.y - b.y));
  }
  return rows;
}

/** Posición x de cada encabezado (por su texto normalizado). */
function anchorsOf(cells, names) {
  const out = {};
  for (const [key, label] of Object.entries(names)) {
    const c = cells.find((x) => norm(x.s) === label);
    if (c) out[key] = c.x;
  }
  return out;
}

/** La columna numérica más cercana a x. */
function nearest(x, anchors, keys) {
  let best = null;
  let dist = Infinity;
  for (const k of keys) {
    if (anchors[k] === undefined) continue;
    const d = Math.abs(anchors[k] - x);
    if (d < dist) {
      dist = d;
      best = k;
    }
  }
  return dist <= 60 ? best : null;
}

const PORTFOLIO_COLS = { desc: 'DESCRIPTION', sym: 'CUSIP', type: 'TYPE', qty: 'QUANTITY', price: 'PRICE', value: 'VALUE', last: 'MARKETVALUE', change: '%CHANGE', income: 'INCOME', pct: 'PORTFOLIO' };
const PORTFOLIO_NUMS = ['qty', 'price', 'value', 'last', 'change', 'income', 'pct'];
const ACTIVITY_COLS = { tx: 'TRANSACTION', date: 'DATE', type: 'TYPE', desc: 'DESCRIPTION', qty: 'QUANTITY', price: 'PRICE', debit: 'DEBIT', credit: 'CREDIT' };
const ACTIVITY_NUMS = ['qty', 'price', 'debit', 'credit'];

/** Títulos de las tablas al inicio de cada página: no son datos. */
const TITLES = new Set(['PORTFOLIOSUMMARY', 'ACCOUNTACTIVITY', 'FDICINSUREDDEPOSITSBANKACTIVITY', 'ANNOUNCEMENTS', 'IMPORTANTINFORMATION']);
/** Una fila de sección: letras sueltas separadas («E Q UIT IE S / O PT IO NS»). */
const spaced = (s) => /^[A-Z ./&-]+$/.test(s) && /\s\S\s/.test(s);

/**
 * @typedef {{ section: string, symbol: string, lines: string[], qty: number | null, price: number | null, value: number | null, last: number | null }} StatementPosition
 * @typedef {{ date: string, type: string, name: string, op: any, shares?: number | null, debit?: number, credit?: number }} StatementMove
 * @typedef {{ period: { from: string, to: string } | null, opening: number | null, total: number | null, cash: number, positions: StatementPosition[], moves: StatementMove[], unknown: StatementMove[], checks: Record<string, any> }} Statement
 */

/**
 * Lee el estado de cuenta a partir del texto con posiciones (ver readPdfItems).
 * @param {{ page: number, x: number, y: number, s: string }[]} items
 * @returns {Statement}
 */
export function parseStatement(items) {
  const rows = rowsOf(items);
  /** @type {Statement} */
  const st = { period: null, opening: null, total: null, cash: 0, positions: [], moves: [], unknown: [], checks: {} };
  let mode = null;
  let A = {};
  let section = '';
  let pos = null;
  let tx = null;
  let band = { page: 0, y: -1 };
  const raw = [];
  const closeTx = () => {
    if (tx) raw.push(tx);
    tx = null;
  };
  const numsOf = (cells, minX = -Infinity) => cells.map((c) => ({ c, v: numberOf(c.s) })).filter((x) => x.v !== null && x.c.x > minX);

  for (const r of rows) {
    const cells = r.cells;
    const N = cells.map((c) => norm(c.s));
    const periodCell = cells.find((c) => PERIOD_RE.test(c.s));
    if (periodCell) {
      const m = periodCell.s.match(PERIOD_RE);
      if (!st.period && MONTHS[m[1]] && MONTHS[m[4]]) st.period = { from: `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`, to: `${m[6]}-${MONTHS[m[4]]}-${m[5].padStart(2, '0')}` };
      continue;
    }
    // Encabezado de cada página: número de cuenta y, debajo, el nombre del titular. No se leen.
    if (N.includes('ACCOUNTNUMBER')) {
      band = { page: r.page, y: r.y + 60 };
      continue;
    }
    if ((r.page === band.page && r.y < band.y) || N.includes('PAGE')) continue;
    if (TITLES.has(N[0]) || N.every((t) => t === '(CONTINUED)')) {
      if (mode === 'portfolio') pos = null;
      continue;
    }

    // Resumen (página 1): valor total de la cuenta al abrir y al cerrar el mes.
    if (N[0] === 'TOTALEQUITYHOLDINGS') {
      const v = numsOf(cells).map((x) => x.v);
      if (v.length >= 2) {
        st.opening = v[0];
        st.total = v.at(-1);
      }
      continue;
    }

    if (N.includes('CUSIP') && N.includes('QUANTITY')) {
      closeTx();
      pos = null;
      mode = 'portfolio';
      A = anchorsOf(cells, PORTFOLIO_COLS);
      continue;
    }
    // Un movimiento puede seguir en la página siguiente: el encabezado repetido no lo cierra.
    if (N.includes('TRANSACTION') && N.includes('DEBIT') && N.includes('CREDIT') && N.includes('QUANTITY')) {
      if (mode !== 'activity') closeTx();
      pos = null;
      mode = 'activity';
      A = anchorsOf(cells, ACTIVITY_COLS);
      continue;
    }
    // Movimientos de los depósitos asegurados (barridos internos de efectivo): no son movimientos de la cuenta.
    if (N.includes('ACTIVITY') && N.includes('BALANCE')) {
      closeTx();
      mode = 'bank';
      continue;
    }

    if (mode === 'portfolio') {
      const sym = cells.find((c) => Math.abs(c.x - A.sym) <= 15 && TICKER_RE.test(c.s));
      const nums = numsOf(cells, A.sym + 20);
      if (/^TOTAL/.test(N[0])) {
        const value = nums.find((x) => nearest(x.c.x, A, PORTFOLIO_NUMS) === 'value')?.v ?? null;
        if (N[0] === 'TOTALFDICINSUREDDEPOSITS') st.checks.insured = value;
        else if (N[0] === 'TOTALEQUITIES') st.checks.equities = value;
        else if (N[0].startsWith('TOTALCASH')) st.checks.cash = value;
        else if (N[0] === 'TOTALPRICEDPORTFOLIO') st.checks.total = value;
        pos = null;
        continue;
      }
      if (sym && nums.length) {
        pos = { section, symbol: sym.s, lines: cells.filter((c) => c.x < A.sym - 10).map((c) => c.s), qty: null, price: null, value: null, last: null };
        for (const { c, v } of nums) {
          const k = nearest(c.x, A, PORTFOLIO_NUMS);
          if (k && k in pos && pos[k] === null) pos[k] = v;
        }
        if (section.startsWith('EQUITIES')) st.positions.push(pos);
        continue;
      }
      if (!nums.length && cells.every((c) => c.x < A.sym - 10)) {
        // Fila de sección («F DI C INS URE D DE POS IT S», «E Q UIT IE S / O PT IO NS») o continuación del nombre.
        if (cells[0].x <= A.desc + 3 && spaced(cells[0].s)) {
          section = norm(cells[0].s);
          pos = null;
        } else if (pos) pos.lines.push(cells.map((c) => c.s).join(' '));
      }
      continue;
    }

    if (mode === 'activity') {
      const txCell = cells.find((c) => Math.abs(c.x - A.tx) <= 12);
      const dateCell = cells.find((c) => Math.abs(c.x - A.date) <= 15 && /^\d{2}\/\d{2}\/\d{2,4}$/.test(c.s));
      if (/^TOTAL/.test(N[0])) {
        const nums = numsOf(cells);
        st.checks[`totals:${N[0]}`] = {
          debit: nums.find((x) => nearest(x.c.x, A, ACTIVITY_NUMS) === 'debit')?.v ?? 0,
          credit: nums.find((x) => nearest(x.c.x, A, ACTIVITY_NUMS) === 'credit')?.v ?? 0,
        };
        closeTx();
        continue;
      }
      if (txCell && dateCell) {
        closeTx();
        tx = { type: txCell.s, date: isoOf(dateCell.s), lines: [], qty: null, price: null, debit: 0, credit: 0, wh: 0, shares: null };
        for (const c of cells) {
          if (c === txCell || c === dateCell || Math.abs(c.x - A.type) <= 8) continue;
          const v = numberOf(c.s);
          if (v === null) {
            if (c.x >= A.desc - 10 && c.x < A.qty - 20) tx.lines.push(c.s);
            continue;
          }
          const k = nearest(c.x, A, ACTIVITY_NUMS);
          if (k === 'debit' || k === 'credit') tx[k] += v;
          else if (k) tx[k] = v;
        }
        continue;
      }
      // Sección («D IVI DE ND S A ND IN T ER ES T»): no cierra el movimiento (puede seguir tras un salto de página).
      if (cells.length <= 2 && Math.abs(cells[0].x - A.tx) <= 12 && spaced(cells[0].s)) {
        section = norm(cells[0].s);
        continue;
      }
      // Continuación del movimiento: más descripción, «1.25000 SHS» o la retención («WH» con su débito).
      const inside = tx && cells.every((c) => (c.x >= A.desc - 10 && c.x < A.qty - 20) || numberOf(c.s) !== null || c.s === 'WH');
      if (!inside) {
        closeTx();
        continue;
      }
      const wh = cells.some((c) => c.s === 'WH');
      for (const c of cells) {
        if (c.s === 'WH') continue;
        const v = numberOf(c.s);
        if (v === null) {
          const shs = c.s.match(/^([\d.,]+) SHS$/);
          if (shs) tx.shares = Number(shs[1].replace(/,/g, ''));
          else tx.lines.push(c.s);
          continue;
        }
        const k = nearest(c.x, A, ACTIVITY_NUMS);
        if (wh && k === 'debit') tx.wh += v;
        else if (k === 'debit' || k === 'credit') tx[k] += v;
      }
    }
  }
  closeTx();

  st.cash = round((st.checks.insured ?? 0) + (st.checks.cash ?? 0), 2);
  if (st.total === null) st.total = st.checks.total ?? null;
  for (const t of raw) {
    const move = classify(t, st.positions);
    if (move.op) st.moves.push(move);
    else st.unknown.push(move);
  }
  return st;
}

/** Símbolo de un movimiento por el nombre del valor (los movimientos del estado de cuenta no traen el símbolo). */
function matchSymbol(lines, shares, positions) {
  const key = (ls) => ls.map(norm).join('|');
  let hits = positions.filter((p) => key(p.lines) === key(lines));
  if (hits.length !== 1) hits = positions.filter((p) => norm(p.lines[0] ?? '') === norm(lines[0] ?? ''));
  if (hits.length > 1 && shares) hits = hits.filter((p) => Math.abs(p.qty - shares) < 1e-4);
  return hits.length === 1 ? hits[0].symbol : null;
}

function classify(t, positions) {
  const type = norm(t.type);
  const lines = t.lines.filter((l) => !NOISE_RE.test(l));
  const name = lines.join(' ');
  const base = { date: t.date, type: t.type, name };
  if (/DIV/.test(type)) {
    const symbol = matchSymbol(lines, t.shares, positions);
    return { ...base, op: { kind: 'dividend', date: t.date, symbol, amount: round(t.credit, 2), tax: round(t.wh, 2) }, shares: t.shares };
  }
  if (/^(BOUGHT|BUY|PURCHASE)/.test(type) && t.qty && t.price) {
    const symbol = matchSymbol(lines, null, positions);
    const fee = t.debit ? round(Math.max(0, t.debit - t.qty * t.price), 2) : undefined;
    return { ...base, op: { kind: 'buy', date: t.date, symbol, qty: t.qty, price: t.price, ...(fee !== undefined ? { fee } : {}) } };
  }
  if (/^(SOLD|SELL|SALE)/.test(type) && t.qty && t.price) {
    const symbol = matchSymbol(lines, null, positions);
    const fee = t.credit ? round(Math.max(0, t.qty * t.price - t.credit), 2) : undefined;
    return { ...base, op: { kind: 'sell', date: t.date, symbol, qty: t.qty, price: t.price, ...(fee !== undefined ? { fee } : {}) } };
  }
  if (/(ACH|DEPOSIT|JOURNAL|WIRE|TRANSFER|RECEIPT|FUNDS|WITHDRAW|DISBURSE)/.test(type) && (t.credit || t.debit)) {
    const deposit = t.credit > 0;
    return { ...base, op: { kind: deposit ? 'deposit' : 'withdrawal', date: t.date, amount: round(deposit ? t.credit : t.debit, 2), fee: 0 } };
  }
  return { ...base, op: null, debit: t.debit, credit: t.credit };
}

const same = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 0.005;

/** ¿Ya está anotado? Mismo tipo, día, símbolo y monto (o cantidad). */
function isDuplicate(op, ops) {
  return ops.some(
    (o) =>
      o.kind === op.kind &&
      o.date === op.date &&
      (o.symbol ?? null) === (op.symbol ?? null) &&
      (op.kind === 'buy' || op.kind === 'sell' ? same(o.qty, op.qty) && same(o.price, op.price) : same(o.amount, op.amount)),
  );
}

export const OPENING_NOTE = 'Saldo inicial (estado de cuenta)';

/**
 * Qué agregar a la cuenta desde un estado de cuenta. Cuenta vacía: un saldo inicial al cierre del mes (el valor de la
 * cuenta como depósito y cada posición a su precio de cierre); los movimientos del mes ya están en ese saldo. Cuenta
 * con movimientos: los del mes que no estén anotados.
 */
export function proposeImport(st, account) {
  if (!st.period || st.total === null) throw new Error('No parece un estado de cuenta de Hapi: no se encontró el periodo ni el valor total.');
  const start = account.ops.length === 0;
  const items = [];
  if (start) {
    items.push({ checked: true, op: { kind: 'deposit', date: st.period.to, amount: st.total, fee: 0, note: OPENING_NOTE } });
    for (const p of st.positions) {
      if (!p.qty || !p.value) continue;
      items.push({ checked: true, op: { kind: 'buy', date: st.period.to, symbol: p.symbol, qty: p.qty, price: round(p.value / p.qty), fee: 0, note: OPENING_NOTE } });
    }
    for (const m of st.moves) items.push({ checked: false, info: 'Ya está en el saldo inicial', op: m.op, name: m.name });
  } else {
    for (const m of st.moves) {
      const dup = isDuplicate(m.op, account.ops);
      const needsSymbol = m.op.kind !== 'deposit' && m.op.kind !== 'withdrawal' && !m.op.symbol;
      items.push({ checked: !dup && !needsSymbol, info: dup ? 'Ya está anotado' : needsSymbol ? 'Falta el símbolo' : null, op: m.op, name: m.name });
    }
  }
  return { mode: start ? 'start' : 'update', period: st.period, total: st.total, cash: st.cash, positions: st.positions, items, unknown: st.unknown };
}

/** Aplica lo marcado y el valor total del estado de cuenta; devuelve la cuenta nueva y las diferencias que queden. */
export function applyImport(account, proposal, today) {
  const chosen = proposal.items.filter((x) => x.checked).map((x) => x.op);
  let next = addOps(account, chosen, today);
  if (!next.snapshot || next.snapshot.date <= proposal.period.to) {
    next = setSnapshot(next, { date: proposal.period.to, value: proposal.total, source: 'estado de cuenta' }, today);
  }
  return { account: next, diffs: reconcile(next, proposal.positions) };
}

/** Diferencias de cantidad entre la cuenta anotada y las posiciones del estado de cuenta. */
export function reconcile(account, positions) {
  const mine = holdings(account);
  const theirs = new Map(positions.map((p) => [p.symbol, p.qty]));
  const out = [];
  for (const s of new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(s) ?? 0;
    const b = theirs.get(s) ?? 0;
    if (Math.abs(a - b) > 1e-4) out.push({ symbol: s, rueda: a, statement: b });
  }
  return out.sort((x, y) => (x.symbol < y.symbol ? -1 : 1));
}

/** Texto con posiciones de cada trozo del PDF, en la orientación en que se ve. `pdfjs`: el módulo de pdf.js. */
export async function readPdfItems(data, pdfjs) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true });
  const doc = await task.promise;
  try {
    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      for (const it of (await page.getTextContent()).items) {
        const s = typeof it.str === 'string' ? it.str.trim() : '';
        if (!s) continue;
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        items.push({ page: p, x, y, s });
      }
    }
    return items;
  } finally {
    await task.destroy();
  }
}

/** La copia de pdf.js que sirve la propia app (en una variable: vitest no debe intentar cargarla). */
const PDFJS = '/vendor/pdfjs/pdf.min.mjs';

/** En el navegador: lee el archivo con pdf.js. */
export async function readStatementFile(file) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  return parseStatement(await readPdfItems(new Uint8Array(await file.arrayBuffer()), pdfjs));
}
