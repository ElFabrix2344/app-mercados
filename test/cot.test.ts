import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { getCotRows, type CotRow } from '../src/lib/cftc';
import { ApiError } from '../src/lib/http';
import { addDays } from '../src/lib/num';
import { buildCot, cot, COT_MARKETS } from '../src/services/cot';
import { memoryKV } from './helpers';

/** Semanas de un contrato, de la más vieja a la más nueva, con el neto (fracción de 100 000 contratos) de cada una. */
function weeks(code: string, nets: number[], last = '2026-11-03'): CotRow[] {
  return nets.map((n, i) => ({ date: addDays(last, -7 * (nets.length - 1 - i)), code, openInterest: 100_000, long: Math.round(20_000 + n * 100_000), short: 20_000 }));
}

/** La API de la CFTC de mentira: devuelve las filas pedidas como texto, igual que Socrata, y anota cada dirección. */
function socrata(rows: CotRow[]) {
  const urls: URL[] = [];
  const f = (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)));
    return Response.json(
      [...rows].reverse().map((r) => ({
        report_date_as_yyyy_mm_dd: `${r.date}T00:00:00.000`,
        cftc_contract_market_code: r.code,
        open_interest_all: String(r.openInterest),
        m_money_positions_long_all: String(r.long),
        m_money_positions_short_all: String(r.short),
      })),
    );
  }) as typeof fetch;
  return { f, urls };
}

describe('posición de los fondos (CFTC)', () => {
  const now = new Date('2026-11-06T22:00:00Z');

  it('pide todos los contratos en una consulta y lee los números que llegan como texto', async () => {
    const { f, urls } = socrata([...weeks('085692', [0.1, 0.2]), ...weeks('088691', [0.3])]);
    const rows = await getCotRows(['085692', '088691'], '2025-10-22', f);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get('$where')).toBe("cftc_contract_market_code in('085692','088691') AND report_date_as_yyyy_mm_dd >= '2025-10-22'");
    expect(urls[0]!.searchParams.get('$order')).toBe('report_date_as_yyyy_mm_dd DESC');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ date: '2026-11-03', code: '088691', openInterest: 100_000, long: 50_000, short: 20_000 });
  });

  it('no arma la consulta con códigos o fechas raros', async () => {
    const { f, urls } = socrata([]);
    await expect(getCotRows(["085692') OR (1=1"], '2025-10-22', f)).rejects.toBeInstanceOf(ApiError);
    await expect(getCotRows(['085692'], "2025-10-22' OR '1", f)).rejects.toBeInstanceOf(ApiError);
    expect(urls).toHaveLength(0);
  });

  it('un error de la CFTC sale como error del proveedor', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(getCotRows(['085692'], '2025-10-22', down)).rejects.toMatchObject({ code: 'upstream_error', provider: 'cftc' });
  });

  it('neto, semana anterior y dónde queda frente al año', () => {
    const copper = Array.from({ length: 60 }, (_, i) => 0.3 - i * 0.003); // baja todo el año: hoy, lo menos
    const gold = [...Array.from({ length: 30 }, () => 0.2), ...Array.from({ length: 30 }, () => 0.3), 0.25]; // a la mitad
    const d = buildCot([...weeks('085692', copper), ...weeks('088691', gold), ...weeks('999999', [0.5])]);
    expect(d.date).toBe('2026-11-03');
    expect(Object.keys(d.markets)).toEqual(['copper', 'gold']);
    const c = d.markets.copper!;
    expect(c.points).toHaveLength(52);
    expect(c.points.at(-1)).toEqual(['2026-11-03', 0.123]);
    expect(c.net).toBe(12_300);
    expect(c.prevNetPct).toBeCloseTo(0.126);
    expect(c.rank).toBe(0);
    expect(d.markets.gold!.rank).toBeCloseTo(21 / 51); // del año quedan 21 semanas en 0,2 y 30 en 0,3 antes de hoy
  });

  it('con pocas semanas no compara con el año', () => {
    const d = buildCot(weeks('084691', [0.05, 0.04, 0.06]));
    expect(d.markets.silver).toMatchObject({ rank: null, prevNetPct: 0.04, netPct: 0.06 });
  });

  it('se guarda 3 horas en KV y, si la CFTC falla, queda el último informe', async () => {
    const { kv } = memoryKV();
    const all = COT_MARKETS.flatMap((m) => weeks(m.code, Array.from({ length: 53 }, (_, i) => i / 100)));
    const { f, urls } = socrata(all);
    const r = await cot({ kv, now, fetch: f });
    expect(Object.keys(r.data.markets)).toEqual(['copper', 'gold', 'silver', 'oil']);
    expect(urls).toHaveLength(1);
    await cot({ kv, now: new Date(now.getTime() + 2 * 3_600_000), fetch: f });
    expect(urls).toHaveLength(1); // dentro de las 3 horas, de lo guardado
    const down = (async () => new Response('', { status: 500 })) as typeof fetch;
    const later = await cot({ kv, now: new Date(now.getTime() + 4 * 3_600_000), fetch: down });
    expect(later).toMatchObject({ stale: true, data: { date: '2026-11-03' } });
    // Una respuesta vacía tampoco borra lo guardado.
    const empty = await cot({ kv, now: new Date(now.getTime() + 8 * 3_600_000), fetch: socrata([]).f });
    expect(empty.stale).toBe(true);
  });

  it('la ruta es pública: también para los amigos', async () => {
    const env = { CACHE: memoryKV().kv, ASSETS: { fetch: async () => new Response('') }, TIMEZONE: 'America/Lima', DEV_MODE: 'true', MOCK_DATA: 'true', DEV_ROLE: 'friend' } as unknown as Env;
    const res = await worker.fetch(new Request('http://localhost/api/cot'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const r = (await res.json()) as any;
    expect(Object.keys(r.data.markets)).toEqual(['copper', 'gold', 'silver', 'oil']);
    expect(r.data.markets.copper.points).toHaveLength(52);
    // El martes del último informe que ya salió.
    expect(new Date(`${r.data.date}T12:00:00Z`).getUTCDay()).toBe(2);
  });
});
