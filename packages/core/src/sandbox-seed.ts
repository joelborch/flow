import type { ImportBatch } from "./import.js";

// The workspace the public sandbox (sandbox/wrangler.jsonc) starts every hour
// with. Everything is made up. Ids are fixed so a second seeding of the same
// workspace, when two isolates race on a fresh hour, upserts instead of
// duplicating, and due dates are relative to the seeding time so "what's due
// this week" always has an answer.
//
// The visitor's key acts as SANDBOX_MEMBER_ID, a plain member, so the
// sandbox shows the permission model rather than bypassing it: they can work
// on tasks in the two workspace-visible spaces, can't reshape the workspace or
// touch automations, and never see the private Leadership space.

export const SANDBOX_MEMBER_ID = "us_sandbox_agent";
export const SANDBOX_KEY_NAME = "public sandbox key";

/**
 * Mutations the whole sandbox may make per rolling minute, across every
 * visitor. Rows written are what a public write key can run up, and the
 * Worker already caps each write at a handful of items, so counting turns
 * here bounds rows too. One DO serves the hour, so this count is global.
 */
export const SANDBOX_WRITES_PER_MINUTE = 30;

/** Thrown when the sandbox's shared write budget is spent; the Worker maps it to a 429. */
export class SandboxBusy extends Error {}

/** The shared budget: a rolling minute of mutation timestamps, in DO memory. */
export class SandboxWriteBudget {
  private recent: number[] = [];

  constructor(
    private readonly perMinute = SANDBOX_WRITES_PER_MINUTE,
    private readonly now: () => number = Date.now
  ) {}

  take(): void {
    const now = this.now();
    this.recent = this.recent.filter((at) => at > now - 60_000);
    if (this.recent.length >= this.perMinute) {
      const wait = Math.max(1, Math.ceil((this.recent[0]! + 60_000 - now) / 1000));
      throw new SandboxBusy(
        `too many changes in the sandbox: everyone shares ${this.perMinute} a minute; try again in ${wait}s`
      );
    }
    this.recent.push(now);
  }
}

const DAY = 86_400_000;

interface SeedTask {
  key: string;
  list: string;
  title: string;
  status: string;
  assignee?: string;
  /** Days from now; negative is overdue. */
  due?: number;
  priority?: "urgent" | "high" | "normal" | "low";
  tags?: string[];
  description?: string;
  subtasks?: Array<[string, boolean]>;
  comments?: Array<[string, string]>;
}

const TASKS: SeedTask[] = [
  {
    key: "onboarding",
    list: "ls_sb_website",
    title: "Rewrite the onboarding email sequence",
    status: "In progress",
    assignee: "us_sb_blake",
    due: 2,
    priority: "high",
    tags: ["email", "growth"],
    description: "Cut the five welcome emails to three: the first thing to do, connecting an agent, inviting the team.",
    subtasks: [["Draft day 0", true], ["Draft day 2", false], ["Draft day 7", false]],
    comments: [["us_sb_casey", "Day 2 should link straight to the MCP setup page."]],
  },
  {
    key: "cls",
    list: "ls_sb_website",
    title: "Fix the pricing page layout shift",
    status: "In review",
    assignee: "us_sb_casey",
    due: -1,
    priority: "urgent",
    tags: ["web", "performance"],
    description: "CLS is 0.24 on mobile because the plan cards load their prices late. Reserve the space.",
    subtasks: [["Reserve card height", true], ["Render prices server-side", true], ["Re-measure on mobile", false]],
  },
  {
    key: "blog",
    list: "ls_sb_website",
    title: "Publish the agent-first workflows post",
    status: "Backlog",
    assignee: SANDBOX_MEMBER_ID,
    due: 5,
    tags: ["content"],
    subtasks: [["Outline", false], ["First draft", false]],
  },
  {
    key: "a11y",
    list: "ls_sb_website",
    title: "Audit the signup form for keyboard access",
    status: "Backlog",
    due: 9,
    priority: "normal",
    tags: ["web", "a11y"],
  },
  {
    key: "redirects",
    list: "ls_sb_website",
    title: "Map old blog URLs to the new structure",
    status: "Done",
    assignee: "us_sb_blake",
    due: -6,
    tags: ["web", "seo"],
  },
  {
    key: "calendar",
    list: "ls_sb_content",
    title: "Draft the Q3 content calendar",
    status: "To do",
    assignee: SANDBOX_MEMBER_ID,
    due: 3,
    priority: "normal",
    tags: ["content"],
    description: "One long post a week and two short ones, with topics pulled from the support inbox.",
  },
  {
    key: "case-study",
    list: "ls_sb_content",
    title: "Interview two customers for case studies",
    status: "Doing",
    assignee: "us_sb_casey",
    due: 6,
    tags: ["content", "customers"],
    subtasks: [["Book the first interview", true], ["Book the second interview", false]],
    comments: [["us_sb_blake", "The logistics team said yes for Thursday."]],
  },
  {
    key: "newsletter",
    list: "ls_sb_content",
    title: "Send the monthly newsletter",
    status: "To do",
    assignee: "us_sb_blake",
    due: 1,
    priority: "high",
    tags: ["email"],
  },
  {
    key: "screenshots",
    list: "ls_sb_content",
    title: "Refresh the product screenshots",
    status: "To do",
    due: -2,
    tags: ["design"],
  },
  {
    key: "invoices",
    list: "ls_sb_ops",
    title: "Reconcile contractor invoices",
    status: "To do",
    assignee: "us_sb_casey",
    due: 4,
    priority: "normal",
    tags: ["finance"],
    description: "Check each invoice against the signed scope and the hours log.",
  },
  {
    key: "laptops",
    list: "ls_sb_ops",
    title: "Order laptops for the two new hires",
    status: "Doing",
    assignee: SANDBOX_MEMBER_ID,
    due: 0,
    priority: "high",
    tags: ["hiring"],
    subtasks: [["Confirm specs", true], ["Place the order", false], ["Set up accounts", false]],
  },
  {
    key: "vendor",
    list: "ls_sb_ops",
    title: "Renew the hosting contract",
    status: "Done",
    assignee: "us_sb_casey",
    due: -10,
    tags: ["finance"],
  },
  {
    key: "hiring-plan",
    list: "ls_sb_leadership",
    title: "Finalize next year's hiring plan",
    status: "To do",
    due: 12,
    priority: "high",
    tags: ["hiring"],
    description: "Only owners and admins see this space; the sandbox key never will.",
  },
  {
    key: "pricing",
    list: "ls_sb_leadership",
    title: "Decide on the pricing change",
    status: "Doing",
    due: 7,
    tags: ["strategy"],
  },
];

const STATUS_SETS = {
  board: [
    { name: "Backlog", color: "#8b8b9a", type: "open" as const },
    { name: "In progress", color: "#5b5bd6", type: "custom" as const },
    { name: "In review", color: "#c98a1e", type: "custom" as const },
    { name: "Done", color: "#3f9e6a", type: "closed" as const },
  ],
  simple: [
    { name: "To do", color: "#8b8b9a", type: "open" as const },
    { name: "Doing", color: "#5b5bd6", type: "custom" as const },
    { name: "Done", color: "#3f9e6a", type: "closed" as const },
  ],
};

/**
 * The sandbox's starting workspace. `ownerId` is the placeholder owner every
 * fresh workspace is born with (seedIfEmpty); it's renamed rather than joined
 * by a second owner.
 */
export function sandboxSeed(ownerId: string, now: number = Date.now()): ImportBatch {
  const at = (days: number) => now + days * DAY;
  return {
    users: [
      { id: ownerId, email: "avery@example.com", name: "Avery Chen", role: "owner", createdAt: at(-90) },
      { id: "us_sb_blake", email: "blake@example.com", name: "Blake Rivera", role: "member", createdAt: at(-60) },
      { id: "us_sb_casey", email: "casey@example.com", name: "Casey Morgan", role: "member", createdAt: at(-45) },
      { id: SANDBOX_MEMBER_ID, email: "agent@example.com", name: "Sandbox Agent", role: "member", createdAt: at(-1) },
    ],
    spaces: [
      { id: "sp_sb_marketing", name: "Marketing", visibility: "workspace", position: 1, createdAt: at(-90) },
      { id: "sp_sb_operations", name: "Operations", visibility: "workspace", position: 2, createdAt: at(-90) },
      { id: "sp_sb_leadership", name: "Leadership", visibility: "private", memberUserIds: [ownerId], position: 3, createdAt: at(-90) },
    ],
    lists: [
      { id: "ls_sb_website", spaceId: "sp_sb_marketing", name: "Website", position: 1, statuses: STATUS_SETS.board },
      { id: "ls_sb_content", spaceId: "sp_sb_marketing", name: "Content", position: 2, statuses: STATUS_SETS.simple },
      { id: "ls_sb_ops", spaceId: "sp_sb_operations", name: "Office", position: 1, statuses: STATUS_SETS.simple },
      { id: "ls_sb_leadership", spaceId: "sp_sb_leadership", name: "Planning", position: 1, statuses: STATUS_SETS.simple },
    ],
    tasks: TASKS.map((t, i) => ({
      id: `tk_sb_${t.key}`,
      listId: t.list,
      title: t.title,
      status: t.status,
      assigneeId: t.assignee ?? null,
      dueDate: t.due === undefined ? null : at(t.due),
      priority: t.priority ?? null,
      tags: t.tags ?? [],
      description: t.description ?? "",
      position: i + 1,
      createdBy: ownerId,
      createdAt: at(-20 + i),
      updatedAt: at(-1),
      closedAt: t.status === "Done" ? at(-1) : null,
    })),
    subtasks: TASKS.flatMap((t) =>
      (t.subtasks ?? []).map(([title, done], i) => ({
        id: `sb_sb_${t.key}_${i + 1}`,
        taskId: `tk_sb_${t.key}`,
        title,
        done,
        position: i + 1,
        createdAt: at(-10),
      }))
    ),
    comments: TASKS.flatMap((t) =>
      (t.comments ?? []).map(([authorId, body], i) => ({
        id: `cm_sb_${t.key}_${i + 1}`,
        taskId: `tk_sb_${t.key}`,
        authorId,
        body,
        createdAt: at(-2),
      }))
    ),
  };
}
