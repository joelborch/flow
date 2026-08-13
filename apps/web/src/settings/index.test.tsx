// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import type { Space, User } from "@flow/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Settings } from "./index.js";
import { activeTab } from "./route.js";
import { me, spaces, users } from "../store/index.js";

const OWNER: User = {
  id: "us_owner",
  email: "owner@example.com",
  name: "Owner",
  role: "owner",
  deactivated: false,
  createdAt: 0,
};

const MEMBER: User = {
  id: "us_member",
  email: "member@example.com",
  name: "Member",
  role: "member",
  deactivated: false,
  createdAt: 0,
};

const space: Space = {
  id: "sp_1",
  name: "Roadmap",
  color: null,
  position: 0,
  archived: false,
  visibility: "private",
  createdAt: 0,
};

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  spaces.value = [space];
  users.value = [OWNER, MEMBER];
  // Start each test on a tab every role can see, so the fallback logic in
  // Settings/Tabs doesn't mask what we're testing.
  activeTab.value = "api-keys";
});

afterEach(() => {
  act(() => {
    render(null, root);
  });
  document.body.innerHTML = "";
  me.value = null;
});

function tabLabels(): string[] {
  // Every tab button (active or not) carries this base class, per Tabs() below.
  return Array.from(root.querySelectorAll(".border-b-2")).map((el) => el.textContent ?? "");
}

describe("Settings tabs", () => {
  it("hides the Spaces (and Automations) tabs from a member", () => {
    me.value = MEMBER;
    act(() => {
      render(<Settings />, root);
    });
    const labels = tabLabels();
    expect(labels).not.toContain("Spaces");
    expect(labels).not.toContain("Automations");
    expect(labels).toContain("API keys");
    expect(labels).toContain("Inbound webhooks");
  });

  it("shows the Spaces tab to an owner/admin", () => {
    me.value = OWNER;
    act(() => {
      render(<Settings />, root);
    });
    expect(tabLabels()).toContain("Spaces");
  });

  it("bounces a member's stale activeTab off Spaces onto the first visible tab", () => {
    me.value = MEMBER;
    activeTab.value = "spaces";
    act(() => {
      render(<Settings />, root);
    });
    // The Spaces panel (owner/admin only content) must not have rendered.
    expect(root.textContent).not.toContain("Private is the default for new spaces");
  });
});
