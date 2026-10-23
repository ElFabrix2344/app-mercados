/**
 * KV en memoria con lo que usan la app y la librería OAuth (get texto/json, getWithMetadata, put con metadata,
 * delete, list por prefijo con la metadata de cada clave).
 */
export function memoryKV(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const meta = new Map<string, unknown>();
  let writes = 0;
  const read = (key: string, type?: string | { type?: string }) => {
    const v = store.get(key);
    if (v === undefined) return null;
    const t = typeof type === 'string' ? type : type?.type;
    return t === 'json' ? JSON.parse(v) : v;
  };
  const kv = {
    async get(key: string, type?: string | { type?: string }) {
      return read(key, type);
    },
    async getWithMetadata(key: string, type?: string | { type?: string }) {
      return { value: read(key, type), metadata: meta.get(key) ?? null, cacheStatus: null };
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      writes++;
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, opts.metadata);
      else meta.delete(key);
    },
    async delete(key: string) {
      store.delete(key);
      meta.delete(key);
    },
    async list(opts: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(opts.prefix ?? ''))
        .sort()
        .map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
  return { kv: kv as unknown as KVNamespace, store, meta, writes: () => writes };
}

/** fetch falso: responde con la función dada y registra las URLs pedidas. */
export function fakeFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const calls: URL[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}
