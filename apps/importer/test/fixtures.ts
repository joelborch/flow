import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CuAttachment,
  CuComment,
  CuFolder,
  CuList,
  CuSpace,
  CuStatus,
  CuTask,
  CuTeam,
} from "../src/clickup-types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

// Fully synthetic fixtures for a fictional "Acme Web Studio" workspace, shaped
// after real ClickUp v2 API responses (same fields, same structural quirks:
// per-list statuses, hidden folder wrappers, string timestamps, the "Google
// Doc" custom-field template). The task set covers every quirk the transform
// has to survive; each task carries a `_fixtureReason`.
export const realTasks = (): (CuTask & { _fixtureReason: string })[] =>
  load("clickup-tasks.json");
export const realLists = (): CuList[] => load("clickup-lists.json");
export const realSpaces = (): CuSpace[] => load("clickup-spaces.json");
export const realFolders = (): Record<string, CuFolder[]> => load("clickup-folders.json");
export const realComments = (): Record<string, CuComment[]> => load("clickup-comments.json");
export const realAttachments = (): Record<string, CuAttachment[]> =>
  load("clickup-attachments.json");
export const realTeam = (): CuTeam => load("clickup-team.json");

export function taskByReason(reason: string): CuTask {
  const t = realTasks().find((x) => x._fixtureReason === reason);
  if (!t) throw new Error(`no fixture task with reason "${reason}"`);
  return t;
}

export function listByName(name: string): CuList {
  const l = realLists().find((x) => x.name.trim() === name);
  if (!l) throw new Error(`no fixture list named "${name}"`);
  return l;
}

// --- constructed edge cases ------------------------------------------------
// The fixture workspace is clean in these respects (every list has exactly one
// open first and one closed last, and no folder is archived), so these paths
// are defensive and need constructed input to exercise.

export function cuStatus(status: string, type: string, orderindex: number, color = "#888888"): CuStatus {
  return { id: `s_${status.replace(/\W+/g, "_")}_${orderindex}`, status, orderindex, color, type };
}

export function synthList(over: Partial<CuList> & { id: string }): CuList {
  return {
    name: "Synthetic List",
    orderindex: 0,
    archived: false,
    statuses: [cuStatus("to do", "open", 0), cuStatus("done", "closed", 1)],
    space: { id: "sp_synth", name: "Synth Space" },
    ...over,
  };
}

export function synthFolder(over: Partial<CuFolder> & { id: string }): CuFolder {
  return {
    name: "Synthetic Folder",
    orderindex: 0,
    hidden: false,
    archived: false,
    lists: [],
    space: { id: "sp_synth" },
    ...over,
  };
}
