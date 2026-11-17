// La API de Claude (Anthropic). Desde el 17 nov 2026 el Worker sí la llama: el usuario tiene saldo en la API y eligió
// tres usos (leer los reportes de la SEC, explicar la ficha y «Pregúntale a Rueda»), con un tope de US$ 20 al mes.
// Va con la clave de la API (secreto ANTHROPIC_API_KEY), que se cobra aparte del plan Max: el plan sigue sin poder
// usarse desde un programa propio, y el resumen del día sigue saliendo de la tarea programada del dueño.
//
// Este archivo es lo único que habla con la API. Lo demás (services/ia.ts) usa la interfaz `Claude`: así las pruebas y
// el desarrollo local corren sin clave y sin gastar (`claudeMock`).

import type Anthropic from '@anthropic-ai/sdk';
import { ApiError } from './http';

/** El modelo de fábrica. Se cambia con la variable IA_MODEL (no es secreta) a otro de IA_PRICES. */
export const IA_MODEL = 'claude-opus-5-5';

/**
 * Los modelos que se pueden elegir, con su precio de lista en US$ por millón de tokens (Anthropic, nov 2026). Con estos
 * precios se lleva la cuenta del gasto: si cambian, hay que cambiarlos aquí.
 */
export const IA_PRICES: Record<string, { name: string; input: number; output: number }> = {
  'claude-fable-5-2': { name: 'Fable 5.2', input: 8, output: 40 },
  'claude-opus-5-5': { name: 'Opus 5.5', input: 4, output: 20 },
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', input: 2, output: 10 },
  // Haiku 5.5 cuesta 0,10 / 0,50 hasta 100 mil tokens de entrada y 0,50 / 2,50 después: se cuenta el caro.
  'claude-haiku-5-5': { name: 'Haiku 5.5', input: 0.5, output: 2.5 },
};
/** Si responde un modelo que no está en la tabla (el de respaldo tras un rechazo), se cuenta al precio más caro. */
const PRICE_UNKNOWN = { input: 10, output: 50 };

/** El modelo pedido en IA_MODEL si es uno de la tabla; si no, el de fábrica. */
export const iaModel = (raw: string | undefined): string => (raw && Object.hasOwn(IA_PRICES, raw) ? raw : IA_MODEL);

/** «Opus 5.5»: cómo se le dice al modelo en la pantalla. */
export const modelName = (id: string): string => IA_PRICES[id]?.name ?? id.replace(/^claude-/, '');

export function usdOf(model: string, tokens: { input: number; output: number }): number {
  const p = IA_PRICES[model] ?? PRICE_UNKNOWN;
  return (tokens.input * p.input + tokens.output * p.output) / 1e6;
}

/**
 * Lo que va costando un pedido. Se le pasa a cada llamada y se actualiza después de CADA respuesta de la API: si un
 * pedido de varias vueltas falla a la mitad, lo ya gastado queda contado.
 */
export interface Medidor {
  usd: number;
  input: number;
  output: number;
  /** El modelo que respondió último (puede ser el de respaldo). */
  model: string;
}
export const medidor = (): Medidor => ({ usd: 0, input: 0, output: 0, model: '' });

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

/** Suma una respuesta al medidor. Lo leído de caché se cuenta como entrada normal: sale un poco de más, nunca de menos. */
export function medir(m: Medidor, res: { model: string; usage: Usage }): void {
  const u = res.usage;
  const tokens = { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens };
  m.input += tokens.input;
  m.output += tokens.output;
  m.usd += usdOf(res.model, tokens);
  m.model = res.model;
}

export type Esfuerzo = 'low' | 'medium' | 'high';

interface Pedido {
  system: string;
  user: string;
  effort: Esfuerzo;
  /** Tope de la respuesta, contando lo que piensa antes de escribir. */
  maxTokens: number;
}

/** Una herramienta propia para «Pregúntale a Rueda»: la corre el Worker y devuelve texto (JSON). */
export interface Herramienta {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  run: (input: Record<string, unknown>) => Promise<string>;
}

export interface Claude {
  /** Un pedido simple: instrucciones y datos → texto. */
  texto(p: Pedido, m: Medidor): Promise<{ text: string }>;
  /**
   * Lee páginas con la herramienta web_fetch de la API (la corre Anthropic) y responde con citas del documento.
   * `leidos`: las direcciones que abrió; `fallos`: los códigos de las que no pudo abrir.
   */
  leer(p: Pedido & { dominios: string[]; maxLecturas: number; maxTokensPorDocumento: number }, m: Medidor): Promise<{ text: string; citas: string[]; leidos: string[]; fallos: string[] }>;
  /** Pregunta con herramientas propias. `maxVueltas`: rondas de herramientas; en la última ya no puede pedir más datos. */
  conversar(p: Pedido & { herramientas: Herramienta[]; maxVueltas: number }, m: Medidor): Promise<{ text: string; usadas: string[] }>;
}

/** Respaldo del servidor si un filtro de seguridad rechaza el pedido: lo atiende otro modelo en la misma llamada. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Cuántas veces se retoma una lectura que la API pausó a la mitad (`pause_turn`). */
const MAX_PAUSAS = 2;
const CITA_MAX = 280;
const CITAS_MAX = 8;

const short = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

type Block = { type: string; text?: string; citations?: { cited_text?: string }[] | null };

/** El texto de una respuesta. Un rechazo o una respuesta vacía son errores; una cortada, también. */
function textoDe(res: { stop_reason: string | null; content: Block[] }, from = 0): string {
  if (res.stop_reason === 'refusal') throw new ApiError('upstream_error', 502, 'Claude no quiso responder a este pedido (filtro de seguridad).', 'claude');
  const text = res.content
    .slice(from)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
  if (res.stop_reason === 'max_tokens') throw new ApiError('upstream_error', 502, 'La respuesta de Claude quedó cortada. Prueba de nuevo.', 'claude');
  if (!text) throw new ApiError('bad_response', 502, 'Claude no devolvió una respuesta.', 'claude');
  return text;
}

/**
 * Claude por la API de Anthropic, con el SDK oficial. El SDK se carga recién al usarlo, así no pesa en el arranque de
 * las demás rutas.
 */
export function claudeApi(apiKey: string, model: string, opts: { fetch?: typeof fetch } = {}): Claude {
  const sdk = async () => {
    const { default: A } = await import('@anthropic-ai/sdk');
    // baseURL fijo: que una variable ANTHROPIC_BASE_URL del entorno no desvíe los datos a otro servidor.
    const client = new A({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 1, timeout: 240_000, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    return { A, client };
  };
  /** Los errores del SDK, como errores de Rueda (sin texto de la API que pueda traer datos de la cuenta). */
  const fail = (e: unknown, A: typeof Anthropic): never => {
    if (e instanceof ApiError) throw e;
    if (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError) {
      throw new ApiError('not_configured', 503, 'La clave de la API de Claude (ANTHROPIC_API_KEY) no es válida o no tiene permiso.', 'claude');
    }
    if (e instanceof A.RateLimitError) throw new ApiError('rate_limited', 429, 'Claude está saturado; prueba de nuevo en un rato.', 'claude');
    // 400: p. ej. sin saldo o tope de gasto de la consola alcanzado; el mensaje de Anthropic dice cuál.
    if (e instanceof A.BadRequestError) throw new ApiError('upstream_error', 502, `Claude rechazó el pedido: ${short(e.message, 200)}`, 'claude');
    if (e instanceof A.APIError) throw new ApiError('upstream_error', 502, `Claude respondió con un error (${e.status ?? 'sin respuesta'}).`, 'claude');
    throw e;
  };

  return {
    async texto(p, m) {
      const { A, client } = await sdk();
      try {
        const res = await client.beta.messages.create({
          model,
          max_tokens: p.maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: p.effort },
          system: p.system,
          messages: [{ role: 'user', content: p.user }],
        });
        medir(m, res);
        return { text: textoDe(res) };
      } catch (e) {
        return fail(e, A);
      }
    },

    async leer(p, m) {
      const { A, client } = await sdk();
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: p.user }];
      const leidos: string[] = [];
      const fallos: string[] = [];
      try {
        for (let pausa = 0; ; pausa++) {
          // Con transmisión: leer un informe largo tarda, y una conexión callada tanto rato se puede cortar.
          const res = await client.beta.messages
            .stream({
              model,
              max_tokens: p.maxTokens,
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
              output_config: { effort: p.effort },
              system: p.system,
              messages,
              tools: [
                {
                  // La versión simple de web_fetch, a propósito: abre la página tal cual (las más nuevas pueden filtrarla
                  // con código, y entonces no hay citas del documento) y el tope de tokens es el que se le pone aquí.
                  type: 'web_fetch_20250910',
                  name: 'web_fetch',
                  max_uses: p.maxLecturas,
                  allowed_domains: p.dominios,
                  max_content_tokens: p.maxTokensPorDocumento,
                  citations: { enabled: true },
                },
              ],
            })
            .finalMessage();
          medir(m, res);
          let last = -1;
          res.content.forEach((b, i) => {
            if (b.type !== 'web_fetch_tool_result') return;
            last = i;
            if (b.content.type === 'web_fetch_result') leidos.push(b.content.url);
            else fallos.push(b.content.error_code);
          });
          // La API pausó una lectura larga: se le devuelve lo que lleva y sigue donde quedó. Si en el medio cambió al
          // modelo de respaldo, no se retoma (devolverle ese turno tiene sus propias reglas).
          if (res.stop_reason === 'pause_turn' && pausa < MAX_PAUSAS && !res.content.some((b) => b.type === 'fallback')) {
            messages.push({ role: 'assistant', content: res.content });
            continue;
          }
          // El resumen es lo que escribe después de la última lectura (antes puede haber una frase suelta).
          const text = textoDe(res, last + 1);
          const cited = (res.content as Block[])
            .slice(last + 1)
            .flatMap((b) => (b.type === 'text' ? (b.citations ?? []) : []))
            .map((c) => short(c.cited_text ?? '', CITA_MAX))
            .filter((t) => t.length >= 20);
          return { text, citas: [...new Set(cited)].slice(0, CITAS_MAX), leidos, fallos };
        }
      } catch (e) {
        return fail(e, A);
      }
    },

    async conversar(p, m) {
      const { A, client } = await sdk();
      const tools = p.herramientas.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: p.user }];
      const usadas: string[] = [];
      try {
        // Vueltas a mano y no con el ayudante del SDK: así el tope de llamadas es exacto y, en la última, se le quitan
        // las herramientas (tool_choice «none») para que responda con lo que tiene. Sin respaldo ante rechazos: en un
        // ida y vuelta con herramientas, devolverle un turno del modelo de respaldo tiene sus propias reglas.
        for (let vuelta = 0; ; vuelta++) {
          const ultima = vuelta >= p.maxVueltas;
          const res = await client.beta.messages.create({
            model,
            max_tokens: p.maxTokens,
            output_config: { effort: p.effort },
            system: p.system,
            messages,
            tools,
            ...(ultima ? { tool_choice: { type: 'none' as const } } : {}),
          });
          medir(m, res);
          const calls = res.content.filter((b) => b.type === 'tool_use');
          if (ultima || res.stop_reason !== 'tool_use' || !calls.length) return { text: textoDe(res), usadas };
          messages.push({ role: 'assistant', content: res.content });
          // Todas las herramientas pedidas se corren a la vez y vuelven en un solo mensaje.
          const results = await Promise.all(
            calls.map(async (c) => {
              const tool = p.herramientas.find((t) => t.name === c.name);
              const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {};
              try {
                if (!tool) throw new ApiError('bad_request', 400, 'Esa herramienta no existe.');
                const content = await tool.run(input);
                usadas.push(tool.name);
                return { type: 'tool_result' as const, tool_use_id: c.id, content };
              } catch (e) {
                // A Claude se le dice que falló, con el motivo si es un error conocido de Rueda.
                return { type: 'tool_result' as const, tool_use_id: c.id, is_error: true, content: e instanceof ApiError ? e.message : 'No se pudo leer ese dato.' };
              }
            }),
          );
          messages.push({ role: 'user', content: results });
        }
      } catch (e) {
        return fail(e, A);
      }
    },
  };
}

/**
 * Desarrollo local sin clave: respuestas de prueba, sin llamar a la API. Cuenta un gasto inventado para que los topes
 * y el marcador se puedan ver funcionando.
 */
export function claudeMock(model: string): Claude {
  const gasto = (m: Medidor, input: number, output: number) => medir(m, { model, usage: { input_tokens: input, output_tokens: output } });
  return {
    async texto(p, m) {
      gasto(m, 3200, 900);
      const sym = /Símbolo: (\S+)/.exec(p.user)?.[1] ?? 'la acción';
      return {
        text: [
          `Respuesta de prueba (sin Claude): lo que más llama la atención de ${sym} es lo que pide el precio frente a su propia historia.`,
          '- Negocio: las ventas crecen y los márgenes se mantienen, según los números que mandó el panel.',
          '- Valoración: los múltiplos están sobre su mediana de 5 años; el crecimiento reciente explica una parte.',
          '- Riesgo: la volatilidad del último año es media y la tendencia sigue sobre la media de 200 días.',
          'Antes de decidir: qué parte del crecimiento viene del precio del cobre; cuánta deuda vence en dos años; qué dijo la gerencia en el último reporte.',
        ].join('\n'),
      };
    },
    async leer(p, m) {
      gasto(m, 14_000, 1100);
      const url = /Documento principal: (\S+)/.exec(p.user)?.[1] ?? 'https://www.sec.gov/';
      return {
        text: [
          'Lectura de prueba (sin Claude): ventas récord en el trimestre y guía sin cambios',
          '- Las ventas del trimestre subieron 12 % frente al mismo trimestre del año anterior, por mayor volumen y mejores precios.',
          '- El margen operativo pasó de 41 % a 44 %; la utilidad neta creció 18 %.',
          '- La caja de operaciones cubrió la inversión del periodo y el dividendo; la deuda neta bajó.',
          '- La gerencia mantiene su guía de producción para el año y anuncia más inversión en dos proyectos.',
          '- Riesgo que marca el reporte: un litigio ambiental en curso, sin provisión nueva.',
        ].join('\n'),
        citas: ['Net sales for the quarter increased 12% compared to the same period of the prior year, driven by higher sales volumes and metal prices.', 'We are maintaining our production guidance for the full year.'],
        leidos: [url],
        fallos: [],
      };
    },
    async conversar(p, m) {
      gasto(m, 6500, 420);
      const usadas: string[] = [];
      const first = p.herramientas[0];
      // Corre la primera herramienta, para probar que los datos llegan.
      if (first) {
        await first.run({}).then(
          () => usadas.push(first.name),
          () => {},
        );
      }
      return { text: 'Respuesta de prueba (sin Claude): en local no se llama a la API. La pregunta llegó bien y los datos públicos del panel respondieron.', usadas };
    },
  };
}
