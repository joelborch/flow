import { describe, expect, it } from "vitest";
import { HandoffState } from "@flow/shared";
import {
  type HandoffRoles,
  OPEN_HANDOFF_STATES,
  decideHandoffState,
  handoffStateForStatusMove,
  handoffStatusMove,
  isTerminalHandoffState,
} from "./handoffs.js";
import { type TaskRowSql, toComment, toHandoff } from "./rows.js";

const ALL = HandoffState.options;
const recipient: HandoffRoles = { recipient: true, requester: false, privileged: false };
const requester: HandoffRoles = { recipient: false, requester: true, privileged: false };
const admin: HandoffRoles = { recipient: false, requester: false, privileged: true };
const outsider: HandoffRoles = { recipient: false, requester: false, privileged: false };

describe("decideHandoffState", () => {
  it("lets the recipient and owners/admins set any state from any state", () => {
    for (const roles of [recipient, admin]) {
      for (const current of ALL) {
        for (const next of ALL) {
          expect(decideHandoffState(current, next, false, roles)).toEqual({ ok: true, next });
        }
      }
    }
  });

  it("lets the requester set declined and nothing else", () => {
    for (const next of ALL) {
      expect(decideHandoffState("working", next, true, requester)).toEqual(
        next === "declined" ? { ok: true, next } : { ok: false, reason: "requester_state" }
      );
    }
  });

  it("moves needs_input to working on a requester's message, and only then", () => {
    expect(decideHandoffState("needs_input", undefined, true, requester)).toEqual({ ok: true, next: "working" });
    expect(decideHandoffState("needs_input", undefined, true, recipient)).toEqual({ ok: true, next: "needs_input" });
    expect(decideHandoffState("needs_input", undefined, true, admin)).toEqual({ ok: true, next: "needs_input" });
    // Someone who is both (a reassigned handoff) is answering their own question.
    expect(
      decideHandoffState("needs_input", undefined, true, { recipient: true, requester: true, privileged: false })
    ).toEqual({ ok: true, next: "needs_input" });
    for (const current of ALL.filter((s) => s !== "needs_input")) {
      expect(decideHandoffState(current, undefined, true, requester)).toEqual({ ok: true, next: current });
    }
  });

  it("refuses an outsider whether or not they name a state", () => {
    expect(decideHandoffState("requested", undefined, true, outsider)).toEqual({ ok: false, reason: "outsider" });
    expect(decideHandoffState("requested", "done", false, outsider)).toEqual({ ok: false, reason: "outsider" });
  });

  it("treats a privileged requester as able to set any state", () => {
    const both: HandoffRoles = { recipient: false, requester: true, privileged: true };
    expect(decideHandoffState("requested", "done", false, both)).toEqual({ ok: true, next: "done" });
  });
});

describe("handoffStatusMove", () => {
  it("closes an open task on done/declined and reopens a closed one on an open state", () => {
    expect(handoffStatusMove("done", false)).toBe("close");
    expect(handoffStatusMove("declined", false)).toBe("close");
    expect(handoffStatusMove("done", true)).toBeNull();
    for (const state of OPEN_HANDOFF_STATES) {
      expect(handoffStatusMove(state, true)).toBe("reopen");
      expect(handoffStatusMove(state, false)).toBeNull();
    }
  });

  it("agrees with isTerminalHandoffState", () => {
    expect(ALL.filter(isTerminalHandoffState)).toEqual(["done", "declined"]);
    expect(ALL.filter((s) => !isTerminalHandoffState(s))).toEqual([...OPEN_HANDOFF_STATES]);
  });
});

describe("handoffStateForStatusMove", () => {
  it("closing an open handoff by hand finishes it; reopening a finished one resumes it", () => {
    for (const state of OPEN_HANDOFF_STATES) {
      expect(handoffStateForStatusMove(state, false, true), state).toBe("done");
      expect(handoffStateForStatusMove(state, true, false), state).toBeNull();
    }
    for (const state of ["done", "declined"] as const) {
      expect(handoffStateForStatusMove(state, true, false), state).toBe("working");
      expect(handoffStateForStatusMove(state, false, true), state).toBeNull();
    }
  });

  it("leaves the state alone when the task's closedness doesn't change", () => {
    for (const state of ALL) {
      expect(handoffStateForStatusMove(state, false, false)).toBeNull();
      expect(handoffStateForStatusMove(state, true, true)).toBeNull();
    }
  });
});

describe("decideHandoffState: requester withdrawal", () => {
  const requester: HandoffRoles = { recipient: false, requester: true, privileged: false };
  it("allows declining an open handoff and refuses a finished one", () => {
    for (const state of OPEN_HANDOFF_STATES) {
      expect(decideHandoffState(state, "declined", false, requester)).toEqual({ ok: true, next: "declined" });
    }
    for (const state of ["done", "declined"] as const) {
      expect(decideHandoffState(state, "declined", false, requester)).toEqual({
        ok: false,
        reason: "requester_state",
      });
    }
  });
});

describe("row mapping", () => {
  const cols = (over: Partial<TaskRowSql> = {}) => ({
    handoff_requested_by: "us_a",
    handoff_state: "working",
    handoff_return: null,
    handoff_context: '["tk_1","tk_2"]',
    handoff_state_changed_at: 42,
    ...over,
  });

  it("maps the five columns, and null state to no handoff", () => {
    expect(toHandoff(cols())).toEqual({
      requestedBy: "us_a",
      state: "working",
      returnFormat: null,
      contextTaskIds: ["tk_1", "tk_2"],
      stateChangedAt: 42,
    });
    expect(toHandoff(cols({ handoff_state: null }))).toBeNull();
  });

  it("reads a hand-edited state as requested and junk context as no context", () => {
    expect(toHandoff(cols({ handoff_state: "lost", handoff_context: "not json" }))).toMatchObject({
      state: "requested",
      contextTaskIds: [],
    });
    expect(toHandoff(cols({ handoff_context: '[1, "tk_1", null]' }))?.contextTaskIds).toEqual(["tk_1"]);
  });

  it("maps comment via, reading null and unknown values as unrecorded", () => {
    const comment = (via: string | null) =>
      toComment({ id: "cm_1", task_id: "tk_1", author_id: "us_a", body: "b", created_at: 0, via });
    expect(comment("mcp").via).toBe("mcp");
    expect(comment(null).via).toBeNull();
    expect(comment("carrier pigeon").via).toBeNull();
  });
});
