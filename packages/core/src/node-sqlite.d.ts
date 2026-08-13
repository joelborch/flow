// This package typechecks against @cloudflare/workers-types only — pulling in
// @types/node for one test would clash with the workers globals — so the small
// slice of node:sqlite that sync-floor.test.ts uses is declared here. The
// runtime module ships with Node >= 22; vitest runs on plain node (see
// vitest.config.ts), where it resolves for real.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): Array<Record<string, unknown>>;
    };
  }
}
