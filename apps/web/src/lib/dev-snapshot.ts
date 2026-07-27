// DEV-only fallback data. When the WebSocket cannot be reached and we are
// running under `vite dev`, the store hydrates this so the board is workable in
// isolation. `?tasks=500` scales it up for drag-performance checks.
import type {
  BoardSnapshot, List, Priority, SnapshotTask, Space, Status, Subtask, User,
} from "@flow/shared";

const DAY = 86_400_000;

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUS_SETS: Array<Array<Pick<Status, "name" | "color" | "type">>> = [
  [
    { name: "Backlog", color: "#8b8b9a", type: "open" },
    { name: "In progress", color: "#5b5bd6", type: "custom" },
    { name: "In review", color: "#c98a1e", type: "custom" },
    { name: "Done", color: "#3f9e6a", type: "closed" },
  ],
  [
    { name: "To do", color: "#8b8b9a", type: "open" },
    { name: "Doing", color: "#5b5bd6", type: "custom" },
    { name: "Done", color: "#3f9e6a", type: "closed" },
  ],
];

const TITLES = [
  "Rewrite the onboarding email sequence",
  "Audit contractor invoices for March",
  "Fix the pricing page CLS",
  "Move the bug-report intake to the new webhook",
  "Draft the Q3 content calendar",
  "Invoice approval takes four clicks too many",
  "Case study page needs a Spanish version",
  "Staging deploys keep failing mid-build",
  "Consolidate the two email vendors",
  "New contractor onboarding packet",
  "Website contact form spam is up",
  "Set up automatic overdue-invoice reminders",
  "Standing-desk replacement quote",
  "Migrate the old automations",
  "Weekly analytics report is off by one day",
  "Train the team on the new CRM",
];

const TAGS = ["ops", "design", "billing", "marketing", "urgent-fix", "vendor", "compliance"];
const PRIORITIES: Array<Priority | null> = ["urgent", "high", "normal", "low", null, null];

function statusSet(prefix: string, set: Array<Pick<Status, "name" | "color" | "type">>): Status[] {
  return set.map((s, i) => ({ ...s, id: `st_${prefix}${i}`, position: i }));
}

export function devSnapshot(taskCount = 48): BoardSnapshot {
  const rnd = mulberry(4711);
  const now = Date.now();

  const users: User[] = [
    { id: "us_alice", email: "alice@example.com", name: "Alice Chen", role: "owner", deactivated: false, createdAt: now - 400 * DAY },
    { id: "us_mara", email: "mara@example.com", name: "Mara Whitfield", role: "admin", deactivated: false, createdAt: now - 300 * DAY },
    { id: "us_dev", email: "devon@example.com", name: "Devon Cruz", role: "member", deactivated: false, createdAt: now - 200 * DAY },
    { id: "us_ana", email: "ana@example.com", name: "Ana Prieto", role: "member", deactivated: false, createdAt: now - 120 * DAY },
  ];

  const spaces: Space[] = [
    { id: "sp_ops", name: "Operations", color: "#5b5bd6", position: 0, archived: false, visibility: "workspace", createdAt: now - 365 * DAY },
    { id: "sp_growth", name: "Growth", color: "#3f9e6a", position: 1, archived: false, visibility: "workspace", createdAt: now - 300 * DAY },
  ];

  const listSpecs: Array<{ id: string; spaceId: string; name: string; set: number }> = [
    { id: "ls_intake", spaceId: "sp_ops", name: "Client intake", set: 0 },
    { id: "ls_billing", spaceId: "sp_ops", name: "Billing cleanup", set: 1 },
    { id: "ls_site", spaceId: "sp_growth", name: "Website", set: 0 },
  ];

  const lists: List[] = listSpecs.map((spec, i) => ({
    id: spec.id,
    spaceId: spec.spaceId,
    name: spec.name,
    position: i,
    archived: false,
    statuses: statusSet(`${spec.id.slice(3)}_`, STATUS_SETS[spec.set]!),
    inboundToken: null,
    createdAt: now - 200 * DAY,
  }));

  const tasks: SnapshotTask[] = [];
  const subtasks: Subtask[] = [];
  const perList = Math.max(1, Math.round(taskCount / lists.length));

  for (const list of lists) {
    for (let i = 0; i < perList; i++) {
      const status = list.statuses[Math.floor(rnd() * list.statuses.length)]!;
      const id = `tk_${list.id.slice(3)}${i}`;
      const hasDue = rnd() > 0.35;
      const tagCount = Math.floor(rnd() * 2.6);
      // Roughly one card in eight is parked, so the board's "N snoozed" note
      // and the Show snoozed toggle have something to show under vite dev.
      const snoozed = status.type !== "closed" && rnd() > 0.87;
      tasks.push({
        id,
        listId: list.id,
        title: `${TITLES[Math.floor(rnd() * TITLES.length)]!}${i > TITLES.length ? ` (${i})` : ""}`,
        statusId: status.id,
        assigneeId: rnd() > 0.25 ? users[Math.floor(rnd() * users.length)]!.id : null,
        priority: PRIORITIES[Math.floor(rnd() * PRIORITIES.length)]!,
        dueDate: hasDue ? now + Math.round((rnd() * 20 - 6)) * DAY : null,
        snoozedUntil: snoozed ? now + Math.round(1 + rnd() * 9) * DAY : null,
        blockedNote: snoozed && rnd() > 0.5 ? "the vendor's revised quote" : null,
        tags: Array.from({ length: tagCount }, () => TAGS[Math.floor(rnd() * TAGS.length)]!).filter(
          (t, k, arr) => arr.indexOf(t) === k
        ),
        position: i,
        createdAt: now - Math.round(rnd() * 60 * DAY),
        updatedAt: now - Math.round(rnd() * 5 * DAY),
        hasDescription: false,
      });

      const subCount = rnd() > 0.55 ? 2 + Math.floor(rnd() * 4) : 0;
      for (let s = 0; s < subCount; s++) {
        subtasks.push({
          id: `sb_${id}_${s}`,
          taskId: id,
          title: `Step ${s + 1}`,
          done: rnd() > 0.5,
          assigneeId: null,
          dueDate: null,
          position: s,
          createdAt: now - DAY,
        });
      }
    }
  }

  // The random pass above snoozes whoever it lands on, which may be nobody the
  // signed-in dev user owns — and then My Work's Snoozed bucket never appears.
  // Park one of the demo owner's tasks outright so that view is always exercisable.
  const mine = tasks.find((t) => t.assigneeId === "us_alice" && t.snoozedUntil === null);
  if (mine) {
    mine.snoozedUntil = now + 4 * DAY;
    mine.blockedNote = "waiting on design sign-off";
  }

  return { seq: 0, spaces, lists, tasks, subtasks, users, automationRules: [] };
}

export function devTaskCount(): number {
  const raw = new URLSearchParams(location.search).get("tasks");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 48;
}
