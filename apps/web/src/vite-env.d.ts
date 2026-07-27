/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the runtime-derived app origin used in pasteable snippets. */
  readonly VITE_APP_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
