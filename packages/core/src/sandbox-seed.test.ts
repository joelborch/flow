import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CreateTaskInput } from "@flow/shared";
import { SANDBOX_MEMBER_ID, SANDBOX_WRITES_PER_MINUTE, SandboxBusy, SandboxWriteBudget } from "./sandbox-seed.js";
import { fakeCtx } from "./testkit.js";

// The public sandbox's starting workspace and the three DO behaviours only the
// sandbox uses: direct seeding, no recurring jobs, and wipeSandbox.

async function freshWorkspace(env: Record<string, unknown>) {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const deleteAll = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const ctx = fakeCtx(db, { deleteAll, deleteAlarm });
  const ws = new Workspace(ctx, { SIDE_EFFECTS: { sendBatch: async () => undefined }, ...env } as never);
  // The constructor's migration runs inside blockConcurrencyWhile; let it settle.
  await new Promise((r) => setTimeout(r, 0));
  return { ws, db, deleteAll, deleteAlarm };
}

const ownerOf = (ws: Awaited<ReturnType<typeof freshWorkspace>>["ws"]) =>
  ws.listUsers().find((u) => u.role === "owner")!;

describe("seedSandbox", () => {
  it("seeds cleanly, and a second seeding of the same workspace adds no duplicates", async () => {
    const { ws, db } = await freshWorkspace({ SANDBOX: "true" });
    const count = (table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    expect(ws.seedSandbox(1_700_000_000_000)).toEqual({ ok: true });
    const firstCounts = {
      users: count("users"),
      spaces: count("spaces"),
      lists: count("lists"),
      tasks: count("tasks"),
      subtasks: count("subtasks"),
      comments: count("comments"),
    };
    expect(firstCounts.tasks).toBeGreaterThan(10);

    expect(ws.seedSandbox(1_700_000_000_000)).toEqual({ ok: true });
    expect({
      users: count("users"),
      spaces: count("spaces"),
      lists: count("lists"),
      tasks: count("tasks"),
      subtasks: count("subtasks"),
      comments: count("comments"),
    }).toEqual(firstCounts);
  });

  it("renames the placeholder owner instead of adding a second one, and refuses outside the sandbox", async () => {
    const { ws } = await freshWorkspace({ SANDBOX: "true" });
    const owner = ownerOf(ws);
    ws.seedSandbox();
    const owners = ws.listUsers().filter((u) => u.role === "owner");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ id: owner.id, name: "Avery Chen", email: "avery@example.com" });

    const normal = await freshWorkspace({});
    expect(() => normal.ws.seedSandbox()).toThrow(/only runs on the sandbox/);
  });

  it("gives the sandbox member the shared spaces and never the private one", async () => {
    const { ws } = await freshWorkspace({ SANDBOX: "true" });
    ws.seedSandbox();
    const snap = ws.getSnapshot(SANDBOX_MEMBER_ID);
    expect(snap.spaces.map((s) => s.name).sort()).toEqual(["Marketing", "Operations"]);
    expect(JSON.stringify(snap)).not.toContain("hiring plan");
    expect(snap.tasks.some((t) => t.assigneeId === SANDBOX_MEMBER_ID)).toBe(true);
  });
});

describe("sandbox mode in the DO", () => {
  it("schedules no recurring jobs, where a normal workspace does", async () => {
    const sandbox = await freshWorkspace({ SANDBOX: "true" });
    const normal = await freshWorkspace({});
    const jobs = (db: DatabaseSync) => (db.prepare("SELECT count(*) AS n FROM scheduled_jobs").get() as { n: number }).n;
    expect(jobs(sandbox.db)).toBe(0);
    expect(jobs(normal.db)).toBeGreaterThan(0);
  });

  it("wipeSandbox deletes the alarm and every row, and refuses outside the sandbox", async () => {
    const sandbox = await freshWorkspace({ SANDBOX: "true" });
    await sandbox.ws.wipeSandbox();
    expect(sandbox.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(sandbox.deleteAll).toHaveBeenCalledTimes(1);

    const normal = await freshWorkspace({});
    await expect(normal.ws.wipeSandbox()).rejects.toThrow(/only runs on the sandbox/);
    expect(normal.deleteAll).not.toHaveBeenCalled();
  });
});

describe("the sandbox's shared write budget", () => {
  it("allows the budget per rolling minute, then says how long to wait", () => {
    let now = 1_000_000;
    const budget = new SandboxWriteBudget(2, () => now);
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(SandboxBusy);
    expect(() => budget.take()).toThrow(/^too many changes in the sandbox: everyone shares 2 a minute; try again in 60s$/);
    now += 60_001;
    budget.take();
  });

  it("refuses the write past the budget in a sandbox DO, without writing it, and never limits a normal one", async () => {
    const sandbox = await freshWorkspace({ SANDBOX: "true" });
    // Direct seeding bypasses mutation turns, so the whole budget is left for visitors.
    sandbox.ws.seedSandbox();
    const create = (ws: typeof sandbox.ws, listId: string, i: number) =>
      ws.createTask(CreateTaskInput.parse({ listId, title: `extra ${i}` }), SANDBOX_MEMBER_ID);
    for (let i = 0; i < SANDBOX_WRITES_PER_MINUTE; i++) create(sandbox.ws, "ls_sb_content", i);
    const count = () => (sandbox.db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n;
    const before = count();
    expect(() => create(sandbox.ws, "ls_sb_content", 99)).toThrow(/^too many changes in the sandbox/);
    expect(count()).toBe(before);

    const normal = await freshWorkspace({});
    const nOwner = ownerOf(normal.ws);
    normal.ws.upsertUser({ id: SANDBOX_MEMBER_ID, email: "agent@example.com", name: "Agent", role: "member" }, nOwner.id);
    const sp = normal.ws.createSpace({ name: "Work", visibility: "workspace" }, nOwner.id);
    const li = normal.ws.createList({ spaceId: sp.id, name: "Tasks" }, nOwner.id);
    for (let i = 0; i <= SANDBOX_WRITES_PER_MINUTE + 5; i++) create(normal.ws, li.id, i);
  });
});
