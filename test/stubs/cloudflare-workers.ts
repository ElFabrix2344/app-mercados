// Sustituto mínimo de `cloudflare:workers` para correr las pruebas en Node (vitest).
// La librería OAuth solo lo usa para reconocer handlers escritos como clase; los nuestros son objetos.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: Env,
  ) {}
}
