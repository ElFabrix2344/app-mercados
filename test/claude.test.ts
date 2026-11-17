import { describe, expect, it } from 'vitest';
import { claudeApi, claudeMock, iaModel, medidor, modelName, usdOf, type Herramienta } from '../src/lib/claude';

// El SDK oficial de Anthropic contra una API de mentira: lo que se le pide (modelo, respaldo, herramientas) y cómo
// se lee lo que responde. Ninguna prueba sale a internet.

type Msg = { content: any[]; stop_reason?: string; model?: string; usage?: { input_tokens: number; output_tokens: number } };

const message = (m: Msg) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: m.model ?? 'claude-opus-5-5',
  content: m.content,
  stop_reason: m.stop_reason ?? 'end_turn',
  stop_sequence: null,
  usage: m.usage ?? { input_tokens: 1000, output_tokens: 200 },
});

/** La misma respuesta, como la manda la API cuando se pide con transmisión (eventos SSE). */
function sse(m: Msg): Response {
  const full = message(m);
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { ...full, content: [], stop_reason: null, usage: { input_tokens: full.usage.input_tokens, output_tokens: 0 } } });
  full.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '', citations: b.citations ? [] : null } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      for (const citation of b.citations ?? []) out += ev('content_block_delta', { index, delta: { type: 'citations_delta', citation } });
    } else out += ev('content_block_start', { index, content_block: b });
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: full.stop_reason, stop_sequence: null }, usage: { output_tokens: full.usage.output_tokens } });
  out += ev('message_stop', {});
  return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
}

/** Responde, en orden, lo que se le dé; anota cada pedido. */
function fakeApi(replies: (Msg | Response)[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url: String(input), headers: new Headers(init?.headers), body });
    const r = replies.shift();
    if (!r) throw new Error('pedido de más');
    if (r instanceof Response) return r;
    return body.stream ? sse(r) : Response.json(message(r));
  }) as typeof fetch;
  return { f, calls };
}

const apiError = (status: number, type: string, msg: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: msg } }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });

const pedido = { system: 'Eres un lector.', user: 'Hola', effort: 'medium' as const, maxTokens: 4000 };

describe('precios y modelos', () => {
  it('el gasto sale de los tokens y del modelo que respondió; uno que no está en la tabla se cuenta caro', () => {
    expect(usdOf('claude-opus-5-5', { input: 1_000_000, output: 1_000_000 })).toBe(24);
    expect(usdOf('claude-fable-5-2', { input: 100_000, output: 10_000 })).toBeCloseTo(1.2, 9);
    expect(usdOf('otro-modelo', { input: 1000, output: 1000 })).toBeCloseTo(0.06, 9);
    expect(iaModel(undefined)).toBe('claude-opus-5-5');
    expect(iaModel('claude-fable-5-2')).toBe('claude-fable-5-2');
    expect(iaModel('gpt-x')).toBe('claude-opus-5-5');
    expect(iaModel('constructor')).toBe('claude-opus-5-5');
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });
});

describe('un pedido simple', () => {
  it('va a la API de Anthropic con la clave, el modelo, el esfuerzo y el respaldo ante rechazos; cuenta lo que costó', async () => {
    const { f, calls } = fakeApi([{ content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Uno. ' }, { type: 'text', text: 'Dos.' }] }]);
    const m = medidor();
    const r = await claudeApi('sk-ant-prueba', 'claude-opus-5-5', { fetch: f }).texto(pedido, m);
    expect(r.text).toBe('Uno. Dos.');
    const c = calls[0]!;
    expect(new URL(c.url)).toMatchObject({ origin: 'https://api.anthropic.com', pathname: '/v1/messages' });
    expect(c.headers.get('authorization')).toBe('Bearer sk-ant-prueba');
    expect(c.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(c.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 4000, fallbacks: 'default', output_config: { effort: 'medium' }, system: 'Eres un lector.', messages: [{ role: 'user', content: 'Hola' }] });
    // Nada de lo que la API ya no acepta en estos modelos.
    for (const k of ['thinking', 'temperature', 'tool_choice', 'stream']) expect(c.body[k]).toBeUndefined();
    // 1000 de entrada y 200 de salida con Opus 5.5: US$ 0.004 + 0.004.
    expect(m).toMatchObject({ input: 1000, output: 200, model: 'claude-opus-5-5' });
    expect(m.usd).toBeCloseTo(0.008, 9);
  });

  it('si respondió el modelo de respaldo, se cuenta a su precio (o al más caro si no está en la tabla)', async () => {
    const { f } = fakeApi([{ model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }]);
    const m = medidor();
    await claudeApi('k', 'claude-fable-5-2', { fetch: f }).texto(pedido, m);
    expect(m.usd).toBeCloseTo(0.02, 9);
    expect(m.model).toBe('claude-opus-4-8');
  });

  it('un rechazo, una respuesta vacía o cortada y los errores de la API llegan como errores de Rueda, y lo gastado queda contado', async () => {
    const run = async (reply: Msg | Response) => {
      const m = medidor();
      const p = claudeApi('k', 'claude-opus-5-5', { fetch: fakeApi([reply]).f }).texto(pedido, m);
      return { err: await p.then(() => null, (e) => e), m };
    };
    const refusal = await run({ content: [], stop_reason: 'refusal' });
    expect(refusal.err).toMatchObject({ code: 'upstream_error', provider: 'claude', message: expect.stringContaining('no quiso responder') });
    expect(refusal.m.usd).toBeGreaterThan(0);
    expect((await run({ content: [{ type: 'text', text: 'a medias' }], stop_reason: 'max_tokens' })).err).toMatchObject({ message: expect.stringContaining('quedó cortada') });
    expect((await run({ content: [{ type: 'text', text: '  ' }] })).err).toMatchObject({ code: 'bad_response' });
    const auth = await run(apiError(401, 'authentication_error', 'invalid x-api-key'));
    expect(auth.err).toMatchObject({ code: 'not_configured', status: 503, message: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(auth.m.usd).toBe(0);
    expect((await run(apiError(429, 'rate_limit_error', 'slow down'))).err).toMatchObject({ code: 'rate_limited', status: 429 });
    expect((await run(apiError(400, 'invalid_request_error', 'Your credit balance is too low'))).err).toMatchObject({ code: 'upstream_error', message: expect.stringContaining('credit balance is too low') });
    expect((await run(apiError(529, 'overloaded_error', 'Overloaded'))).err).toMatchObject({ code: 'upstream_error', message: 'Claude respondió con un error (529).' });
  });
});

describe('leer páginas con web_fetch', () => {
  const doc = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Net sales increased 12%...' }, title: '8-K', citations: { enabled: true } };
  const fetched = (id: string, url: string) => [
    { type: 'server_tool_use', id, name: 'web_fetch', input: { url } },
    { type: 'web_fetch_tool_result', tool_use_id: id, content: { type: 'web_fetch_result', url, content: doc, retrieved_at: '2026-11-17T15:00:00Z' } },
  ];
  const cita = (cited_text: string) => ({ type: 'char_location', cited_text, document_index: 0, document_title: '8-K', start_char_index: 0, end_char_index: 10 });
  const leer = { ...pedido, dominios: ['www.sec.gov'], maxLecturas: 3, maxTokensPorDocumento: 120_000 };

  it('pide con transmisión y la herramienta acotada a sec.gov; devuelve lo escrito después de leer, con sus citas', async () => {
    const { f, calls } = fakeApi([
      {
        content: [
          { type: 'text', text: 'Voy a abrir el documento.' },
          ...fetched('srvtoolu_1', 'https://www.sec.gov/Archives/a.htm'),
          ...fetched('srvtoolu_2', 'https://www.sec.gov/Archives/ex991.htm'),
          { type: 'text', text: 'Ventas récord\n- Las ventas subieron 12 %.', citations: [cita('Net sales increased 12% compared to the prior year period.'), cita('Net sales increased 12% compared to the prior year period.')] },
          { type: 'text', text: '\n- Mantiene su guía.', citations: [cita(`We maintain our guidance ${'and more '.repeat(60)}`), cita('corta')] },
        ],
        usage: { input_tokens: 40_000, output_tokens: 1500 },
      },
    ]);
    const m = medidor();
    const r = await claudeApi('k', 'claude-opus-5-5', { fetch: f }).leer(leer, m);
    expect(r.text).toBe('Ventas récord\n- Las ventas subieron 12 %.\n- Mantiene su guía.');
    expect(r.leidos).toEqual(['https://www.sec.gov/Archives/a.htm', 'https://www.sec.gov/Archives/ex991.htm']);
    expect(r.fallos).toEqual([]);
    // Sin repetidas, recortadas, y sin las que son demasiado cortas para decir algo.
    expect(r.citas).toHaveLength(2);
    expect(r.citas[0]).toBe('Net sales increased 12% compared to the prior year period.');
    expect(r.citas[1]!.length).toBeLessThanOrEqual(280);
    expect(calls[0]!.body).toMatchObject({
      stream: true,
      fallbacks: 'default',
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, allowed_domains: ['www.sec.gov'], max_content_tokens: 120_000, citations: { enabled: true } }],
    });
    // 40 000 de entrada (el documento) y 1 500 de salida: US$ 0.16 + 0.03.
    expect(m.usd).toBeCloseTo(0.19, 9);
  });

  it('si no pudo abrir la página, lo dice; si la API pausa una lectura larga, se retoma devolviéndole lo que lleva', async () => {
    const failed = [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://www.sec.gov/x' } },
      { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
    ];
    const { f, calls } = fakeApi([
      { content: failed, stop_reason: 'pause_turn', usage: { input_tokens: 500, output_tokens: 50 } },
      { content: [...fetched('srvtoolu_2', 'https://www.sec.gov/y'), { type: 'text', text: 'Titular\n- Punto.' }], usage: { input_tokens: 9000, output_tokens: 400 } },
    ]);
    const m = medidor();
    const r = await claudeApi('k', 'claude-opus-5-5', { fetch: f }).leer(leer, m);
    expect(r).toMatchObject({ text: 'Titular\n- Punto.', leidos: ['https://www.sec.gov/y'], fallos: ['url_not_accessible'], citas: [] });
    expect(calls).toHaveLength(2);
    // El segundo pedido lleva el turno pausado tal cual, sin agregar un «continúa».
    expect(calls[1]!.body.messages).toHaveLength(2);
    expect(calls[1]!.body.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'server_tool_use' }, { type: 'web_fetch_tool_result' }] });
    expect(m.input).toBe(9500);
    expect(m.usd).toBeCloseTo(usdOf('claude-opus-5-5', { input: 9500, output: 450 }), 9);
  });
});

describe('preguntar con herramientas propias', () => {
  const tools = (log: string[]): Herramienta[] => [
    { name: 'peru', description: 'Perú', input_schema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => (log.push('peru'), '{"dolar":3.37}') },
    {
      name: 'empresa',
      description: 'Empresa',
      input_schema: { type: 'object', properties: { simbolo: { type: 'string' } }, required: ['simbolo'], additionalProperties: false },
      run: async (input) => {
        log.push(`empresa:${String(input.simbolo)}`);
        throw new Error('se cayó');
      },
    },
  ];
  const use = (id: string, name: string, input: object = {}) => ({ type: 'tool_use', id, name, input });
  const chat = { ...pedido, effort: 'low' as const };

  it('corre juntas las herramientas que pide y le devuelve todos los resultados en un solo mensaje; sin respaldo', async () => {
    const log: string[] = [];
    const { f, calls } = fakeApi([
      { content: [{ type: 'thinking', thinking: '', signature: 's' }, use('t1', 'peru'), use('t2', 'empresa', { simbolo: 'SCCO' }), use('t3', 'inventada')], stop_reason: 'tool_use', usage: { input_tokens: 800, output_tokens: 60 } },
      { content: [{ type: 'text', text: 'El dólar está en S/ 3.37.' }], usage: { input_tokens: 1500, output_tokens: 90 } },
    ]);
    const m = medidor();
    const r = await claudeApi('k', 'claude-opus-5-5', { fetch: f }).conversar({ ...chat, herramientas: tools(log), maxVueltas: 2 }, m);
    expect(r).toEqual({ text: 'El dólar está en S/ 3.37.', usadas: ['peru'] });
    expect(log).toEqual(['peru', 'empresa:SCCO']);
    expect(calls[0]!.body.tools.map((t: { name: string }) => t.name)).toEqual(['peru', 'empresa']);
    expect(calls[0]!.body.fallbacks).toBeUndefined();
    expect(calls[0]!.body.tool_choice).toBeUndefined();
    const second = calls[1]!.body.messages;
    expect(second).toHaveLength(3);
    // El turno de Claude vuelve entero (con lo que pensó) y los tres resultados, juntos y en orden.
    expect(second[1].content.map((b: { type: string }) => b.type)).toEqual(['thinking', 'tool_use', 'tool_use', 'tool_use']);
    expect(second[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '{"dolar":3.37}' },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'No se pudo leer ese dato.' },
      { type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Esa herramienta no existe.' },
    ]);
    expect(m.input).toBe(2300);
  });

  it('en la última vuelta ya no puede pedir más datos: tiene que responder', async () => {
    const log: string[] = [];
    const { f, calls } = fakeApi([
      { content: [use('t1', 'peru')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Con lo que tengo: 3.37.' }] },
    ]);
    const r = await claudeApi('k', 'claude-opus-5-5', { fetch: f }).conversar({ ...chat, herramientas: tools(log), maxVueltas: 1 }, medidor());
    expect(r.text).toBe('Con lo que tengo: 3.37.');
    expect(calls[0]!.body.tool_choice).toBeUndefined();
    expect(calls[1]!.body.tool_choice).toEqual({ type: 'none' });
    expect(calls).toHaveLength(2);
  });
});

describe('desarrollo local', () => {
  it('sin clave: respuestas de prueba y un gasto inventado, sin llamar a nadie', async () => {
    const c = claudeMock('claude-opus-5-5');
    const m = medidor();
    expect((await c.texto({ ...pedido, user: '<datos>\nSímbolo: SCCO\n</datos>' }, m)).text).toContain('SCCO');
    const l = await c.leer({ ...pedido, user: 'Documento principal: https://www.sec.gov/a.htm', dominios: [], maxLecturas: 1, maxTokensPorDocumento: 1 }, m);
    expect(l).toMatchObject({ leidos: ['https://www.sec.gov/a.htm'], fallos: [] });
    expect(m.usd).toBeGreaterThan(0);
  });
});
