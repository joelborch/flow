import { describe, expect, it } from "vitest";
import { statusForDoError } from "./do.js";

// The DO throws plain Errors with caller-facing messages; the RPC proxy turns
// them into HTTP statuses. Missing entities are 404, everything else 422.

describe("statusForDoError", () => {
  it("maps the DO's missing-entity throws to 404", () => {
    expect(statusForDoError("Task tk_abc not found.")).toBe(404);
    expect(statusForDoError("Subtask sb_abc not found.")).toBe(404);
    expect(statusForDoError("Comment cm_abc not found.")).toBe(404);
    expect(statusForDoError("Attachment at_abc not found.")).toBe(404);
    expect(statusForDoError("Automation rule ar_abc not found.")).toBe(404);
    expect(statusForDoError("API key ak_abc not found.")).toBe(404);
  });

  it("maps them even when the message carries a suggestion tail", () => {
    expect(
      statusForDoError('List ls_abc not found. Known lists: ls_1 ("Content Cycle").')
    ).toBe(404);
    expect(statusForDoError('Space sp_abc not found. Known spaces: none yet.')).toBe(404);
  });

  it("is case-insensitive", () => {
    expect(statusForDoError("NOT FOUND")).toBe(404);
  });

  it("leaves validation and conflict errors as 422", () => {
    expect(
      statusForDoError('Unknown status "Shipped" for list ls_1. Valid statuses (in order): …')
    ).toBe(422);
    expect(statusForDoError('Space sp_1 ("Marketing") still has 3 list(s).')).toBe(422);
    expect(statusForDoError("A list needs exactly one status of type \"open\", got 0 (none).")).toBe(
      422
    );
    expect(statusForDoError("Cannot create an API key for unknown user us_x.")).toBe(422);
  });

  it("does not match a word that merely starts with 'found'", () => {
    expect(statusForDoError("the rule was not foundational")).toBe(422);
  });
});
