import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_KEY, SCHEMA_STAMP, readBootCache } from "./boot-cache.js";

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function record(v: number, snapshot: Record<string, unknown>): string {
  return JSON.stringify({ v, userId: "us_1", seq: 42, snapshot });
}

const goodList = { id: "ls_1", name: "Printing", statuses: [] };
const goodTask = { id: "tk_1", title: "Real", listId: "ls_1" };

describe("readBootCache", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards a cache written under the previous stamp", () => {
    localStorage.setItem(
      BOOT_KEY,
      record(SCHEMA_STAMP - 1, { tasks: [goodTask], lists: [goodList] })
    );
    expect(readBootCache()).toBeNull();
    expect(localStorage.getItem(BOOT_KEY)).toBeNull();
  });

  it("drops partial task and list rows but keeps the rest", () => {
    localStorage.setItem(
      BOOT_KEY,
      record(SCHEMA_STAMP, {
        tasks: [goodTask, { id: "tk_partial", statusId: "st_1" }, { id: "tk_nolist", title: "x" }],
        lists: [goodList, { id: "ls_partial", name: "Renamed" }],
      })
    );
    const cached = readBootCache();
    expect(cached?.seq).toBe(42);
    expect(cached?.snapshot.tasks.map((t) => t.id)).toEqual(["tk_1"]);
    expect(cached?.snapshot.lists.map((l) => l.id)).toEqual(["ls_1"]);
  });
});
