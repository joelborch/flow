import { describe, expect, it } from "vitest";
import { defaultNotificationPrefs, mergeNotificationPrefs } from "@flow/shared";
import {
  PREF_KEY,
  assignedRecipients,
  notificationTag,
  recipientsFor,
  renderNotification,
  stakeholderRecipients,
} from "./notifications.js";

const ACTOR = "us_actor";
const ALICE = "us_alice";
const BOB = "us_bob";

// ---------------------------------------------------------------------------
// Recipient resolution — the actor is never notified about their own action.
// ---------------------------------------------------------------------------

describe("assignedRecipients", () => {
  it("notifies the new assignee", () => {
    expect(assignedRecipients(ALICE, ACTOR)).toEqual([ALICE]);
  });

  it("does not notify me when I assign a task to myself", () => {
    expect(assignedRecipients(ACTOR, ACTOR)).toEqual([]);
  });

  it("notifies nobody when a task is unassigned", () => {
    expect(assignedRecipients(null, ACTOR)).toEqual([]);
  });
});

describe("stakeholderRecipients (comment / status)", () => {
  it("notifies the task assignee and creator, minus the actor", () => {
    // Bob comments on Alice's task that Bob created -> only Alice hears about it.
    expect(stakeholderRecipients(ALICE, BOB, BOB)).toEqual([ALICE]);
  });

  it("dedupes when the assignee is also the creator", () => {
    expect(stakeholderRecipients(ALICE, ALICE, ACTOR)).toEqual([ALICE]);
  });

  it("drops the actor when they are the assignee", () => {
    expect(stakeholderRecipients(ACTOR, BOB, ACTOR)).toEqual([BOB]);
  });

  it("drops the actor when they are the creator", () => {
    expect(stakeholderRecipients(ALICE, ACTOR, ACTOR)).toEqual([ALICE]);
  });

  it("skips a null assignee", () => {
    expect(stakeholderRecipients(null, BOB, ACTOR)).toEqual([BOB]);
  });

  it("notifies nobody when the actor is the only stakeholder", () => {
    expect(stakeholderRecipients(ACTOR, ACTOR, ACTOR)).toEqual([]);
  });

  it("preserves assignee-before-creator order", () => {
    expect(stakeholderRecipients(ALICE, BOB, ACTOR)).toEqual([ALICE, BOB]);
  });
});

describe("recipientsFor dispatch", () => {
  it("routes assigned to the new assignee only", () => {
    expect(
      recipientsFor("assigned", { assigneeId: BOB, creatorId: BOB, newAssigneeId: ALICE }, ACTOR)
    ).toEqual([ALICE]);
  });

  it("routes comment to the stakeholders", () => {
    expect(recipientsFor("comment", { assigneeId: ALICE, creatorId: BOB }, ACTOR)).toEqual([
      ALICE,
      BOB,
    ]);
  });

  it("routes status to the stakeholders", () => {
    expect(recipientsFor("status", { assigneeId: ALICE, creatorId: ACTOR }, ACTOR)).toEqual([ALICE]);
  });
});

// ---------------------------------------------------------------------------
// Default prefs — everything on except status changes.
// ---------------------------------------------------------------------------

describe("default notification prefs", () => {
  it("defaults every event on except status changes", () => {
    expect(defaultNotificationPrefs()).toEqual({
      assigned_to_me: true,
      comment_on_my_task: true,
      status_change_on_my_task: false,
      mention: true,
    });
  });

  it("keeps status_change off by default under the pref key the DO gates on", () => {
    expect(defaultNotificationPrefs()[PREF_KEY.status]).toBe(false);
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultNotificationPrefs();
    a.assigned_to_me = false;
    expect(defaultNotificationPrefs().assigned_to_me).toBe(true);
  });

  it("maps each notification kind to its gating pref", () => {
    expect(PREF_KEY).toEqual({
      assigned: "assigned_to_me",
      comment: "comment_on_my_task",
      status: "status_change_on_my_task",
    });
  });
});

describe("mergeNotificationPrefs", () => {
  it("falls back to defaults for a missing/invalid stored value", () => {
    expect(mergeNotificationPrefs(undefined)).toEqual(defaultNotificationPrefs());
    expect(mergeNotificationPrefs(null)).toEqual(defaultNotificationPrefs());
    expect(mergeNotificationPrefs("nope")).toEqual(defaultNotificationPrefs());
  });

  it("applies a partial patch on top of the defaults", () => {
    expect(mergeNotificationPrefs({ status_change_on_my_task: true })).toEqual({
      assigned_to_me: true,
      comment_on_my_task: true,
      status_change_on_my_task: true,
      mention: true,
    });
  });

  it("ignores unknown keys and non-boolean values", () => {
    expect(mergeNotificationPrefs({ assigned_to_me: "yes", bogus: true })).toEqual(
      defaultNotificationPrefs()
    );
  });
});

// ---------------------------------------------------------------------------
// Templates.
// ---------------------------------------------------------------------------

const URL = "https://flow.example.com/t/tk_123";

describe("templates", () => {
  it("renders the assignment email", () => {
    const { subject, body } = renderNotification("assigned", {
      taskTitle: "Ship the thing",
      taskUrl: URL,
      actorName: "Alice",
    });
    expect(subject).toBe("You were assigned: Ship the thing");
    expect(body).toContain("**Alice** assigned you to **Ship the thing**.");
    expect(body).toContain(`[Open the task](${URL})`);
  });

  it("renders the comment email with the comment body quoted", () => {
    const { subject, body } = renderNotification("comment", {
      taskTitle: "Ship the thing",
      taskUrl: URL,
      actorName: "Bob",
      commentBody: "Looks good\nto me",
    });
    expect(subject).toBe("New comment on Ship the thing");
    expect(body).toContain("**Bob** commented on **Ship the thing**:");
    expect(body).toContain("> Looks good");
    expect(body).toContain("> to me");
    expect(body).toContain(`[Open the task](${URL})`);
  });

  it("renders the status-change email", () => {
    const { subject, body } = renderNotification("status", {
      taskTitle: "Ship the thing",
      taskUrl: URL,
      actorName: "Alice",
      statusName: "In Progress",
    });
    expect(subject).toBe("Ship the thing moved to In Progress");
    expect(body).toContain("**Alice** moved **Ship the thing** to **In Progress**.");
    expect(body).toContain(`[Open the task](${URL})`);
  });
});

describe("notificationTag", () => {
  it("names the event for the queue payload / dry-run log", () => {
    expect(notificationTag("assigned")).toBe("notify:assigned_to_me");
    expect(notificationTag("comment")).toBe("notify:comment_on_my_task");
    expect(notificationTag("status")).toBe("notify:status_change_on_my_task");
  });
});
