import { describe, expect, it, vi } from "vitest";
import { isPublicPath, signInMode } from "./auth.js";
import type { Env } from "./env.js";

// GET /api/setup tells the web app whether sign-in is configured, so a fresh
// deploy shows its setup steps instead of redirecting to an Access login that
// doesn't exist on that hostname. The entrypoint pulls in the DO class, whose
// base class only exists in workerd.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

const AUD = "a".repeat(64);

describe("signInMode", () => {
  it("is access once a real team domain and AUD are set", () => {
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: AUD })).toBe("access");
    expect(signInMode({ ACCESS_TEAM_DOMAIN: " Acme.CloudflareAccess.com ", ACCESS_AUD: ` ${AUD.toUpperCase()} ` })).toBe(
      "access"
    );
  });

  it("is unconfigured for a fresh deploy's empty or placeholder values", () => {
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" })).toBe("unconfigured");
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com", ACCESS_AUD: AUD })).toBe("unconfigured");
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "" })).toBe("unconfigured");
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "acme.example.com", ACCESS_AUD: AUD })).toBe("unconfigured");
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: "not-hex" })).toBe("unconfigured");
  });

  it("is dev when DEV_NO_AUTH is on, whatever Access says", () => {
    expect(signInMode({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", DEV_NO_AUTH: "true" })).toBe("dev");
  });
});

describe("GET /api/setup", () => {
  it("is public and answers with one word", async () => {
    expect(isPublicPath("/api/setup")).toBe(true);
    const { default: worker } = await import("./index.js");
    const env = { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ASSETS: { fetch: vi.fn() } } as unknown as Env;
    const res = await worker.fetch(new Request("https://flow.example.com/api/setup"), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signIn: "unconfigured" });
  });
});
