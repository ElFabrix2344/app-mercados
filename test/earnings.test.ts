import { describe, expect, it } from 'vitest';
import { getEarnings, parseEarnings, type EarningsRelease } from '../src/lib/finnhub';
import { EARNINGS_TTL_MS, companyCalendar, earningsEvent, epsSurprise } from '../src/services/earnings';
import type { Deps } from '../src/services/market';
import { fakeFetch, memoryKV } from './helpers';

// Jueves 22 oct 2026, 10:00 en Lima.
const NOW = new Date('2026-10-22T15:00:00Z');
const TODAY = '2026-10-22';

const release = (symbol: string, date: string, extra: Partial<EarningsRelease> = {}): EarningsRelease => ({
  symbol,
  date,
  hour: 'amc',
  year: 2026,
  quarter: 3,
  epsEstimate: 4.5,
  epsActual: null,
  revenueEstimate: 1.2e9,
  revenueActual: null,
  ...extra,
});

/** Finnhub falso: responde las presentaciones de cada símbolo (vacío si no hay). */
const finnhub = (bySymbol: Record<string, EarningsRelease[]>) =>
  fakeFetch((url) => ({ body: { earningsCalendar: bySymbol[url.searchParams.get('symbol')!] ?? [] } }));

/** innhubKey: null = sin clave cargada. */
function deps(f?: typeof fetch, kvInit: Record<string, unknown> = {}, finnhubKey: string | null = 'clave') {
  const mem = memoryKV(kvInit);
  const d: Deps = { kv: mem.kv, now: NOW, fetch: f, finnhubKey: finnhubKey ?? undefined };
  return { d, mem };
}

describe('parseEarnings', () => {
  it('lee las presentaciones en orden y descarta las incompletas', () => {
    const r = parseEarnings({
      earningsCalendar: [
        { ...release('BAP', '2026-11-09'), symbol: 'bap', hour: '', quarter: 7 },
        release('SCCO', '2026-10-27', { hour: 'bmo' }),
        { symbol: 'X', date: 'mañana' },
        null,
      ],
    });
    expect(r.map((x) => x.symbol)).toEqual(['SCCO', 'BAP']);
    expect(r[0]).toMatchObject({ hour: 'bmo', quarter: 3, year: 2026, epsEstimate: 4.5, epsActual: null });
    expect(r[1]).toMatchObject({ hour: null, quarter: null });
  });

  it('sin calendario es un error de Finnhub', () => {
    expect(() => parseEarnings({ error: 'Invalid API key' })).toThrow('Finnhub: Invalid API key');
  });
});

describe('getEarnings', () => {
  it('pide un símbolo entre dos fechas, con la clave como parámetro', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { earningsCalendar: [release('BAP', '2026-11-09'), release('SCCO', '2026-10-27')] } }));
    const r = await getEarnings('BAP', '2026-09-22', '2027-02-19', 'clave', f);
    expect(r.map((x) => x.symbol)).toEqual(['BAP']); // solo las del símbolo pedido
    const u = calls[0]!;
    expect(u.origin + u.pathname).toBe('https://finnhub.io/api/v1/calendar/earnings');
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: '2026-09-22', to: '2027-02-19', symbol: 'BAP', token: 'clave' });
  });

  it('explica una clave rechazada y el límite por minuto', async () => {
    const bad = fakeFetch(() => ({ status: 401, body: { error: 'Invalid API key' } }));
    await expect(getEarnings('BAP', TODAY, TODAY, 'x', bad.f)).rejects.toThrow('FINNHUB_API_KEY');
    const limited = fakeFetch(() => ({ status: 429, body: { error: 'API limit reached' } }));
    await expect(getEarnings('BAP', TODAY, TODAY, 'x', limited.f)).rejects.toMatchObject({ code: 'rate_limited', provider: 'finnhub' });
  });
});

describe('companyCalendar', () => {
  it('sin clave queda apagado y no llama a nadie', async () => {
    const { f, calls } = finnhub({});
    const r = await companyCalendar(deps(f, {}, null).d, ['BAP'], TODAY);
    expect(r).toMatchObject({ enabled: false, events: [], recent: [] });
    expect(calls).toHaveLength(0);
  });

  it('pide solo acciones, separa lo próximo de lo ya presentado y lo guarda 12 horas', async () => {
    const { f, calls } = finnhub({
      BAP: [release('BAP', '2026-10-15', { epsActual: 4.95, revenueActual: 1.3e9 }), release('BAP', '2027-01-20', { quarter: 4 })],
      SCCO: [release('SCCO', '2026-10-27', { hour: 'bmo' })],
    });
    const { d, mem } = deps(f);
    const r = await companyCalendar(d, ['SCCO', 'BAP', 'USD/PEN', 'BTC/USD', 'SPY'], TODAY);
    expect(calls.map((u) => u.searchParams.get('symbol')).sort()).toEqual(['BAP', 'SCCO', 'SPY']);
    // Un mes hacia atrás (lo que da el plan gratis) y 120 días hacia adelante.
    expect(calls[0]!.searchParams.get('from')).toBe('2026-09-22');
    expect(calls[0]!.searchParams.get('to')).toBe('2027-02-19');
    expect(r.enabled).toBe(true);
    expect(r.events.map((e) => [e.date, e.kind, e.title, e.detail])).toEqual([
      ['2026-10-27', 'empresa', 'Resultados de SCCO', '3T 2026 · antes de la apertura'],
      ['2027-01-20', 'empresa', 'Resultados de BAP', '4T 2026 · después del cierre'],
    ]);
    expect(r.recent).toEqual([expect.objectContaining({ symbol: 'BAP', date: '2026-10-15', epsActual: 4.95 })]);
    expect(r.note).toBeNull();
    expect(mem.store.has('earnings:BAP,SCCO,SPY')).toBe(true);

    // Dentro de las 12 horas sale de KV (aunque la lista venga en otro orden).
    const later = { ...d, now: new Date(NOW.getTime() + EARNINGS_TTL_MS - 60_000) };
    const again = await companyCalendar(later, ['BAP', 'SPY', 'SCCO'], TODAY);
    expect(calls).toHaveLength(3);
    expect(again.events).toHaveLength(2);
  });

  it('si falla un símbolo muestra los demás con una nota', async () => {
    const { f } = fakeFetch((url) =>
      url.searchParams.get('symbol') === 'BVN' ? { status: 500, body: {} } : { body: { earningsCalendar: [release('BAP', '2026-11-09')] } },
    );
    const r = await companyCalendar(deps(f).d, ['BAP', 'BVN'], TODAY);
    expect(r.events.map((e) => e.company?.symbol)).toEqual(['BAP']);
    expect(r.errors.BVN).toContain('HTTP 500');
    expect(r.note).toBe('Finnhub no respondió para BVN.');
  });

  it('si fallan todos no guarda nada y el calendario sigue, con el motivo', async () => {
    const { f } = fakeFetch(() => ({ status: 401, body: { error: 'Invalid API key' } }));
    const { d, mem } = deps(f);
    const r = await companyCalendar(d, ['BAP', 'BVN'], TODAY);
    expect(r).toMatchObject({ enabled: true, events: [], stale: true });
    expect(r.note).toContain('FINNHUB_API_KEY');
    expect(mem.writes()).toBe(0);
  });

  it('con Finnhub caído muestra lo guardado antes', async () => {
    const stored = {
      fetchedAt: '2026-10-21T00:00:00.000Z',
      data: { releases: [release('BAP', '2026-11-09')], errors: {}, from: '2026-09-21', to: '2027-02-18' },
    };
    const { f } = fakeFetch(() => ({ status: 503, body: {} }));
    const r = await companyCalendar(deps(f, { 'earnings:BAP': stored }).d, ['BAP'], TODAY);
    expect(r.stale).toBe(true);
    expect(r.events.map((e) => e.date)).toEqual(['2026-11-09']);
    expect(r.note).toContain('HTTP 503');
  });
});

describe('formato de resultados', () => {
  it('sorpresa del BPA frente a lo esperado', () => {
    expect(epsSurprise(release('BAP', TODAY, { epsActual: 4.95 }))).toBeCloseTo(0.1, 9);
    // Con pérdida esperada, perder menos es una sorpresa positiva.
    expect(epsSurprise(release('BAP', TODAY, { epsEstimate: -1, epsActual: -0.5 }))).toBeCloseTo(0.5, 9);
    expect(epsSurprise(release('BAP', TODAY))).toBeNull();
    expect(epsSurprise(release('BAP', TODAY, { epsEstimate: 0, epsActual: 1 }))).toBeNull();
  });

  it('el evento del calendario lleva el trimestre fiscal y el momento solo si se conocen', () => {
    expect(earningsEvent(release('BVN', '2026-10-29', { hour: 'dmh' })).detail).toBe('3T 2026 · durante la sesión');
    const bare = earningsEvent(release('BVN', '2026-10-29', { hour: null, quarter: null }));
    expect(bare.detail).toBeUndefined();
    expect(bare.company?.symbol).toBe('BVN');
  });
});
