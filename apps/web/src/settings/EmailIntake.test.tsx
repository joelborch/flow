// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import type { EmailIntake, List, Space, User } from "@flow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./index.js";
import { parseSenders } from "./EmailIntake.js";
import { activeTab } from "./route.js";
import { lists, me, spaces, users } from "../store/index.js";

const OWNER: User = {
  id: "us_owner",
  email: "owner@example.com",
  name: "Owner",
  role: "owner",
  deactivated: false,
  createdAt: 0,
};

const MEMBER: User = { ...OWNER, id: "us_member", email: "member@example.com", name: "Member", role: "member" };

function space(id: string, name: string, position: number, archived = false): Space {
  return { id, name, color: null, position, archived, visibility: "workspace", createdAt: 0 };
}

function list(id: string, spaceId: string, name: string, position: number, archived = false): List {
  return { id, spaceId, name, position, archived, statuses: [], inboundToken: null, createdAt: 0 };
}

const DOMAIN = "tickets.example.com";

const ACME: EmailIntake = {
  listId: "li_acme",
  alias: "acme",
  allowedSenders: ["dr@clinic.example", "@lab.example"],
  createdAt: 1,
  updatedAt: 1,
};

type Handler = (body: unknown) => Response;
type Call = { method: string; url: string; body: unknown };

let root: HTMLDivElement;
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Routes by "METHOD /path". Anything unlisted gets sane defaults so the
 *  webhook panel beside the intake section loads quietly. */
function mockApi(overrides: Record<string, Handler> = {}): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url}`;
      const handler = overrides[key];
      if (handler) return handler(body);
      if (key === "GET /api/email-intakes") return json({ domain: DOMAIN, intakes: [ACME] });
      if (method === "GET" && url.startsWith("/api/lists/")) {
        return json({ list: {}, inboundEnabled: false, tasks: [] });
      }
      return json({ error: `unmocked ${key}` }, 404);
    })
  );
}

/** Echoes a PUT body back as the saved intake, the way the API answers. */
function echoPut(listId: string): Handler {
  return (body) => {
    const input = body as { alias: string; allowedSenders: string[] };
    return json({ intake: { listId, ...input, createdAt: 2, updatedAt: 2 } });
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderInbound(user: User): Promise<void> {
  me.value = user;
  activeTab.value = "inbound";
  act(() => {
    render(<Settings />, root);
  });
  await settle();
}

/** Accessible name: aria-label when present, otherwise the visible text. */
function button(name: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name
  );
  if (!match) throw new Error(`No button named "${name}"`);
  return match;
}

function field<T extends HTMLElement>(selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`No element matching ${selector}`);
  return el;
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  act(() => {
    el.click();
  });
  await settle();
}

function putCalls(): Call[] {
  return calls.filter((c) => c.method === "PUT");
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  spaces.value = [space("sp_clinic", "Clinical", 0), space("sp_old", "Old stuff", 1, true)];
  lists.value = [
    list("li_acme", "sp_clinic", "Acme", 0),
    list("li_front", "sp_clinic", "Front desk", 1),
    list("li_retired", "sp_clinic", "Retired", 2, true),
    list("li_buried", "sp_old", "Buried", 0),
  ];
  users.value = [OWNER, MEMBER];
});

afterEach(() => {
  act(() => {
    render(null, root);
  });
  document.body.innerHTML = "";
  me.value = null;
  lists.value = [];
  spaces.value = [];
  vi.unstubAllGlobals();
});

describe("parseSenders", () => {
  it("trims each line and drops blank ones", () => {
    expect(parseSenders("  a@x.com \r\n\n   \n@y.com\n")).toEqual(["a@x.com", "@y.com"]);
  });
});

describe("Email intake settings", () => {
  it("lists each intake with its list, full address and allowed senders", async () => {
    mockApi();
    await renderInbound(OWNER);

    const text = root.textContent ?? "";
    expect(text).toContain("Email intake");
    expect(text).toContain("Clinical / Acme");
    expect(text).toContain("acme@tickets.example.com");
    expect(text).toContain("dr@clinic.example");
    expect(text).toContain("@lab.example");
    expect(button("Copy acme@tickets.example.com")).toBeTruthy();
  });

  it("shows the bare alias and a note when no intake domain is configured", async () => {
    mockApi({ "GET /api/email-intakes": () => json({ domain: null, intakes: [ACME] }) });
    await renderInbound(OWNER);

    const text = root.textContent ?? "";
    expect(text).toContain("intake domain isn't configured");
    expect(text).toContain("acme");
    expect(text).not.toContain("acme@");
    expect(() => button("Copy acme@tickets.example.com")).toThrow();
  });

  it("shows the load error with a retry", async () => {
    mockApi({ "GET /api/email-intakes": () => json({ error: "Workspace unavailable" }, 500) });
    await renderInbound(OWNER);

    expect(root.textContent).toContain("Workspace unavailable");
    expect(button("Retry")).toBeTruthy();
  });

  it("adds an intake with a trimmed payload, offering only eligible lists", async () => {
    mockApi({ "PUT /api/lists/li_front/email-intake": echoPut("li_front") });
    await renderInbound(OWNER);
    await click(button("Add address"));

    // Acme already has an address; Retired is archived; Buried sits in an
    // archived space. Front desk is the only real choice.
    const select = field<HTMLSelectElement>("form select");
    const offered = Array.from(select.querySelectorAll("option"))
      .map((o) => o.value)
      .filter((v) => v !== "");
    expect(offered).toEqual(["li_front"]);

    act(() => {
      select.value = "li_front";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typeInto(field<HTMLInputElement>('form input[aria-label="Alias"]'), "  front-desk  ");
    typeInto(field<HTMLTextAreaElement>("form textarea"), "  pat@clinic.example \n\n   @clinic.org\n  ");
    await click(button("Save"));

    expect(putCalls()).toEqual([
      {
        method: "PUT",
        url: "/api/lists/li_front/email-intake",
        body: { alias: "front-desk", allowedSenders: ["pat@clinic.example", "@clinic.org"] },
      },
    ]);
    expect(root.textContent).toContain("Clinical / Front desk");
    expect(root.textContent).toContain("front-desk@tickets.example.com");
    expect(root.querySelector("form")).toBeNull();
  });

  it("edits an intake with a trimmed payload", async () => {
    mockApi({ "PUT /api/lists/li_acme/email-intake": echoPut("li_acme") });
    await renderInbound(OWNER);
    await click(button("Edit the email intake for Clinical / Acme"));

    expect(field<HTMLInputElement>('form input[aria-label="Alias"]').value).toBe("acme");
    const senders = field<HTMLTextAreaElement>("form textarea");
    expect(senders.value).toBe("dr@clinic.example\n@lab.example");

    typeInto(senders, "dr@clinic.example\n  \n @lab.example \nnew@clinic.example  ");
    await click(button("Save"));

    expect(putCalls()).toEqual([
      {
        method: "PUT",
        url: "/api/lists/li_acme/email-intake",
        body: { alias: "acme", allowedSenders: ["dr@clinic.example", "@lab.example", "new@clinic.example"] },
      },
    ]);
    expect(root.textContent).toContain("new@clinic.example");
    expect(root.querySelector("form")).toBeNull();
  });

  it("shows the server's 422 message inline and keeps the form open", async () => {
    const message = "That alias is already used by another list.";
    mockApi({ "PUT /api/lists/li_front/email-intake": () => json({ error: message }, 422) });
    await renderInbound(OWNER);
    await click(button("Add address"));

    const select = field<HTMLSelectElement>("form select");
    act(() => {
      select.value = "li_front";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typeInto(field<HTMLInputElement>('form input[aria-label="Alias"]'), "acme");
    typeInto(field<HTMLTextAreaElement>("form textarea"), "pat@clinic.example");
    await click(button("Save"));

    expect(putCalls()).toHaveLength(1);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(root.querySelector("form textarea")).not.toBeNull();
  });

  it("removes an intake only after the confirm step", async () => {
    mockApi({ "DELETE /api/lists/li_acme/email-intake": () => json({ ok: true }) });
    await renderInbound(OWNER);

    await click(button("Remove the email intake for Clinical / Acme"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(root.textContent).toContain("Remove acme@tickets.example.com?");

    await click(button("Remove"));
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "/api/lists/li_acme/email-intake",
    ]);
    expect(root.textContent).not.toContain("acme@tickets.example.com");
    expect(root.textContent).toContain("No list has an email address yet.");
  });

  it("is neither shown to nor fetched for a member", async () => {
    mockApi();
    await renderInbound(MEMBER);

    // The webhook panel still renders for them; only the intake section is gone.
    expect(root.textContent).toContain("This is how outside systems file work into Flow");
    expect(root.textContent).not.toContain("Email intake");
    expect(calls.some((c) => c.url.includes("email-intake"))).toBe(false);
  });
});
