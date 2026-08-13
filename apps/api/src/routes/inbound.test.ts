import { describe, expect, it } from "vitest";
import { InboundTaskInput, LIMITS } from "@flow/shared";

// InboundTaskInput used to accept an unbounded title/description/tags (bare
// z.string().min(1) / z.array(z.string())), unlike every REST create-task
// path which runs through taskTitle()/taskDescription()/taskTags(). A hostile
// or misbehaving webhook sender could push a multi-megabyte title straight
// into the board. InboundTaskInput must reject the same oversized input REST
// would.
describe("InboundTaskInput respects the shared LIMITS", () => {
  const base = { title: "a valid title" };

  it("accepts a title/description/tags at the limit", () => {
    const result = InboundTaskInput.safeParse({
      title: "x".repeat(LIMITS.titleMax),
      description: "y".repeat(LIMITS.descriptionMax),
      tags: Array.from({ length: LIMITS.tagsMax }, (_, i) => `tag${i}`.padEnd(3, "z")),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a title over titleMax", () => {
    const result = InboundTaskInput.safeParse({ title: "x".repeat(LIMITS.titleMax + 1) });
    expect(result.success).toBe(false);
  });

  it("rejects a description over descriptionMax", () => {
    const result = InboundTaskInput.safeParse({
      ...base,
      description: "y".repeat(LIMITS.descriptionMax + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tag over tagMax characters", () => {
    const result = InboundTaskInput.safeParse({
      ...base,
      tags: ["z".repeat(LIMITS.tagMax + 1)],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than tagsMax tags", () => {
    const result = InboundTaskInput.safeParse({
      ...base,
      tags: Array.from({ length: LIMITS.tagsMax + 1 }, (_, i) => `tag${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("still rejects an empty title", () => {
    expect(InboundTaskInput.safeParse({ title: "" }).success).toBe(false);
  });
});
