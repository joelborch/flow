/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the runtime-derived app origin used in pasteable snippets. */
  readonly VITE_APP_ORIGIN?: string;
  /** "true" builds the static, read-only demo (see src/lib/demo.ts). */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
