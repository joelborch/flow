import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.js";
import { errorMessage } from "./ui.js";

describe("errorMessage", () => {
  it("replaces a bare status line with what happened and what to do", () => {
    expect(errorMessage(new ApiError(502, "502 Bad Gateway"))).toBe("Flow's server had a problem (502). Retry in a moment.");
    expect(errorMessage(new ApiError(0, "Failed to fetch"))).toBe("Can't reach Flow. Check your connection, then retry.");
    expect(errorMessage(new ApiError(403, "403 Forbidden"))).toMatch(/don't have access/);
    expect(errorMessage(new ApiError(404, ""))).toMatch(/couldn't be found/);
  });

  it("keeps a message the API wrote itself, since it names the cause", () => {
    expect(errorMessage(new ApiError(403, "Only owners and admins can create automation rules."))).toBe(
      "Only owners and admins can create automation rules."
    );
    expect(errorMessage(new ApiError(500, "The list has no open status."))).toBe("The list has no open status.");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});
