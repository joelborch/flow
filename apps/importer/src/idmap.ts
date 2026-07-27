import { createHash } from "node:crypto";

// Flow ids are short prefixed nanoids (see packages/shared entities.ts). The
// importer cannot use random nanoids: a re-run must produce byte-identical
// output so re-loading is an upsert and not a duplicate import. So ids are
// DERIVED — sha256(kind + ":" + clickupKey), rendered in the nanoid alphabet.
// The map file is still persisted, because link rewriting and the load pass
// need clickupId -> flowId lookups, and because a human debugging a bad import
// wants to grep the correspondence.

export type IdKind = "space" | "list" | "status" | "task" | "subtask" | "comment" | "attachment" | "user";

export const ID_PREFIX: Record<IdKind, string> = {
  space: "sp",
  list: "ls",
  status: "st",
  task: "tk",
  subtask: "sb",
  comment: "cm",
  attachment: "at",
  user: "us",
};

// nanoid's default url-safe alphabet, minus look-alikes, so ids stay easy to
// read aloud and to paste out of logs.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LEN = 12;

/** Deterministic, collision-resistant id for a ClickUp entity. */
export function deriveId(kind: IdKind, clickupKey: string): string {
  const digest = createHash("sha256").update(`flow:${kind}:${clickupKey}`).digest();
  let out = "";
  for (let i = 0; i < ID_LEN; i++) {
    // Non-null: sha256 digest is 32 bytes and ID_LEN is 12.
    out += ALPHABET[digest[i]! % ALPHABET.length];
  }
  return `${ID_PREFIX[kind]}_${out}`;
}

export type IdMapFile = {
  version: 1;
  /** Written once, reused forever, so synthesized createdAt values are stable. */
  importedAt: number;
  entries: Record<string, string>;
};

/**
 * Records every derived id. Because derivation is pure, the map is a cache and
 * an audit trail rather than a source of truth — a lost map file changes
 * nothing about the output.
 */
export class IdMap {
  readonly importedAt: number;
  private entries: Map<string, string>;

  constructor(existing?: IdMapFile | null) {
    this.importedAt = existing?.importedAt ?? Date.now();
    this.entries = new Map(Object.entries(existing?.entries ?? {}));
  }

  id(kind: IdKind, clickupKey: string): string {
    const mapKey = `${kind}:${clickupKey}`;
    const cached = this.entries.get(mapKey);
    if (cached) return cached;
    const derived = deriveId(kind, clickupKey);
    this.entries.set(mapKey, derived);
    return derived;
  }

  /** Lookup without creating; used by the link rewriter. */
  peek(kind: IdKind, clickupKey: string): string | null {
    return this.entries.get(`${kind}:${clickupKey}`) ?? null;
  }

  toFile(): IdMapFile {
    return {
      version: 1,
      importedAt: this.importedAt,
      entries: Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
  }
}
