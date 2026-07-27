import { readJsonIf, writeJson } from "./paths.js";

/**
 * Extract checkpoint. Written after every completed unit of work so a crashed
 * or rate-limited crawl resumes where it stopped instead of re-walking 4,700
 * tasks. Stages complete in order; task detail work is tracked per task id.
 */
export type Checkpoint = {
  version: 1;
  teamId: string;
  startedAt: number;
  updatedAt: number;
  stages: {
    hierarchy: boolean;
    lists: boolean;
    tasks: boolean;
    comments: boolean;
    attachments: boolean;
  };
  /** Highest fully-written team task page, so tasks resume mid-pagination. */
  taskPagesDone: number;
  listsDone: string[];
  commentsDone: string[];
  attachmentsDone: string[];
};

export function emptyCheckpoint(teamId: string): Checkpoint {
  const now = Date.now();
  return {
    version: 1,
    teamId,
    startedAt: now,
    updatedAt: now,
    stages: {
      hierarchy: false,
      lists: false,
      tasks: false,
      comments: false,
      attachments: false,
    },
    taskPagesDone: -1,
    listsDone: [],
    commentsDone: [],
    attachmentsDone: [],
  };
}

export class CheckpointStore {
  private data: Checkpoint;
  private dirty = false;
  private lastFlush = 0;

  constructor(private readonly path: string, teamId: string, reset = false) {
    const existing = reset ? null : readJsonIf<Checkpoint>(path);
    this.data =
      existing && existing.version === 1 && existing.teamId === teamId
        ? existing
        : emptyCheckpoint(teamId);
  }

  get value(): Checkpoint {
    return this.data;
  }

  mark(fn: (c: Checkpoint) => void): void {
    fn(this.data);
    this.data.updatedAt = Date.now();
    this.dirty = true;
    // Throttle disk writes; a checkpoint that lags 2s costs at most a few
    // re-fetched tasks on resume.
    if (Date.now() - this.lastFlush > 2_000) this.flush();
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(this.path, this.data);
    this.dirty = false;
    this.lastFlush = Date.now();
  }
}
