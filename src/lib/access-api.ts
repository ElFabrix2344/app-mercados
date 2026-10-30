// Cloudflare Access por API: copia la lista de «Personas» de Rueda a la política que deja entrar a la app, para que
// Cloudflare les mande el código por correo. Solo se reescriben las reglas «Emails» de una política: la que se llama
// «Personas de Rueda» o, si no hay, la única de la app que deja entrar por correo. Lo demás no se toca.
// El token necesita un solo permiso: «Access: Apps and Policies → Edit», en la cuenta de Rueda.
// https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/

import { ApiError } from './http';

const API = 'https://api.cloudflare.com/client/v4';
export const POLICY_NAME = 'Personas de Rueda';

type Rule = Record<string, unknown>;

export interface Policy {
  id: string;
  name?: string;
  decision?: string;
  include?: Rule[];
  precedence?: number;
  /** false: política solo de esta app (se reescribe por otra ruta). */
  reusable?: boolean;
  [field: string]: unknown;
}

interface App {
  id: string;
  aud?: string;
}

/** Lo que se vuelve a mandar al reescribir una política: así no se pierde ningún ajuste hecho en el panel. */
const POLICY_FIELDS = [
  'name',
  'decision',
  'include',
  'exclude',
  'require',
  'approval_groups',
  'approval_required',
  'isolation_required',
  'purpose_justification_required',
  'purpose_justification_prompt',
  'session_duration',
  'mfa_config',
  'connection_rules',
];

export interface AccessSync {
  /** Nombre de la política que se tocó. */
  policy: string;
  added: string[];
  removed: string[];
}

class CfError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function cf<T>(f: typeof fetch, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await f(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || !data?.success) {
    const msg = (data?.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
    throw new CfError(res.status, msg || `HTTP ${res.status}`);
  }
  return data.result as T;
}

const emailOf = (r: Rule): string | null => {
  const e = (r as { email?: { email?: unknown } }).email;
  return e && typeof e.email === 'string' ? e.email.toLowerCase() : null;
};

/** La política que maneja Rueda: la que se llama «Personas de Rueda» o, si no hay, la única que deja entrar por correo. */
export function pickPolicy(policies: Policy[]): Policy {
  const allow = policies.filter((p) => p.decision === 'allow');
  const named = allow.find((p) => (p.name ?? '').trim().toLowerCase() === POLICY_NAME.toLowerCase());
  if (named) return named;
  const withEmails = allow.filter((p) => (p.include ?? []).some((r) => emailOf(r)));
  if (withEmails.length === 1) return withEmails[0]!;
  if (!withEmails.length && allow.length === 1) return allow[0]!;
  throw new ApiError(
    'bad_request',
    409,
    allow.length
      ? `No sé en cuál política de Access poner los correos: ponle «${POLICY_NAME}» de nombre a la que deja entrar a tus amigos.`
      : 'La app de Access no tiene ninguna política que deje entrar.',
  );
}

/** Deja en la política de Rueda exactamente estos correos (las otras reglas quedan igual). */
export async function syncAccessEmails(o: {
  token: string;
  accountId: string;
  aud: string;
  emails: string[];
  fetch?: typeof fetch;
}): Promise<AccessSync> {
  const f = o.fetch ?? fetch;
  const emails = [...new Set(o.emails.map((e) => e.toLowerCase()))];
  // Nunca se deja la política sin correos: sería sacar a todos, también al dueño.
  if (!emails.length) throw new ApiError('bad_request', 400, 'No hay correos para copiar a Access.');
  const base = `/accounts/${encodeURIComponent(o.accountId)}/access`;
  try {
    const app = (await cf<App[]>(f, o.token, 'GET', `${base}/apps?per_page=1000`)).find((a) => a.aud === o.aud);
    if (!app) throw new ApiError('not_found', 404, 'No encontré la app de Access de Rueda en esta cuenta.');
    const appBase = `${base}/apps/${encodeURIComponent(app.id)}/policies`;
    const policy = pickPolicy(await cf<Policy[]>(f, o.token, 'GET', `${appBase}?per_page=1000`));
    const include = policy.include ?? [];
    const before = include.map(emailOf).filter((e): e is string => e !== null);
    const added = emails.filter((e) => !before.includes(e));
    const removed = before.filter((e) => !emails.includes(e));
    const name = policy.name ?? POLICY_NAME;
    if (!added.length && !removed.length) return { policy: name, added, removed };

    const body: Record<string, unknown> = {};
    for (const k of POLICY_FIELDS) if (policy[k] !== undefined) body[k] = policy[k];
    body.include = [...include.filter((r) => emailOf(r) === null), ...emails.map((email) => ({ email: { email } }))];
    const own = `${appBase}/${encodeURIComponent(policy.id)}`;
    const ownBody = { ...body, precedence: policy.precedence };
    if (policy.reusable === false) await cf(f, o.token, 'PUT', own, ownBody);
    else {
      try {
        await cf(f, o.token, 'PUT', `${base}/policies/${encodeURIComponent(policy.id)}`, body);
      } catch (e) {
        // Si la respuesta no dijo de qué tipo es, puede ser una política solo de esta app: se prueba por su ruta.
        if (policy.reusable !== undefined || !(e instanceof CfError) || e.status === 401 || e.status === 403) throw e;
        await cf(f, o.token, 'PUT', own, ownBody);
      }
    }
    return { policy: name, added, removed };
  } catch (e) {
    if (!(e instanceof CfError)) throw e;
    if (e.status === 401 || e.status === 403) {
      throw new ApiError('upstream_error', 502, 'Cloudflare rechazó el token: necesita el permiso «Access: Apps and Policies → Edit» en la cuenta de Rueda.');
    }
    throw new ApiError('upstream_error', 502, `Cloudflare respondió: ${e.message}`.slice(0, 300));
  }
}
