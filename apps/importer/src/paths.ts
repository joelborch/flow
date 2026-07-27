import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DATA_DIR = "./data";

export type Paths = {
  root: string;
  raw: string;
  flow: string;
  rawFile(name: string): string;
  flowFile(name: string): string;
};

export function makePaths(dataDir = DEFAULT_DATA_DIR): Paths {
  const root = resolve(dataDir);
  const raw = join(root, "raw");
  const flow = join(root, "flow");
  return {
    root,
    raw,
    flow,
    rawFile: (name) => join(raw, name),
    flowFile: (name) => join(flow, name),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Atomic write: temp file then rename, so a crash never leaves half JSON. */
export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIf<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return readJson<T>(path);
  } catch {
    return null;
  }
}

// Raw (pass 1) file names.
export const RAW = {
  meta: "meta.json",
  user: "user.json",
  team: "team.json",
  spaces: "spaces.json",
  folders: "folders.json",
  lists: "lists.json",
  tasks: "tasks.json",
  comments: "comments.json",
  attachments: "attachments.json",
  checkpoint: "checkpoint.json",
} as const;

// Flow (pass 2) file names.
export const FLOW = {
  users: "users.json",
  spaces: "spaces.json",
  lists: "lists.json",
  tasks: "tasks.json",
  subtasks: "subtasks.json",
  comments: "comments.json",
  attachments: "attachments.json",
  idmap: "idmap.json",
  report: "report.json",
  loaded: "loaded.json",
} as const;
