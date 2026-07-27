import { FlowClient, type BatchKind } from "./flow-client.js";
import { FLOW, makePaths, readJsonIf, writeJson } from "./paths.js";
import { info, progress, warn } from "./log.js";
import type { AttachmentImport, FlowBundle } from "./transform.js";

export type LoadOptions = {
  dataDir: string;
  apiBase: string;
  apiKey: string;
  batchSize: number;
  dryRun: boolean;
  skipAttachments?: boolean;
};

// Referential order. Users first (tasks reference assignees), then the
// hierarchy top-down, then tasks, then everything hanging off a task.
const ORDER: BatchKind[] = ["users", "spaces", "lists", "tasks", "subtasks", "comments"];

type LoadedState = {
  version: 1;
  /** Flow ids already accepted, per kind, so a resumed run skips them. */
  ids: Record<string, string[]>;
  attachments: string[];
};

function emptyLoaded(): LoadedState {
  return { version: 1, ids: {}, attachments: [] };
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function runLoad(opts: LoadOptions): Promise<void> {
  const paths = makePaths(opts.dataDir);
  const bundle = readBundle((name) => paths.flowFile(name));
  const loadedPath = paths.flowFile(FLOW.loaded);
  const loaded = readJsonIf<LoadedState>(loadedPath) ?? emptyLoaded();

  const client = new FlowClient({
    apiBase: opts.apiBase,
    apiKey: opts.apiKey,
    dryRun: opts.dryRun,
  });
  info(
    `${opts.dryRun ? "DRY RUN — " : ""}loading into ${opts.apiBase} ` +
      `(batch size ${opts.batchSize})`
  );

  for (const kind of ORDER) {
    const rows = bundle[kind] as { id: string }[];
    const already = new Set(loaded.ids[kind] ?? []);
    const pending = rows.filter((r) => !already.has(r.id));
    if (pending.length === 0) {
      info(`${kind}: nothing to do (${rows.length} already loaded)`);
      continue;
    }
    info(`${kind}: ${pending.length} to load (${rows.length - pending.length} already done)`);
    let n = 0;
    for (const batch of chunk(pending, opts.batchSize)) {
      await client.postBatch(kind, batch);
      // Only record after the server accepted the batch, so a mid-batch crash
      // re-sends rather than skips. Upsert semantics make the re-send harmless.
      // Never persist in dry-run: a rehearsal must not convince the next real
      // run that the work is already done.
      if (!opts.dryRun) {
        loaded.ids[kind] = [...(loaded.ids[kind] ?? []), ...batch.map((r) => r.id)];
        writeJson(loadedPath, loaded);
      }
      n += batch.length;
      progress(`  ${kind}`, n, pending.length, opts.batchSize);
    }
  }

  if (opts.skipAttachments) {
    info("attachments skipped by flag");
  } else {
    await loadAttachments(client, bundle.attachments, loaded, loadedPath);
  }

  info(
    `load done: ${ORDER.map((k) => `${k}=${(loaded.ids[k] ?? []).length}`).join(" ")} ` +
      `attachments=${loaded.attachments.length}, ${client.requestCount} requests`
  );
}

async function loadAttachments(
  client: FlowClient,
  attachments: AttachmentImport[],
  loaded: LoadedState,
  loadedPath: string
): Promise<void> {
  const done = new Set(loaded.attachments);
  const pending = attachments.filter((a) => !done.has(a.clickupAttachmentId));
  if (pending.length === 0) {
    info(`attachments: nothing to do (${attachments.length} already loaded)`);
    return;
  }
  info(`attachments: ${pending.length} to stream`);
  let n = 0;
  let failed = 0;
  for (const a of pending) {
    n++;
    try {
      await client.postAttachment(a);
      if (!client.dryRun) {
        loaded.attachments.push(a.clickupAttachmentId);
        if (n % 20 === 0) writeJson(loadedPath, loaded);
      }
    } catch (e) {
      // One bad attachment must not abort the run; it stays unrecorded and a
      // later invocation retries it.
      failed++;
      warn(`attachment ${a.filename} (${a.clickupAttachmentId}) failed: ${(e as Error).message}`);
    }
    progress("  attachments", n, pending.length, 20);
  }
  writeJson(loadedPath, loaded);
  if (failed > 0) warn(`${failed} attachments failed; re-run load to retry them`);
}

function readBundle(flowFile: (name: string) => string): FlowBundle {
  const need = <T>(name: string): T => {
    const v = readJsonIf<T>(flowFile(name));
    if (v === null) {
      throw new Error(`missing ${flowFile(name)} — run \`transform\` first`);
    }
    return v;
  };
  return {
    users: need(FLOW.users),
    spaces: need(FLOW.spaces),
    lists: need(FLOW.lists),
    tasks: need(FLOW.tasks),
    subtasks: need(FLOW.subtasks),
    comments: need(FLOW.comments),
    attachments: need(FLOW.attachments),
  };
}
