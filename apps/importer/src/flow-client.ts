import type { Comment, List, Space, Subtask, Task, User } from "@flow/shared";
import type { AttachmentImport } from "./transform.js";
import { sleep } from "./ratelimit.js";
import { warn } from "./log.js";

// ===========================================================================
// THE ONLY FILE THAT KNOWS FLOW'S IMPORT ENDPOINT SHAPES.
//
// These were ASSUMED before apps/api's REST README landed. If the rest agent
// named things differently, every change belongs here and nowhere else:
//
//   POST /api/import/batch
//     Bearer <flow api key>
//     body: { spaces?, lists?, users?, tasks?, subtasks?, comments? }
//            — arrays of fully-formed @flow/shared entities, ids included.
//     semantics: UPSERT by id, import mode (actor.via = "import"), so
//       automations do not fire and no Delta side effects are dispatched.
//       That non-firing guarantee is server-side; this client only picks the
//       endpoint.
//     response: { ok: true, counts: {...} } — anything else is a failure.
//
//   POST /api/import/attachments
//     Bearer <flow api key>
//     body: { taskId, filename, mimeType, size, sourceUrl, uploadedBy,
//             createdAt } — Flow fetches the ClickUp URL itself and writes R2,
//       assigning the Attachment id and r2Key. Falls back to a client-side
//       stream (multipart) when the server reports it cannot fetch remotely.
//
//   GET /api/import/status  -> { ok, loaded: { users, spaces, ... } }
//     Optional; used only for a pre-flight sanity check.
// ===========================================================================

export const ENDPOINTS = {
  batch: "/api/import/batch",
  attachments: "/api/import/attachments",
  status: "/api/import/status",
} as const;

export type BatchBody = {
  users?: User[];
  spaces?: Space[];
  lists?: List[];
  tasks?: Task[];
  subtasks?: Subtask[];
  comments?: Comment[];
};

export type BatchKind = keyof BatchBody;

export type BatchResponse = {
  ok?: boolean;
  counts?: Record<string, number>;
  errors?: { id?: string; error: string }[];
};

export type FlowClientOptions = {
  apiBase: string;
  apiKey: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Log the requests instead of sending them. */
  dryRun?: boolean;
};

export class FlowClient {
  private readonly base: string;
  private readonly key: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  readonly dryRun: boolean;
  requestCount = 0;

  constructor(opts: FlowClientOptions) {
    this.base = opts.apiBase.replace(/\/+$/, "");
    this.key = opts.apiKey;
    this.maxRetries = opts.maxRetries ?? 4;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.dryRun = opts.dryRun ?? false;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (this.dryRun) {
      const size = JSON.stringify(body).length;
      console.log(`  [dry-run] POST ${this.base}${path} (${size} bytes)`);
      return { ok: true } as T;
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.requestCount++;
        const res = await this.fetchImpl(`${this.base}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          const waitMs = Math.min(30_000, 1_000 * 2 ** attempt);
          warn(`Flow ${res.status} on ${path}; retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Flow ${res.status} ${path}: ${text.slice(0, 500)}`);
        }
        return (await res.json()) as T;
      } catch (e) {
        lastErr = e;
        // A thrown non-2xx is final; only transport errors are worth retrying.
        if (e instanceof Error && e.message.startsWith("Flow ")) throw e;
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Flow POST ${path} failed`);
  }

  /** One batch of one entity kind. Order across kinds is the caller's job. */
  async postBatch(kind: BatchKind, rows: unknown[]): Promise<BatchResponse> {
    const body = { [kind]: rows } as BatchBody;
    const res = await this.post<BatchResponse>(ENDPOINTS.batch, body);
    if (res.ok === false) {
      throw new Error(
        `Flow rejected ${kind} batch: ${JSON.stringify(res.errors ?? res).slice(0, 500)}`
      );
    }
    return res;
  }

  /**
   * Hands Flow the ClickUp source URL and lets the Worker do the fetch — the
   * bytes never round-trip through this machine. ClickUp attachment URLs on
   * t{team}.p.clickup-attachments.com are public-by-obscurity, so no ClickUp
   * auth is forwarded.
   */
  async postAttachment(a: AttachmentImport): Promise<BatchResponse> {
    return this.post<BatchResponse>(ENDPOINTS.attachments, {
      taskId: a.taskId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      sourceUrl: a.sourceUrl,
      uploadedBy: a.uploadedBy,
      createdAt: a.createdAt,
      clickupAttachmentId: a.clickupAttachmentId,
    });
  }
}
