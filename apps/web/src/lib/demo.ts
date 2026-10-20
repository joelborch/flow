// Demo mode: `pnpm --filter @flow/web build:demo` (VITE_DEMO=true) builds the
// SPA to run on its own as a static site, with no Worker behind it. The board
// hydrates the same sample workspace `vite dev` falls back to, reads answer
// from it, and every write is turned away with a pointer to deploying a real
// instance, so the store's normal rollback-and-toast path does the rest.
import type { Comment, Subtask, TaskDetail, User } from "@flow/shared";
import type { StoreTask } from "../store/state.js";

export const DEMO = import.meta.env.VITE_DEMO === "true";

export const REPO_URL = "https://github.com/joelborch/flow";
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${REPO_URL}`;

/** `?embed` hides the demo badge, for screenshots and iframes in posts. */
export const DEMO_EMBED = DEMO && typeof location !== "undefined" && new URLSearchParams(location.search).has("embed");

export const READ_ONLY_MESSAGE = "this is a read-only demo, so changes aren't saved. Deploy your own to try it for real.";

/** What the demo board knows: the hydrated sample snapshot, read lazily. */
export interface DemoSource {
  task(taskId: string): StoreTask | undefined;
  subtasks(taskId: string): Subtask[];
  users(): User[];
}

let source: DemoSource = { task: () => undefined, subtasks: () => [], users: () => [] };

/** The store registers its board here once the demo has hydrated. */
export function setDemoSource(next: DemoSource): void {
  source = next;
}

export function demoSource(): DemoSource {
  return source;
}

const DAY = 86_400_000;

/** A short, plausible description per sample title; anything else gets a generic one. */
const DESCRIPTIONS: Record<string, string> = {
  "Rewrite the onboarding email sequence":
    "The current five emails were written before the product changed. Keep it to three:\n\n- **Day 0:** welcome and the one thing to do first\n- **Day 2:** connect an agent over MCP\n- **Day 7:** invite the team\n\nDrafts live in the shared doc; tone should match the help center.",
  "Audit contractor invoices for March":
    "Cross-check every March invoice against the signed SOW and the hours log. Flag anything over the cap or billed twice.",
  "Fix the pricing page CLS":
    "Layout shift is 0.24 on mobile, mostly from the plan cards loading their prices late. Reserve the space and render the prices server-side.",
  "Move the bug-report intake to the new webhook":
    "Point the bug reporter at this list's inbound URL instead of the old form. Each report should land as a task with the reporter's email in the description.",
  "Draft the Q3 content calendar":
    "One long-form post a week, two short ones. Pull topics from the support inbox and the search-console queries we rank 8–20 for.",
  "Invoice approval takes four clicks too many":
    "Approving an invoice goes list → invoice → review → approve → confirm. Make approve-from-list one click with an undo.",
  "Staging deploys keep failing mid-build":
    "Roughly one deploy in four dies at the asset step. Looks like the build runs out of memory when the image optimizer kicks in.",
  "Set up automatic overdue-invoice reminders":
    "An automation: when an invoice task is two days overdue, email the client contact and tag the task `reminded`.",
  "Weekly analytics report is off by one day":
    "The Monday report covers Tuesday–Monday instead of Monday–Sunday. Probably a time zone issue in the date range.",
};

const GENERIC_DESCRIPTION =
  "Context and links live here. Break the work into subtasks, assign each one, and comment as it moves.";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Strip the " (12)" suffix the generator adds when it reuses a title. */
function baseTitle(title: string): string {
  return title.replace(/ \(\d+\)$/, "");
}

function comment(task: StoreTask, n: number, authorId: string, body: string, via: Comment["via"], at: number): Comment {
  return { id: `cm_demo_${task.id}_${n}`, taskId: task.id, authorId, body, createdAt: at, via, emailTo: null, emailStatus: null };
}

/** Comments for a task: an agent exchange on the handoff, a short thread on some others. */
function demoComments(task: StoreTask, users: User[]): Comment[] {
  const now = Date.now();
  if (task.handoff) {
    const requester = task.handoff.requestedBy;
    const recipient = task.assigneeId ?? users[0]?.id ?? requester;
    return [
      comment(task, 1, requester, "Can your agent pull the numbers for the pages we changed last month? Same format as the board deck.", "mcp", now - DAY - 3_600_000),
      comment(task, 2, recipient, "Picked this up. I have the change dates; pulling sessions for each page now.", "mcp", now - DAY),
    ];
  }
  const h = hash(task.id);
  if (h % 3 !== 0 || users.length < 2) return [];
  const a = users[h % users.length]!.id;
  const b = users[(h >> 3) % users.length]!.id;
  return [
    comment(task, 1, a, "I can take the first pass at this if nobody's on it.", "ui", now - 2 * DAY),
    comment(task, 2, b === a ? users[0]!.id : b, "Go for it. Ping me when the draft is ready and I'll review.", "ui", now - DAY),
  ];
}

/** A full TaskDetail for a sample task, so the task panel has something to show. */
export function demoTaskDetail(task: StoreTask, subtasks: Subtask[], users: User[]): TaskDetail {
  const description = DESCRIPTIONS[baseTitle(task.title)] ?? GENERIC_DESCRIPTION;
  return {
    task: {
      ...task,
      description,
      startDate: null,
      createdBy: task.handoff?.requestedBy ?? users[0]?.id ?? "us_demo",
      closedAt: null,
      clickupId: null,
    },
    subtasks,
    comments: demoComments(task, users),
    attachments: [],
    emailReplyTo: null,
    emailReplySubject: null,
  };
}

/**
 * The demo's stand-in for the network. Reads the UI needs to look complete
 * answer from the sample board; every write, and any read it doesn't model,
 * comes back unanswered, and api.ts fails it as a 403 carrying
 * READ_ONLY_MESSAGE, which callers already handle (writes roll back and
 * toast it, detail reads fall back to the board).
 */
export function demoRequest(
  method: string,
  path: string,
  source: DemoSource
): { answered: true; value: unknown } | { answered: false } {
  const url = new URL(path, "https://demo.invalid");
  if (method === "GET") {
    if (url.pathname === "/api/me") {
      const user = source.users()[0];
      if (user) return { answered: true, value: user };
    }
    const detail = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    const commentsOf = /^\/api\/tasks\/([^/]+)\/comments$/.exec(url.pathname);
    const taskId = detail?.[1] ?? commentsOf?.[1];
    const task = taskId ? source.task(decodeURIComponent(taskId)) : undefined;
    if (task) {
      const full = demoTaskDetail(task, source.subtasks(task.id), source.users());
      return { answered: true, value: commentsOf ? { comments: full.comments } : full };
    }
  }
  return { answered: false };
}
