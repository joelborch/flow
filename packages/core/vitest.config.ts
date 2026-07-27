import { defineConfig } from "vitest/config";

// Pure-function tests only (trigger matching, conditions, templates, depth cap),
// so plain node — no Workers runtime, no miniflare.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
