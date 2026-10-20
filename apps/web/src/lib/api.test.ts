import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function storage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("API session recovery", () => {
  const replace = vi.fn();

  beforeEach(() => {
    replace.mockReset();
    vi.resetModules();
    vi.stubGlobal("window", {
      location: {
        href: "https://flow.example.com/settings?tab=api-keys",
        replace,
      },
    });
    vi.stubGlobal("localStorage", storage({ "flow.boot": "cached", "flow.me": "cached" }));
    vi.stubGlobal("sessionStorage", storage());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears caches and reauthenticates through Access on the first 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Access token expired" }), { status: 401 })
      )
    );
    const { api } = await import("./api.js");

    await expect(api.me()).rejects.toMatchObject({
      status: 401,
      message: "Session expired, redirecting to login",
    });

    expect(localStorage.getItem("flow.boot")).toBeNull();
    expect(localStorage.getItem("flow.me")).toBeNull();
    expect(sessionStorage.getItem("flow.auth-retry")).not.toBeNull();
    expect(replace).toHaveBeenCalledWith(
      "/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fflow.example.com%2Fsettings%3Ftab%3Dapi-keys"
    );
  });

  it("surfaces the server error instead of looping after a recent retry", async () => {
    vi.stubGlobal("sessionStorage", storage({ "flow.auth-retry": String(Date.now()) }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Access token audience does not match" }), {
          status: 401,
        })
      )
    );
    const { api } = await import("./api.js");

    await expect(api.me()).rejects.toMatchObject({
      status: 401,
      message: "Access token audience does not match",
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("leaves the page alone when a background fetch opts out of the redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Access token expired" }), { status: 401 })
      )
    );
    const { api } = await import("./api.js");

    await expect(api.taskDetail("tk_1", { authRedirect: false })).rejects.toMatchObject({
      status: 401,
      message: "Access token expired",
    });
    expect(replace).not.toHaveBeenCalled();
    expect(localStorage.getItem("flow.boot")).toBe("cached");
  });

  it("clears the retry guard after a successful request", async () => {
    vi.stubGlobal("sessionStorage", storage({ "flow.auth-retry": String(Date.now()) }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ user: { id: "us_avery", email: "avery@example.com" } }))
      )
    );
    const { api } = await import("./api.js");

    await api.me();

    expect(sessionStorage.getItem("flow.auth-retry")).toBeNull();
  });
});
