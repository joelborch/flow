// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, toast, toasts } from "./lib/toast.js";
import { Toasts } from "./main.js";

let root: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  toasts.value = [];
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  act(() => {
    render(null, root);
  });
  toasts.value = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Toasts", () => {
  it("mounts a polite status live region even when empty, and announces active toasts inside it", () => {
    act(() => {
      render(<Toasts />, root);
    });

    const region = root.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");

    let id = 0;
    act(() => {
      id = toast("Task saved");
    });

    expect(region?.textContent).toContain("Task saved");

    act(() => {
      dismissToast(id);
    });

    expect(root.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
  });
});
