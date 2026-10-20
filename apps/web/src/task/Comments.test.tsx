// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "@flow/shared";
import { users } from "../store/index.js";
import { CommentComposer, Comments } from "./Comments.js";

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

describe("Comments", () => {
  function comment(id: string, via: Comment["via"] | undefined): Comment {
    const c = { id, taskId: "tk_1", authorId: "us_blake", body: `Reply ${id}`, createdAt: Number(id.slice(3)) };
    // Comments loaded before `via` existed carry no field at all.
    return (via === undefined ? c : { ...c, via }) as Comment;
  }

  it("labels agent-written replies and leaves human ones alone", () => {
    users.value = [
      { id: "us_blake", email: "blake@example.com", name: "Blake", role: "member", deactivated: false, createdAt: 0 },
    ];
    const thread = [
      comment("cm_1", "api"),
      comment("cm_2", "mcp"),
      comment("cm_3", "ui"),
      comment("cm_4", null),
      comment("cm_5", undefined),
    ];
    act(() => render(<Comments comments={thread} />, root));

    const labelled = Array.from(root.querySelectorAll("li")).map((li) =>
      Array.from(li.querySelectorAll("span")).some((s) => s.textContent === "agent")
    );
    expect(labelled).toEqual([true, true, false, false, false]);
    expect(root.querySelector('[title="Written by Blake\'s agent"]')).not.toBeNull();
    users.value = [];
  });
});
