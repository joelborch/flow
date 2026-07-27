import { RateLimiter, sleep } from "./ratelimit.js";
import { fail, warn } from "./log.js";
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

export type ClickUpClientOptions = {
  token: string;
  baseUrl: string;
  limiter?: RateLimiter;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Read-only ClickUp v2 client. Every call goes through the rate limiter and
 * retries 429/5xx; nothing here mutates ClickUp.
 */
export class ClickUpClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  public requestCount = 0;

  constructor(opts: ClickUpClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.limiter = opts.limiter ?? new RateLimiter();
    this.maxRetries = opts.maxRetries ?? 6;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, query: Record<string, string | number | boolean> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire();
      let res: Response;
      try {
        this.requestCount += 1;
        res = await this.fetchImpl(url, {
          headers: { Authorization: this.token, Accept: "application/json" },
        });
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
        continue;
      }
      this.limiter.observe(res.headers);

      if (res.status === 429) {
        await this.limiter.backoff(res.headers, attempt);
        continue;
      }
      if (res.status >= 500) {
        warn(`${res.status} on ${url.pathname}; retrying`);
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ClickUp ${res.status} ${url.pathname}${url.search}: ${body.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    }
    fail(`gave up on ${url.pathname} after ${this.maxRetries + 1} attempts`);
    throw lastErr instanceof Error ? lastErr : new Error(`ClickUp request failed: ${url.pathname}`);
  }

  authorizedUser(): Promise<{ user: CuUser }> {
    return this.get("/user");
  }

  teams(): Promise<{ teams: CuTeam[] }> {
    return this.get("/team");
  }

  spaces(teamId: string, archived = false): Promise<{ spaces: CuSpace[] }> {
    return this.get(`/team/${teamId}/space`, { archived });
  }

  folders(spaceId: string, archived = false): Promise<{ folders: CuFolder[] }> {
    return this.get(`/space/${spaceId}/folder`, { archived });
  }

  folderlessLists(spaceId: string, archived = false): Promise<{ lists: CuList[] }> {
    return this.get(`/space/${spaceId}/list`, { archived });
  }

  /**
   * Per-list detail. This is the ONLY endpoint that returns a list's resolved
   * status set (`override_statuses` lists differ from their space default),
   * so the transform depends on it for Status[].
   */
  list(listId: string): Promise<CuList> {
    return this.get(`/list/${listId}`);
  }

  /**
   * One page (max 100) of the team task view. `include_markdown_description`
   * is required — without it ClickUp returns only the plaintext `description`
   * and all formatting is lost.
   */
  teamTasksPage(
    teamId: string,
    page: number
  ): Promise<{ tasks: CuTask[]; last_page?: boolean }> {
    return this.get(`/team/${teamId}/task`, {
      page,
      subtasks: true,
      include_closed: true,
      include_markdown_description: true,
    });
  }

  /** Full task detail. Needed only for `attachments`, absent from the list view. */
  task(taskId: string): Promise<CuTask> {
    return this.get(`/task/${taskId}`, { include_markdown_description: true });
  }

  /**
   * Task comments. ClickUp pages these 25 at a time and does NOT report a
   * last-page flag: you pass the oldest comment you have seen back as
   * `start` (its date) + `start_id` (its id) to get the next older page, and
   * stop when a page comes back short or repeats ids.
   */
  async allComments(taskId: string): Promise<CuComment[]> {
    const out: CuComment[] = [];
    const seen = new Set<string>();
    let start: string | undefined;
    let startId: string | undefined;

    for (let guard = 0; guard < 200; guard++) {
      const query: Record<string, string | number | boolean> = {};
      if (start !== undefined && startId !== undefined) {
        query["start"] = start;
        query["start_id"] = startId;
      }
      const res = await this.get<{ comments?: CuComment[] }>(`/task/${taskId}/comment`, query);
      const page = res.comments ?? [];
      let added = 0;
      for (const c of page) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        added++;
      }
      const oldest = page[page.length - 1];
      if (page.length < 25 || added === 0 || !oldest) break;
      start = oldest.date;
      startId = oldest.id;
    }
    return out;
  }

  async attachments(taskId: string): Promise<CuAttachment[]> {
    const t = await this.task(taskId);
    return (t.attachments ?? []).filter((a) => !a.deleted);
  }
}
