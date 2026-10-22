import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // En Node no existe el módulo del runtime de Workers; ver test/stubs/cloudflare-workers.ts.
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    // La librería OAuth es ESM: que vitest la procese para que se aplique el alias de arriba.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
