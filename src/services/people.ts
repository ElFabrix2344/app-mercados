// Personas que pueden entrar a Rueda además del dueño. Las agrega y quita el dueño desde el panel («Personas»): la
// lista vive en un solo registro de KV y cada cambio se copia a Cloudflare Access (lib/access-api.ts), que es quien
// les manda el código por correo. Rueda igual revisa su lista en cada pedido: es la segunda capa, por si la regla de
// Access quedara abierta por error. Antes la lista era el secreto ALLOWED_EMAILS: mientras el registro no exista se
// usa ese secreto, y el primer cambio lo pasa a KV. Los dueños (OWNER_EMAILS) siempre entran y no se listan.

import type { Env } from '../env';
import { syncAccessEmails } from '../lib/access-api';
import { ApiError } from '../lib/http';

export const PEOPLE_KEY = 'personas';
/** Es una app para un grupo de amigos. */
export const MAX_PEOPLE = 50;
/** Cuánto recuerda cada instancia del Worker la lista (se consulta en cada pedido, también los del HTML). */
const MEMO_MS = 30_000;

export interface Person {
  email: string;
  /** null si venía del secreto ALLOWED_EMAILS. */
  addedAt: string | null;
}

/** El último intento de copiar la lista a Cloudflare Access. */
export interface SyncState {
  ok: boolean;
  at: string;
  /** Qué falló, dicho para el dueño. */
  message: string | null;
  /** Política de Access que se tocó. */
  policy: string | null;
  added: string[];
  removed: string[];
}

export interface PeopleStore {
  people: Person[];
  sync: SyncState | null;
}

export interface PeopleView extends PeopleStore {
  max: number;
  /** La lista todavía sale de ALLOWED_EMAILS: el primer cambio la pasa a Rueda. */
  fromSecret: boolean;
  access: {
    /** Hay token para escribir en Access. Si no, cada correo se agrega también a mano en el panel de Cloudflare. */
    connected: boolean;
    /** Aplicaciones de Access en el panel de Cloudflare. */
    url: string | null;
  };
}

/** Correos separados por comas, en minúsculas y sin repetir. */
export const emailList = (raw: string | undefined): string[] => [
  ...new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

const EMAIL_RE = /^[^\s@,;:<>()[\]"'\\]+@[^\s@,;:<>()[\]"'\\]+\.[a-z]{2,}$/;

export function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ApiError('bad_request', 400, 'Escribe un correo válido, como nombre@gmail.com.');
  return email;
}

const memo = new WeakMap<KVNamespace, { at: number; store: PeopleStore | null }>();

export async function readPeople(kv: KVNamespace | undefined, fresh = false): Promise<PeopleStore | null> {
  if (!kv) return null;
  const hit = memo.get(kv);
  if (!fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.store;
  const raw = await kv.get<PeopleStore>(PEOPLE_KEY, 'json');
  const store = raw && Array.isArray(raw.people) ? { people: raw.people, sync: raw.sync ?? null } : null;
  memo.set(kv, { at: Date.now(), store });
  return store;
}

/** ¿Puede entrar este correo? Los dueños, siempre; el resto, si está en la lista. Falla cerrado si KV no responde. */
export async function canEnter(env: Env, email: string): Promise<boolean> {
  if (emailList(env.OWNER_EMAILS).includes(email)) return true;
  try {
    const store = await readPeople(env.CACHE);
    return (store ? store.people.map((p) => p.email) : emailList(env.ALLOWED_EMAILS)).includes(email);
  } catch (e) {
    console.error('Lista de personas:', e);
    return false;
  }
}

export async function peopleView(env: Env, store?: PeopleStore | null): Promise<PeopleView> {
  const s = store === undefined ? await readPeople(env.CACHE, true) : store;
  const owners = emailList(env.OWNER_EMAILS);
  const people = s?.people ?? emailList(env.ALLOWED_EMAILS).filter((email) => !owners.includes(email)).map((email) => ({ email, addedAt: null }));
  return {
    people,
    sync: s?.sync ?? null,
    max: MAX_PEOPLE,
    fromSecret: !s,
    access: {
      connected: Boolean(env.ACCESS_API_TOKEN && env.CF_ACCOUNT_ID && env.ACCESS_AUD),
      url: env.CF_ACCOUNT_ID ? `https://dash.cloudflare.com/${env.CF_ACCOUNT_ID}/one/access/apps` : null,
    },
  };
}

const emailFrom = (body: unknown) => normalizeEmail((body as { email?: unknown } | null)?.email);

export async function addPerson(env: Env, body: unknown, now: Date, f?: typeof fetch): Promise<PeopleView> {
  const email = emailFrom(body);
  if (emailList(env.OWNER_EMAILS).includes(email)) throw new ApiError('bad_request', 400, 'Ese correo es tuyo: ya entras como dueño.');
  const { people } = await peopleView(env);
  if (people.some((p) => p.email === email)) throw new ApiError('bad_request', 400, 'Ese correo ya está en la lista.');
  if (people.length >= MAX_PEOPLE) throw new ApiError('bad_request', 400, `Máximo ${MAX_PEOPLE} personas.`);
  return save(env, [...people, { email, addedAt: now.toISOString() }], now, f);
}

export async function removePerson(env: Env, body: unknown, now: Date, f?: typeof fetch): Promise<PeopleView> {
  const email = emailFrom(body);
  const { people } = await peopleView(env);
  if (!people.some((p) => p.email === email)) throw new ApiError('not_found', 404, 'Ese correo no está en la lista.');
  return save(env, people.filter((p) => p.email !== email), now, f);
}

/** Vuelve a copiar la lista a Access (después de cargar el token o si falló la última vez). */
export async function syncPeople(env: Env, now: Date, f?: typeof fetch): Promise<PeopleView> {
  return save(env, (await peopleView(env)).people, now, f);
}

async function save(env: Env, people: Person[], now: Date, f?: typeof fetch): Promise<PeopleView> {
  const store: PeopleStore = { people, sync: await copyToAccess(env, people, now, f) };
  await env.CACHE.put(PEOPLE_KEY, JSON.stringify(store));
  memo.set(env.CACHE, { at: Date.now(), store });
  return peopleView(env, store);
}

/** Copia la lista (con los dueños) a Access. Sin token no hace nada: el dueño agrega el correo a mano. Nunca lanza. */
async function copyToAccess(env: Env, people: Person[], now: Date, f?: typeof fetch): Promise<SyncState | null> {
  if (!env.ACCESS_API_TOKEN || !env.CF_ACCOUNT_ID || !env.ACCESS_AUD) return null;
  const at = now.toISOString();
  try {
    const r = await syncAccessEmails({
      token: env.ACCESS_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      aud: env.ACCESS_AUD,
      emails: [...emailList(env.OWNER_EMAILS), ...people.map((p) => p.email)],
      fetch: f,
    });
    return { ok: true, at, message: null, ...r };
  } catch (e) {
    if (!(e instanceof ApiError)) console.error('Copiar personas a Access:', e);
    const message = e instanceof ApiError ? e.message : 'Cloudflare no respondió. Prueba de nuevo en un rato.';
    return { ok: false, at, message, policy: null, added: [], removed: [] };
  }
}
