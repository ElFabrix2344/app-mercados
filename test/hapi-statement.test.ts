import { describe, expect, it } from 'vitest';
import { addOps, emptyAccount } from '../public/hapi-core.js';
import { applyImport, numberOf, OPENING_NOTE, parseStatement, proposeImport } from '../public/hapi-statement.js';

// Estado de cuenta INVENTADO con la forma de los de Hapi (Apex Clearing): mismas columnas y posiciones que uno real,
// pero con otra persona, otro número de cuenta y otros montos. Cada trozo: [página, x, y, texto].
type Cell = [number, number, number, string];

const header = (page: number): Cell[] => [
  [page, 72, 57, 'August 1, 2026 - August 31, 2026'],
  [page, 292, 77, 'PAGE'],
  [page, 310, 77, String(page)],
  [page, 72, 92, 'ACCOUNT NUMBER'],
  [page, 151, 92, '0XX-00000-00 RR HHA'],
  [page, 72, 131, 'ANA M PEREZ'],
  [page, 49, 141, 'S'],
];
const portfolioHead = (page: number, y: number): Cell[] =>
  (
    [
      [71, 'DESCRIPTION'],
      [222, 'CUSIP'],
      [272, 'TYPE'],
      [339, 'QUANTITY'],
      [407, 'PRICE'],
      [464, 'VALUE'],
      [505, 'MARKET VALUE'],
      [554, '% CHANGE'],
      [610, 'INCOME'],
      [656, 'PORTFOLIO'],
    ] as const
  ).map(([x, s]) => [page, x, y, s]);
const activityHead = (page: number, y: number): Cell[] =>
  (
    [
      [73, 'TRANSACTION'],
      [129, 'DATE'],
      [179, 'TYPE'],
      [208, 'DESCRIPTION'],
      [405, 'QUANTITY'],
      [476, 'PRICE'],
      [556, 'DEBIT'],
      [617, 'CREDIT'],
    ] as const
  ).map(([x, s]) => [page, x, y, s]);

const CELLS: Cell[] = [
  // Página 1: resumen.
  [1, 72, 100, 'August 1, 2026 - August 31, 2026'],
  [1, 72, 135, 'ACCOUNT NUMBER'],
  [1, 151, 135, '0XX-00000-00 RR HHA'],
  [1, 72, 174, 'ANA M PEREZ'],
  [1, 504, 203, 'ANA M PEREZ'],
  [1, 504, 212, 'AV SIEMPRE VIVA 742'],
  [1, 70, 413, 'TOTAL PRICED PORTFOLIO'],
  [1, 213, 413, '998.00'],
  [1, 294, 413, '1,227.39'],
  [1, 70, 430, 'Total Equity Holdings'],
  [1, 207, 430, '$1,000.00'],
  [1, 289, 430, '$1,234.56'],
  // Página 2: posiciones y el inicio de la actividad.
  ...header(2),
  [2, 69, 194, 'PORTFOLIO SUMMARY'],
  [2, 222, 207, 'SYMBOL/'],
  ...portfolioHead(2, 215),
  [2, 71, 229, 'F DI C INS URE D DE POS IT S'],
  [2, 49, 244, 'T'],
  [2, 71, 244, 'THE INSURED DEPOSIT PROGRAM'],
  [2, 222, 244, 'ISPAZ'],
  [2, 272, 244, 'C'],
  [2, 343, 244, '2.00'],
  [2, 403, 244, '$1.00'],
  [2, 461, 244, '$2.00'],
  [2, 71, 256, 'Total FDIC Insured Deposits'],
  [2, 458, 256, '$2.00'],
  [2, 71, 280, 'E Q UIT IE S / O PT IO NS'],
  [2, 71, 293, 'ISHARES TRUST'],
  [2, 222, 293, 'IVV'],
  [2, 272, 293, 'C'],
  [2, 343, 293, '1.5'],
  [2, 394, 293, '$600.00'],
  [2, 457, 293, '$900.00'],
  [2, 521, 293, '$880.00'],
  [2, 570, 293, '2%'],
  [2, 657, 293, '73.0%'],
  [2, 78, 302, 'ISHARES CORE S&P 500 ETF'],
  [2, 71, 315, 'ISHARES TRUST'],
  [2, 222, 315, 'SHY'],
  [2, 272, 315, 'C'],
  [2, 343, 315, '1'],
  [2, 403, 315, '82.00'],
  [2, 461, 315, '82.00'],
  [2, 526, 315, '81.50'],
  [2, 78, 324, 'ISHARES 1 3 YEAR TREASURY'],
  [2, 78, 333, 'BOND ETF'],
  [2, 71, 345, 'SOUTHERN COPPER CORP'],
  [2, 222, 345, 'SCCO'],
  [2, 272, 345, 'C'],
  [2, 343, 345, '1.75'],
  [2, 399, 345, '139.08'],
  [2, 461, 345, '243.39'],
  [2, 526, 345, '230.00'],
  [2, 71, 360, 'Total Equities'],
  [2, 447, 360, '$1,225.39'],
  [2, 71, 371, 'Total Cash (Net Portfolio Balance)'],
  [2, 458, 371, '$7.17'],
  [2, 71, 382, 'TOTAL PRICED PORTFOLIO'],
  [2, 447, 382, '$1,234.56'],
  [2, 179, 393, 'ACCOUNT'],
  ...activityHead(2, 400),
  [2, 73, 414, 'S E C UR IT Y T RA DE S'],
  [2, 73, 428, 'BOUGHT'],
  [2, 129, 428, '08/05/26'],
  [2, 179, 428, 'C'],
  [2, 208, 428, 'SOUTHERN COPPER CORP'],
  [2, 405, 428, '0.75'],
  [2, 476, 428, '130.00'],
  [2, 556, 428, '97.65'],
  [2, 215, 436, 'UNSOLICITED'],
  [2, 73, 450, 'SOLD'],
  [2, 129, 450, '08/12/26'],
  [2, 179, 450, 'C'],
  [2, 208, 450, 'ISHARES TRUST'],
  [2, 405, 450, '0.5'],
  [2, 476, 450, '590.00'],
  [2, 617, 450, '294.84'],
  [2, 215, 458, 'ISHARES CORE S&P 500 ETF'],
  [2, 73, 472, 'D IVI DE ND S A ND IN T ER ES T'],
  [2, 73, 486, 'DIVIDEND'],
  [2, 129, 486, '08/20/26'],
  [2, 179, 486, 'C'],
  [2, 208, 486, 'ISHARES TRUST'],
  [2, 458, 486, '$0.250000'],
  [2, 616, 486, '$0.25'],
  [2, 215, 494, 'ISHARES 1 3 YEAR TREASURY'],
  [2, 481, 494, 'WH'],
  [2, 556, 494, '0.08'],
  [2, 215, 503, 'BOND ETF'],
  [2, 215, 511, 'CASH DIV ON'],
  [2, 232, 519, '1.00000 SHS'],
  // Página 3: el dividendo sigue tras el salto de página; un depósito, algo no reconocido y los barridos internos.
  ...header(3),
  [3, 67, 189, 'ACCOUNT ACTIVITY'],
  [3, 150, 189, '(CONTINUED)'],
  ...activityHead(3, 215),
  [3, 73, 228, 'D IVI DE ND S A ND IN T ER ES T'],
  [3, 193, 228, '(continued)'],
  [3, 215, 244, 'REC 08/15/26 PAY 08/20/26'],
  [3, 215, 252, 'CUSIP: 464287457'],
  [3, 73, 270, 'JOURNAL'],
  [3, 129, 270, '08/25/26'],
  [3, 179, 270, 'C'],
  [3, 208, 270, 'CASH RECEIPT'],
  [3, 617, 270, '500.00'],
  [3, 73, 290, 'INTEREST'],
  [3, 129, 290, '08/31/26'],
  [3, 179, 290, 'C'],
  [3, 208, 290, 'FDIC INSURED DEPOSIT'],
  [3, 617, 290, '0.01'],
  [3, 73, 310, 'Total Dividends And Interest'],
  [3, 548, 310, '$0.08'],
  [3, 613, 310, '$0.26'],
  [3, 73, 384, 'DATE'],
  [3, 130, 384, 'ACTIVITY'],
  [3, 240, 384, 'DESCRIPTION'],
  [3, 447, 384, 'AMOUNT'],
  [3, 527, 384, 'DEBIT'],
  [3, 617, 384, 'CREDIT'],
  [3, 694, 384, 'BALANCE'],
  [3, 73, 428, '08/04/26'],
  [3, 130, 428, 'SWEEP'],
  [3, 459, 428, '0.10'],
  [3, 527, 428, '0.10'],
];
const ITEMS = CELLS.map(([page, x, y, s]) => ({ page, x, y, s }));

describe('numberOf', () => {
  it('lee montos, porcentajes y negativos', () => {
    expect(['$1,234.56', '-4%', '.064%', '(0.12)', '$-0.46', 'WH', '1.25000 SHS'].map(numberOf)).toEqual([1234.56, -4, 0.064, -0.12, -0.46, null, null]);
  });
});

describe('parseStatement', () => {
  const st = parseStatement(ITEMS);

  it('periodo, valor total y efectivo (FDIC + caja)', () => {
    expect(st.period).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(st).toMatchObject({ opening: 1000, total: 1234.56, cash: 9.17 });
  });

  it('posiciones con su nombre en varias líneas (sin el depósito asegurado)', () => {
    expect(st.positions.map((p) => [p.symbol, p.qty, p.price, p.value])).toEqual([
      ['IVV', 1.5, 600, 900],
      ['SHY', 1, 82, 82],
      ['SCCO', 1.75, 139.08, 243.39],
    ]);
    expect(st.positions[1]!.lines).toEqual(['ISHARES TRUST', 'ISHARES 1 3 YEAR TREASURY', 'BOND ETF']);
  });

  it('movimientos: el símbolo sale del nombre; el costo, de la diferencia; la retención, de la fila WH', () => {
    expect(st.moves.map((m) => m.op)).toEqual([
      { kind: 'buy', date: '2026-08-05', symbol: 'SCCO', qty: 0.75, price: 130, fee: 0.15 },
      { kind: 'sell', date: '2026-08-12', symbol: 'IVV', qty: 0.5, price: 590, fee: 0.16 },
      { kind: 'dividend', date: '2026-08-20', symbol: 'SHY', amount: 0.25, tax: 0.08 },
      { kind: 'deposit', date: '2026-08-25', amount: 500, fee: 0 },
    ]);
    expect(st.unknown.map((u) => u.type)).toEqual(['INTEREST']);
  });

  it('no lee el nombre, la dirección ni el número de cuenta', () => {
    const text = JSON.stringify(st);
    for (const s of ['PEREZ', 'SIEMPRE VIVA', '0XX-00000-00']) expect(text).not.toContain(s);
  });
});

describe('proposeImport / applyImport', () => {
  const st = parseStatement(ITEMS);

  it('cuenta vacía: saldo inicial al cierre del mes; los movimientos del mes ya están en él', () => {
    const p = proposeImport(st, emptyAccount());
    expect(p.mode).toBe('start');
    expect(p.items.filter((i) => i.checked).map((i) => [i.op.kind, i.op.symbol ?? null, i.op.note])).toEqual([
      ['deposit', null, OPENING_NOTE],
      ['buy', 'IVV', OPENING_NOTE],
      ['buy', 'SHY', OPENING_NOTE],
      ['buy', 'SCCO', OPENING_NOTE],
    ]);
    const { account, diffs } = applyImport(emptyAccount(), p, '2026-10-23');
    expect(diffs).toEqual([]);
    expect(account.snapshot).toEqual({ date: '2026-08-31', value: 1234.56, source: 'estado de cuenta' });
    expect(account.ops).toHaveLength(4);
  });

  it('cuenta con movimientos: agrega lo nuevo y deja sin marcar lo que ya estaba anotado', () => {
    const before = addOps(emptyAccount(), [{ kind: 'buy', date: '2026-08-05', symbol: 'SCCO', qty: 0.75, price: 130 }], '2026-10-23');
    const p = proposeImport(st, before);
    expect(p.mode).toBe('update');
    expect(p.items.map((i) => [i.op.kind, i.checked, i.info])).toEqual([
      ['buy', false, 'Ya está anotado'],
      ['sell', true, null],
      ['dividend', true, null],
      ['deposit', true, null],
    ]);
  });

  it('un PDF que no es un estado de cuenta se rechaza', () => {
    expect(() => proposeImport(parseStatement([{ page: 1, x: 10, y: 10, s: 'Hola' }]), emptyAccount())).toThrow('No parece un estado de cuenta');
  });
});
