import { ClickUpClient } from "./clickup.js";
import { CheckpointStore } from "./checkpoint.js";
import { RateLimiter } from "./ratelimit.js";
import { resolveClickUpAuth } from "./env.js";
import { RAW, ensureDir, makePaths, readJsonIf, writeJson } from "./paths.js";
import { info, warn, progress, WarnTally } from "./log.js";
import { DEFAULT_SCOPE_DAYS, makeScope, selectInScope } from "./scope.js";
import type {
  CuAttachment,
  CuComment,
  CuFolder,
  CuList,
  CuSpace,
  CuTask,
  CuTeam,
  CuUser,
} from "./clickup-types.js";

export type ExtractOptions = {
  teamId: string;
  dataDir: string;
  scopeDays: number;
  envFile?: string;
  resume: boolean;
  /** Stop after N task pages — dry-run switch, no bulk crawl. */
  maxPages?: number;
  skipComments?: boolean;
  skipAttachments?: boolean;
};

type RawMeta = {
  teamId: string;
  extractedAt: number;
  scopeDays: number;
  cutoffMs: number;
  totalTasksSeen: number;
  inScopeTasks: number;
  requestCount: number;
};

export async function runExtract(opts: ExtractOptions): Promise<void> {
  const paths = makePaths(opts.dataDir);
  ensureDir(paths.raw);

  const auth = resolveClickUpAuth(opts.envFile);
  info(`ClickUp token loaded from ${auth.source} (${auth.baseUrl})`);
  const client = new ClickUpClient({
    token: auth.token,
    baseUrl: auth.baseUrl,
    limiter: new RateLimiter({ floor: 8 }),
  });

  const cp = new CheckpointStore(paths.rawFile(RAW.checkpoint), opts.teamId, !opts.resume);
  if (opts.resume && cp.value.taskPagesDone >= 0) {
    info(`resuming: task pages through ${cp.value.taskPagesDone}, ${cp.value.commentsDone.length} comment sets, ${cp.value.attachmentsDone.length} attachment sets done`);
  }
  const warnings = new WarnTally();
  const scope = makeScope(opts.scopeDays);

  // --- identity + hierarchy ------------------------------------------------
  if (!cp.value.stages.hierarchy) {
    const me = await client.authorizedUser();
    writeJson(paths.rawFile(RAW.user), me);
    info(`authenticated as ${me.user.username ?? me.user.email}`);

    const { teams } = await client.teams();
    const team = teams.find((t) => t.id === opts.teamId);
    if (!team) {
      throw new Error(
        `team ${opts.teamId} not visible to this token (saw: ${teams.map((t) => t.id).join(", ")})`
      );
    }
    writeJson(paths.rawFile(RAW.team), team);
    info(`team "${team.name}" with ${team.members.length} members`);

    const { spaces } = await client.spaces(opts.teamId, false);
    const archivedSpaces = await client.spaces(opts.teamId, true);
    const allSpaces: CuSpace[] = [
      ...spaces,
      ...archivedSpaces.spaces.map((s) => ({ ...s, archived: true })),
    ];
    writeJson(paths.rawFile(RAW.spaces), allSpaces);
    info(`${allSpaces.length} spaces (${archivedSpaces.spaces.length} archived)`);

    // Folders per space, archived included: the transform needs to see an
    // archived folder to know to skip its lists.
    const foldersBySpace: Record<string, CuFolder[]> = {};
    const listIds = new Set<string>();
    for (const s of allSpaces) {
      const live = await client.folders(s.id, false);
      const arch = await client.folders(s.id, true);
      const folders = [
        ...live.folders,
        ...arch.folders.map((f) => ({ ...f, archived: true })),
      ];
      foldersBySpace[s.id] = folders;
      for (const f of folders) for (const l of f.lists ?? []) listIds.add(l.id);

      const fl = await client.folderlessLists(s.id, false);
      const fla = await client.folderlessLists(s.id, true);
      for (const l of [...fl.lists, ...fla.lists]) listIds.add(l.id);
      info(`space "${s.name}": ${folders.length} folders, ${fl.lists.length + fla.lists.length} folderless lists`);
    }
    writeJson(paths.rawFile(RAW.folders), foldersBySpace);
    writeJson(paths.rawFile("list-ids.json"), [...listIds]);
    cp.mark((c) => {
      c.stages.hierarchy = true;
    });
    cp.flush();
  } else {
    info("hierarchy stage already complete; skipping");
  }

  // --- per-list detail (statuses) ------------------------------------------
  const listIds = readJsonIf<string[]>(paths.rawFile("list-ids.json")) ?? [];
  const lists: CuList[] = readJsonIf<CuList[]>(paths.rawFile(RAW.lists)) ?? [];
  if (!cp.value.stages.lists) {
    const done = new Set(cp.value.listsDone);
    const have = new Map(lists.map((l) => [l.id, l] as const));
    let n = 0;
    for (const id of listIds) {
      n++;
      if (done.has(id) && have.has(id)) continue;
      try {
        const l = await client.list(id);
        have.set(id, l);
        cp.mark((c) => c.listsDone.push(id));
      } catch (e) {
        warn(`list ${id} failed: ${(e as Error).message}`);
        warnings.add("list detail fetch failed", id);
      }
      progress("lists", n, listIds.length, 10);
    }
    const merged = [...have.values()];
    writeJson(paths.rawFile(RAW.lists), merged);
    lists.length = 0;
    lists.push(...merged);
    cp.mark((c) => {
      c.stages.lists = true;
    });
    cp.flush();
    info(`${merged.length} lists with resolved statuses`);
  } else {
    info(`lists stage already complete (${lists.length} lists); skipping`);
  }

  // --- tasks ---------------------------------------------------------------
  // The scope filter runs client-side: ClickUp cannot express
  // "open OR (closed AND recent)" as one query, so every page is fetched and
  // filtered here. Out-of-scope tasks are dropped before hitting disk.
  let tasks: CuTask[] = readJsonIf<CuTask[]>(paths.rawFile(RAW.tasks)) ?? [];
  let totalSeen = 0;
  if (!cp.value.stages.tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    let page = cp.value.taskPagesDone + 1;
    for (;;) {
      if (opts.maxPages !== undefined && page >= opts.maxPages) {
        info(`stopping at page ${page} (--max-pages ${opts.maxPages}); tasks stage left OPEN for resume`);
        break;
      }
      const res = await client.teamTasksPage(opts.teamId, page);
      const batch = res.tasks ?? [];
      totalSeen += batch.length;
      for (const t of batch) byId.set(t.id, t);
      cp.mark((c) => {
        c.taskPagesDone = page;
      });
      // Persist every page so a crash costs at most one page of work.
      writeJson(paths.rawFile("tasks.partial.json"), [...byId.values()]);
      info(`task page ${page}: +${batch.length} (${byId.size} cumulative)`);
      if (batch.length === 0 || res.last_page === true) {
        cp.mark((c) => {
          c.stages.tasks = true;
        });
        break;
      }
      page++;
    }
    const all = [...byId.values()];
    const keep = selectInScope(all, scope);
    tasks = all.filter((t) => keep.has(t.id));
    writeJson(paths.rawFile(RAW.tasks), tasks);
    writeJson(paths.rawFile("tasks-out-of-scope-ids.json"), all.filter((t) => !keep.has(t.id)).map((t) => t.id));
    info(`scope filter (${opts.scopeDays}d): kept ${tasks.length} of ${all.length} tasks`);
    cp.flush();
  } else {
    info(`tasks stage already complete (${tasks.length} in-scope tasks); skipping`);
  }

  // --- comments (in-scope tasks only) --------------------------------------
  const commentsByTask: Record<string, CuComment[]> =
    readJsonIf<Record<string, CuComment[]>>(paths.rawFile(RAW.comments)) ?? {};
  if (!opts.skipComments && !cp.value.stages.comments) {
    const done = new Set(cp.value.commentsDone);
    let n = 0;
    let withComments = 0;
    for (const t of tasks) {
      n++;
      if (done.has(t.id)) continue;
      try {
        const cs = await client.allComments(t.id);
        if (cs.length > 0) {
          commentsByTask[t.id] = cs;
          withComments++;
        }
      } catch (e) {
        warn(`comments for ${t.id} failed: ${(e as Error).message}`);
        warnings.add("comment fetch failed", t.id);
      }
      cp.mark((c) => c.commentsDone.push(t.id));
      if (n % 100 === 0) writeJson(paths.rawFile(RAW.comments), commentsByTask);
      progress("comments", n, tasks.length, 50);
    }
    writeJson(paths.rawFile(RAW.comments), commentsByTask);
    cp.mark((c) => {
      c.stages.comments = true;
    });
    cp.flush();
    info(`comments fetched for ${withComments} tasks this run`);
  } else if (opts.skipComments) {
    info("comments stage skipped by flag");
  }

  // --- attachments (in-scope tasks only) ----------------------------------
  // Attachment metadata only comes back on GET /task/{id}, so this is one
  // request per in-scope task. Bytes are streamed later, during load.
  const attachmentsByTask: Record<string, CuAttachment[]> =
    readJsonIf<Record<string, CuAttachment[]>>(paths.rawFile(RAW.attachments)) ?? {};
  if (!opts.skipAttachments && !cp.value.stages.attachments) {
    const done = new Set(cp.value.attachmentsDone);
    let n = 0;
    let found = 0;
    for (const t of tasks) {
      n++;
      if (done.has(t.id)) continue;
      try {
        const atts = await client.attachments(t.id);
        if (atts.length > 0) {
          attachmentsByTask[t.id] = atts;
          found += atts.length;
        }
      } catch (e) {
        warn(`attachments for ${t.id} failed: ${(e as Error).message}`);
        warnings.add("attachment fetch failed", t.id);
      }
      cp.mark((c) => c.attachmentsDone.push(t.id));
      if (n % 100 === 0) writeJson(paths.rawFile(RAW.attachments), attachmentsByTask);
      progress("attachments", n, tasks.length, 50);
    }
    writeJson(paths.rawFile(RAW.attachments), attachmentsByTask);
    cp.mark((c) => {
      c.stages.attachments = true;
    });
    cp.flush();
    info(`${found} attachments found this run`);
  } else if (opts.skipAttachments) {
    info("attachments stage skipped by flag");
  }

  const meta: RawMeta = {
    teamId: opts.teamId,
    extractedAt: Date.now(),
    scopeDays: opts.scopeDays,
    cutoffMs: scope.cutoffMs,
    totalTasksSeen: totalSeen,
    inScopeTasks: tasks.length,
    requestCount: client.requestCount,
  };
  writeJson(paths.rawFile(RAW.meta), meta);
  warnings.flush();
  info(
    `extract done: ${tasks.length} tasks, ${Object.keys(commentsByTask).length} tasks with comments, ` +
      `${Object.keys(attachmentsByTask).length} with attachments, ${client.requestCount} API requests`
  );
}

export function defaultExtractOptions(teamId: string): ExtractOptions {
  return {
    teamId,
    dataDir: "./data",
    scopeDays: DEFAULT_SCOPE_DAYS,
    resume: true,
  };
}

export type { CuUser, CuTeam };
