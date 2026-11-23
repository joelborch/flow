import type { DatabaseSync } from "node:sqlite";
import type { MigrationTxn } from "./schema.js";

export interface StoredObject {
  key: string;
  body: ArrayBuffer;
}

/**
 * Node `node:sqlite` adapter implementing the worker `SqlStorage` contract
 * (including `RETURNING`, `raw()`, and `columnNames` for `runReadOnlyQuery`).
 */
export function sqliteStorage(db: DatabaseSync, log?: string[]): SqlStorage {
  const exec = (query: string, ...params: unknown[]): unknown => {
    log?.push(query);
    const returnsRows = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query);
    if (!returnsRows) {
      const result = db.prepare(query).run(...(params as never[])) as { changes?: number | bigint };
      return {
        toArray: () => [],
        one: () => undefined,
        rowsWritten: Number(result.changes ?? 0),
        raw: () => [][Symbol.iterator](),
        columnNames: [],
      };
    }
    const rows = db.prepare(query).all(...(params as never[]));
    return {
      raw: () => {
        const arrays = db.prepare(query);
        arrays.setReturnArrays(true);
        return (arrays.all(...(params as never[])) as unknown as unknown[][])[Symbol.iterator]();
      },
      get columnNames() {
        return db.prepare(query).columns().map((c) => c.name);
      },
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
        return rows[0];
      },
    };
  };
  return { exec } as unknown as SqlStorage;
}

/** Savepoint-backed `transactionSync` matching workerd's throws-roll-back contract. */
export function savepointTxn(db: DatabaseSync): MigrationTxn & (<T>(fn: () => T) => T) {
  return <T,>(fn: () => T): T => {
    db.prepare("SAVEPOINT _txn").run();
    try {
      const result = fn();
      db.prepare("RELEASE _txn").run();
      return result;
    } catch (err) {
      db.prepare("ROLLBACK TO _txn").run();
      db.prepare("RELEASE _txn").run();
      throw err;
    }
  };
}

export interface FakeCtxOptions {
  sockets?: WebSocket[];
  pending?: Promise<unknown>[];
  events?: string[];
  getAlarm?: () => Promise<number | null>;
  setAlarm?: (scheduledTime: number | Date) => Promise<void>;
  deleteAll?: () => Promise<void>;
  deleteAlarm?: () => Promise<void>;
}

/** Minimal `DurableObjectState` stub over `DatabaseSync` for tests. */
export function fakeCtx(db: DatabaseSync, opts: FakeCtxOptions = {}): DurableObjectState {
  const sockets = opts.sockets ?? [];
  return {
    id: { toString: () => "do_test" },
    storage: {
      sql: sqliteStorage(db),
      getAlarm: opts.getAlarm ?? (async () => null),
      setAlarm: opts.setAlarm ?? (async () => undefined),
      ...(opts.deleteAll ? { deleteAll: opts.deleteAll } : {}),
      ...(opts.deleteAlarm ? { deleteAlarm: opts.deleteAlarm } : {}),
      ...(opts.events
        ? {
            sync: async () => {
              opts.events!.push("sync");
            },
          }
        : {}),
      transactionSync: savepointTxn(db),
    },
    blockConcurrencyWhile: async <T,>(fn: () => Promise<T> | T): Promise<T> => fn(),
    waitUntil: (promise: Promise<unknown>) => {
      opts.pending?.push(promise);
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: WebSocket) => {
      sockets.push(ws);
    },
  } as unknown as DurableObjectState;
}

/** In-memory `R2Bucket` implementing `put`, `list`, and `delete` for backup/cleanup tests. */
export function fakeR2Bucket(events?: string[]) {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async put(key: string, value: ArrayBuffer) {
      events?.push("put");
      objects.set(key, { key, body: value });
      return undefined;
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const matches = [...objects.values()]
        .filter((o) => o.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { objects: matches.map((o) => ({ key: o.key })), truncated: false, cursor: undefined };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}
