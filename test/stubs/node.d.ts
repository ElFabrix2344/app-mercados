// Lo poco de Node que usan las pruebas que leen archivos de public/ (el proyecto solo tiene los tipos de Workers).
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
}

interface ImportMeta {
  readonly url: string;
}
