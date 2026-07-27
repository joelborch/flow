import { defineConfig } from "vitest/config";

/**
 * Tests cover the pure parts of the Worker — the Gleap payload mapper, token
 * hashing/minting, and Access JWT claim validation. These need Web Crypto and
 * base64 only, both present in modern Node, so they run on the default pool
 * rather than under workerd.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
