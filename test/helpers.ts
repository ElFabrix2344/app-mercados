/** KV en memoria con lo mínimo que usa la app (get texto/json y put). */
export function memoryKV(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  let writes = 0;
  const kv = {
    async get(key: string, type?: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      writes++;
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, writes: () => writes };
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
