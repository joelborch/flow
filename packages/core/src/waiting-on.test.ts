import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CreateListInput,
  CreateSpaceInput,
  CreateTaskInput,
  MoveTaskInput,
  UpdateTaskInput,
} from "@flow/shared";
import { queryViews } from "./query.js";
import { fakeCtx } from "./testkit.js";

const AVERY = "us_avery";
const BLAKE = "us_blake";

async function bootWorkspace() {
  const { Workspace } = await import("./index.js");
  const db = new DatabaseSync(":memory:");
  const sendBatch = vi.fn(async (_batch: Array<{ body: unknown }>) => undefined);
  const env = { SIDE_EFFECTS: { sendBatch } } as never;
  const ws = new Workspace(fakeCtx(db), env);
  ws.upsertUser({ id: AVERY, email: "avery@example.com", name: "Avery", role: "owner" }, AVERY);
  ws.upsertUser({ id: BLAKE, email: "blake@example.com", name: "Blake", role: "admin" }, AVERY);
  const space = ws.createSpace(CreateSpaceInput.parse({ name: "Eng", visibility: "workspace" }), AVERY);
  const list = ws.createList(CreateListInput.parse({ spaceId: space.id, name: "Sprint" }), AVERY);
  type Email = { kind: string; to: string[]; subject: string; body: string; ruleId: string };
  const emails = (): Email[] =>
    sendBatch.mock.calls.flatMap(([batch]) => batch.map((m) => m.body as Email)).filter((p) => p.kind === "email");
  const turnEmails = (): Email[] => emails().filter((p) => p.ruleId === "notify:turn_passed_to_me");
  return { db, ws, list, emails, turnEmails };
}

describe("waitingOn (ball in court)", () => {
  it("persists waitingOn on create and update independently of assigneeId", async () => {
    const { db, ws, list } = await bootWorkspace();

    const created = ws.createTask(
      CreateTaskInput.parse({
        listId: list.id,
        title: "Review PR",
        assigneeId: AVERY,
        waitingOn: BLAKE,
      }),
      AVERY,
    );
    expect(created.assigneeId).toBe(AVERY);
    expect(created.waitingOn).toBe(BLAKE);

    const viewRow = db
      .prepare(
        `WITH tasks_v AS (${queryViews(null).tasks_v}) SELECT waiting_on, waiting_on_name FROM tasks_v WHERE id = ?`,
      )
      .get(created.id) as { waiting_on: string | null; waiting_on_name: string | null };
    expect(viewRow).toEqual({ waiting_on: BLAKE, waiting_on_name: "Blake" });

    const passedBack = ws.updateTask(
      UpdateTaskInput.parse({ taskId: created.id, waitingOn: AVERY }),
      BLAKE,
    );
    expect(passedBack.assigneeId).toBe(AVERY);
    expect(passedBack.waitingOn).toBe(AVERY);

    const cleared = ws.updateTask(
      UpdateTaskInput.parse({ taskId: created.id, waitingOn: null }),
      AVERY,
    );
    expect(cleared.waitingOn).toBeNull();

    const snap = ws.getSnapshot(AVERY);
    const snapTask = snap.tasks.find((t) => t.id === created.id);
    expect(snapTask?.waitingOn).toBeNull();
  });

  it("rejects unknown waitingOn user ids", async () => {
    const { ws, list } = await bootWorkspace();
    expect(() =>
      ws.createTask(
        CreateTaskInput.parse({
          listId: list.id,
          title: "Bad handoff",
          waitingOn: "us_nonexistent",
        }),
        AVERY,
      ),
    ).toThrow(/Unknown waitingOn "us_nonexistent"/);
  });
  it("emails the person the ball lands on, and nobody else", async () => {
    const { ws, list, turnEmails } = await bootWorkspace();
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Review PR", assigneeId: AVERY }), AVERY);

    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: BLAKE }), AVERY);
    expect(turnEmails()).toHaveLength(1);
    expect(turnEmails()[0]?.to).toEqual(["blake@example.com"]);
    expect(turnEmails()[0]?.subject).toBe("Your turn: Review PR");

    // Taking the ball yourself, or clearing it, tells no one.
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: AVERY }), AVERY);
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: null }), AVERY);
    expect(turnEmails()).toHaveLength(1);

    // Passed back by Blake: Avery is told.
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: AVERY }), BLAKE);
    expect(turnEmails()).toHaveLength(2);
    expect(turnEmails()[1]?.to).toEqual(["avery@example.com"]);
  });

  it("sends one email, not two, when the same change assigns and passes the ball", async () => {
    const { ws, list, emails, turnEmails } = await bootWorkspace();
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Draft copy" }), AVERY);
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, assigneeId: BLAKE, waitingOn: BLAKE }), AVERY);
    expect(turnEmails()).toHaveLength(0);
    expect(emails().filter((p) => p.ruleId === "notify:assigned_to_me")).toHaveLength(1);
  });

  it("respects the recipient's assignment preference", async () => {
    const { ws, list, turnEmails } = await bootWorkspace();
    ws.setNotificationPrefs(BLAKE, { assigned_to_me: false });
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Quiet one", assigneeId: AVERY }), AVERY);
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: BLAKE }), AVERY);
    expect(turnEmails()).toHaveLength(0);
  });

  it("clears the turn when a task closes, by update or by move, and keeps it clear on reopen", async () => {
    const { ws, list, turnEmails } = await bootWorkspace();
    const viaUpdate = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Close by update", assigneeId: AVERY, waitingOn: BLAKE }),
      AVERY,
    );
    const closed = ws.updateTask(UpdateTaskInput.parse({ taskId: viaUpdate.id, status: "Done" }), AVERY);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.waitingOn).toBeNull();
    const reopened = ws.updateTask(UpdateTaskInput.parse({ taskId: viaUpdate.id, status: "To Do" }), AVERY);
    expect(reopened.waitingOn).toBeNull();

    const viaMove = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Close by move", assigneeId: AVERY, waitingOn: BLAKE }),
      AVERY,
    );
    const moved = ws.moveTask(MoveTaskInput.parse({ taskId: viaMove.id, status: "Done" }), AVERY);
    expect(moved.waitingOn).toBeNull();

    // Closing and passing the ball in one change: the close wins, and no one is emailed.
    const both = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Both at once", assigneeId: AVERY }), AVERY);
    const before = turnEmails().length;
    const after = ws.updateTask(UpdateTaskInput.parse({ taskId: both.id, status: "Done", waitingOn: BLAKE }), AVERY);
    expect(after.waitingOn).toBeNull();
    // A turn can't be set on a task that is already closed.
    expect(ws.updateTask(UpdateTaskInput.parse({ taskId: both.id, waitingOn: BLAKE }), AVERY).waitingOn).toBeNull();
    expect(turnEmails()).toHaveLength(before);

    // A task created closed is nobody's turn.
    const bornClosed = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Born closed", status: "Done", waitingOn: BLAKE }),
      AVERY,
    );
    expect(bornClosed.waitingOn).toBeNull();
  });
  it("lets a handoff's state set the turn: recipient, then requester on needs_input, then back", async () => {
    const { ws, list, turnEmails } = await bootWorkspace();
    const handoff = ws.requestHandoff(
      { listId: list.id, toUserId: BLAKE, title: "Pull the numbers", ask: "Sessions by page, please." },
      AVERY,
    );
    expect(handoff.waitingOn).toBe(BLAKE);
    // Filing it sent the assignment email, not a second "your turn" one.
    expect(turnEmails()).toHaveLength(0);

    const asked = ws.replyHandoff({ taskId: handoff.id, state: "needs_input", message: "Which date range?" }, BLAKE);
    expect(asked.task.waitingOn).toBe(AVERY);
    expect(turnEmails().at(-1)?.to).toEqual(["avery@example.com"]);

    // The requester answering hands it back as "working".
    const answered = ws.replyHandoff({ taskId: handoff.id, message: "Last 90 days." }, AVERY);
    expect(answered.task.handoff?.state).toBe("working");
    expect(answered.task.waitingOn).toBe(BLAKE);

    const done = ws.replyHandoff({ taskId: handoff.id, state: "done", message: "Attached." }, BLAKE);
    expect(done.task.closedAt).not.toBeNull();
    expect(done.task.waitingOn).toBeNull();

    // Reopening a finished handoff by hand puts it back on the recipient.
    const reopened = ws.moveTask(MoveTaskInput.parse({ taskId: handoff.id, status: "To Do" }), AVERY);
    expect(reopened.handoff?.state).toBe("working");
    expect(reopened.waitingOn).toBe(BLAKE);
  });

  it("clears a turn left on someone else when an ordinary task is reassigned", async () => {
    const { ws, list } = await bootWorkspace();
    ws.upsertUser({ id: "us_casey", email: "casey@example.com", name: "Casey", role: "member" }, AVERY);
    const task = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Call list", assigneeId: AVERY, waitingOn: BLAKE }),
      AVERY,
    );
    const reassigned = ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, assigneeId: "us_casey" }), AVERY);
    expect(reassigned.waitingOn).toBeNull();

    // Reassigning and naming a turn in the same change keeps the named turn.
    const both = ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, assigneeId: AVERY, waitingOn: BLAKE }), AVERY);
    expect(both.waitingOn).toBe(BLAKE);
    // A change that doesn't touch the assignee leaves the turn alone.
    expect(ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, title: "Call list v2" }), AVERY).waitingOn).toBe(BLAKE);
  });
  it("posts a turn note as a comment and quotes it in one email, not two", async () => {
    const { ws, list, emails, turnEmails } = await bootWorkspace();
    const task = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Landing page", assigneeId: AVERY }), AVERY);

    ws.updateTask(
      UpdateTaskInput.parse({ taskId: task.id, waitingOn: BLAKE, turnNote: "Please QA the mobile layout." }),
      AVERY,
    );
    const detail = ws.getTaskDetail(task.id);
    expect(detail.comments.map((c) => c.body)).toEqual(["Please QA the mobile layout."]);
    expect(turnEmails()).toHaveLength(1);
    expect(turnEmails()[0]?.body).toContain("> Please QA the mobile layout.");
    // Blake reads the note in the turn email; no separate comment email reaches him.
    const toBlake = emails().filter((p) => p.to.includes("blake@example.com"));
    expect(toBlake.map((p) => p.ruleId)).toEqual(["notify:turn_passed_to_me"]);

    // With turn emails switched off, the note still reaches its reader as a comment email.
    ws.setNotificationPrefs(AVERY, { assigned_to_me: false });
    ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: AVERY, turnNote: "Two spacing bugs, listed below." }), BLAKE);
    const toAvery = emails().filter((p) => p.to.includes("avery@example.com"));
    expect(toAvery.map((p) => p.ruleId)).toEqual(["notify:comment_on_my_task"]);
  });

  it("refuses a turn note that has no pass to go with", async () => {
    const { ws, list } = await bootWorkspace();
    const task = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Notes only", assigneeId: AVERY, waitingOn: BLAKE }),
      AVERY,
    );
    expect(() => ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, turnNote: "FYI" }), AVERY)).toThrow(
      /already on us_blake/,
    );
    expect(() =>
      ws.updateTask(UpdateTaskInput.parse({ taskId: task.id, waitingOn: null, turnNote: "FYI" }), AVERY),
    ).toThrow(/turnNote needs waitingOn/);
    // Nothing was written by the refused updates.
    expect(ws.getTaskDetail(task.id).comments).toHaveLength(0);
    expect(ws.getTaskDetail(task.id).task.waitingOn).toBe(BLAKE);
  });

  it("sends the requester one email when a handoff reply asks for input", async () => {
    const { ws, list, emails } = await bootWorkspace();
    const handoff = ws.requestHandoff(
      { listId: list.id, toUserId: BLAKE, title: "Pull the numbers", ask: "Sessions by page, please." },
      AVERY,
    );
    const before = emails().filter((p) => p.to.includes("avery@example.com")).length;
    ws.replyHandoff({ taskId: handoff.id, state: "needs_input", message: "Which date range?" }, BLAKE);
    const toAvery = emails().filter((p) => p.to.includes("avery@example.com")).slice(before);
    expect(toAvery.map((p) => p.ruleId)).toEqual(["notify:turn_passed_to_me"]);
    expect(toAvery[0]?.body).toContain("> Which date range?");
  });
  it("finds tasks by whose turn it is, not only by who owns them", async () => {
    const { db, ws, list } = await bootWorkspace();
    const mine = ws.createTask(CreateTaskInput.parse({ listId: list.id, title: "Mine, my turn", assigneeId: AVERY }), AVERY);
    const passedAway = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Mine, Blake's turn", assigneeId: AVERY, waitingOn: BLAKE }),
      AVERY,
    );
    const passedToMe = ws.createTask(
      CreateTaskInput.parse({ listId: list.id, title: "Blake's, my turn", assigneeId: BLAKE, waitingOn: AVERY }),
      AVERY,
    );

    const ids = (input: Record<string, unknown>): string[] =>
      ws.searchTasks({ includeClosed: false, limit: 50, ...input }, AVERY).tasks.map((t) => t.id).sort();
    expect(ids({ turnOf: AVERY })).toEqual([mine.id, passedToMe.id].sort());
    expect(ids({ turnOf: BLAKE })).toEqual([passedAway.id]);
    expect(ids({ assigneeId: AVERY })).toEqual([mine.id, passedAway.id].sort());
    // Search rows carry the turn, so a list can show it without a second read.
    expect(ws.searchTasks({ includeClosed: false, limit: 50, turnOf: BLAKE }, AVERY).tasks[0]?.waitingOn).toBe(BLAKE);

    const view = db
      .prepare(
        `WITH tasks_v AS (${queryViews(null).tasks_v}) SELECT id, turn_user_id, turn_user_name FROM tasks_v ORDER BY title`,
      )
      .all() as Array<{ id: string; turn_user_id: string | null; turn_user_name: string | null }>;
    const byId = new Map(view.map((row) => [row.id, [row.turn_user_id, row.turn_user_name]]));
    expect(byId.get(mine.id)).toEqual([AVERY, "Avery"]);
    expect(byId.get(passedAway.id)).toEqual([BLAKE, "Blake"]);
    expect(byId.get(passedToMe.id)).toEqual([AVERY, "Avery"]);
  });
});
