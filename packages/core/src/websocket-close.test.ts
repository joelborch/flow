import { describe, expect, it } from "vitest";
import { websocketCloseReplyCode } from "./websocket-close.js";

describe("websocketCloseReplyCode", () => {
  it("maps an abnormal 1006 peer close to a sendable normal close", () => {
    expect(websocketCloseReplyCode(1006)).toBe(1000);
  });

  it("keeps sendable protocol close codes", () => {
    expect(websocketCloseReplyCode(1000)).toBe(1000);
    expect(websocketCloseReplyCode(1001)).toBe(1001);
    expect(websocketCloseReplyCode(1014)).toBe(1014);
  });

  it("normalizes other reserved and out-of-range codes", () => {
    expect(websocketCloseReplyCode(1004)).toBe(1000);
    expect(websocketCloseReplyCode(1005)).toBe(1000);
    expect(websocketCloseReplyCode(1015)).toBe(1000);
    expect(websocketCloseReplyCode(999)).toBe(1000);
  });
});
