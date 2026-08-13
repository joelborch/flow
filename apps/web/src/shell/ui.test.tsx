// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { useRef } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDialogFocus } from "./ui.js";

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  act(() => {
    render(null, root);
  });
  document.body.innerHTML = "";
});

/** A minimal dialog: two buttons, wired through the hook under test. */
function Dialog({ open = true }: { open?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useDialogFocus(containerRef, open);
  return (
    <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true">
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("moves focus into the container on open when nothing inside is already focused", () => {
    act(() => {
      render(<Dialog />, root);
    });
    const first = root.querySelector("button")!;
    expect(document.activeElement).toBe(first);
  });

  it("leaves focus alone when the container already contains it (e.g. an autofocused input)", () => {
    function AutofocusDialog() {
      const containerRef = useRef<HTMLDivElement>(null);
      const inputRef = useRef<HTMLInputElement>(null);
      // Declared before the hook, matching NewListForm's own autofocus effect.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useDialogFocus(containerRef);
      return (
        <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true">
          <input ref={inputRef} autoFocus />
          <button type="button">ok</button>
        </div>
      );
    }
    let inputEl: HTMLInputElement;
    act(() => {
      render(<AutofocusDialog />, root);
      inputEl = root.querySelector("input")!;
      inputEl.focus();
    });
    expect(document.activeElement).toBe(root.querySelector("input"));
  });

  it("traps Tab and Shift+Tab within the container", () => {
    act(() => {
      render(<Dialog />, root);
    });
    const buttons = Array.from(root.querySelectorAll("button")) as HTMLButtonElement[];
    const first = buttons[0]!;
    const last = buttons[1]!;
    expect(document.activeElement).toBe(first);

    act(() => {
      last.focus();
      const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      first.focus();
      const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
    });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the previously focused element on unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      render(<Dialog />, root);
    });
    expect(document.activeElement).not.toBe(trigger);

    act(() => {
      render(null, root);
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("restores focus when `open` flips false without unmounting", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();

    act(() => {
      render(<Dialog open={true} />, root);
    });
    expect(document.activeElement).not.toBe(trigger);

    act(() => {
      render(<Dialog open={false} />, root);
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("does nothing while closed", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();

    act(() => {
      render(<Dialog open={false} />, root);
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
