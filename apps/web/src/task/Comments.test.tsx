// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./Comments.js";

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
});

function textarea(): HTMLTextAreaElement {
  return root.querySelector("textarea")!;
}

async function type(text: string): Promise<void> {
  await act(() => {
    const el = textarea();
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSend(): Promise<void> {
  await act(() => {
    root.querySelector<HTMLButtonElement>("button")!.click();
  });
}

describe("CommentComposer", () => {
  it("clears the draft once the comment posts", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    act(() => render(<CommentComposer onSend={onSend} />, root));
    await type("Looks good");
    await clickSend();
    expect(onSend).toHaveBeenCalledWith("Looks good");
    expect(textarea().value).toBe("");
  });

  it("puts the draft back when the post fails", async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    act(() => render(<CommentComposer onSend={onSend} />, root));
    await type("Please re-run the proof  ");
    await clickSend();
    expect(textarea().value).toBe("Please re-run the proof  ");
  });

  it("keeps a new draft typed while the failed post was in flight", async () => {
    let finish!: (ok: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    act(() => render(<CommentComposer onSend={onSend} />, root));
    await type("First thought");
    await clickSend();
    expect(textarea().value).toBe("");
    await type("Second thought");
    await act(async () => finish(false));
    expect(textarea().value).toBe("Second thought");
  });
});
