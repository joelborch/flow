// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { MY_WORK_PATH, listPath, navigate, route, withTask } from "./router.js";

describe("router: My Work has its own path", () => {
  beforeEach(() => {
    navigate("/");
  });

  it("parses /my-work as My Work, with or without an open task", () => {
    navigate(MY_WORK_PATH);
    expect(route.value.myWork).toBe(true);
    expect(route.value.listId).toBeNull();
    expect(location.pathname).toBe("/my-work");

    navigate(`${MY_WORK_PATH}/t/tk_1`);
    expect(route.value.myWork).toBe(true);
    expect(route.value.taskId).toBe("tk_1");
  });

  it("opens and closes a task without leaving My Work", () => {
    navigate(MY_WORK_PATH);
    expect(withTask("tk_1")).toBe("/my-work/t/tk_1");
    navigate(withTask("tk_1"));
    expect(withTask(null)).toBe("/my-work");
  });

  it("keeps board paths as they were", () => {
    navigate(listPath("sp_1", "ls_1"));
    expect(route.value.myWork).toBe(false);
    expect(withTask("tk_1")).toBe("/s/sp_1/l/ls_1/t/tk_1");
    expect(withTask(null)).toBe("/s/sp_1/l/ls_1");
  });
});
