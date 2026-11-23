#!/usr/bin/env node
// Guarded production deploy with a clean-origin/main check and native macOS
// (or interactive TTY) human-presence confirmation.
//
// Usage:
//   pnpm run deploy:guarded
//   pnpm run deploy:guarded -- --config /path/to/private/wrangler.jsonc
//   FLOW_WRANGLER_CONFIG=/path/to/private/wrangler.jsonc pnpm run deploy:guarded

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(root, "apps", "api");

function fail(message) {
  console.error(`\n✗ deploy refused: ${message}`);
  process.exit(1);
}

function parseConfigArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) return resolve(process.cwd(), argv[i + 1]);
    if (arg.startsWith("--config=")) return resolve(process.cwd(), arg.slice("--config=".length));
  }
  const fromEnv = process.env.FLOW_WRANGLER_CONFIG?.trim();
  if (fromEnv) return resolve(process.cwd(), fromEnv);
  return join(apiDir, "wrangler.jsonc");
}

const configPath = parseConfigArg(process.argv.slice(2));
if (!existsSync(configPath)) fail(`wrangler config not found: ${configPath}`);

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function run(label, cmd, args, cwd = root) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(`${label} failed`);
}

/** wrangler.jsonc allows comments and trailing commas; JSON.parse doesn't. */
function readJsonc(path) {
  const src = readFileSync(path, "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += src[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function humanApproval(summary) {
  if (process.platform === "darwin") {
    const text = `${summary}\n\nThis deploys to PRODUCTION.`
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    const script =
      `display dialog "${text}" with title "Flow production deploy" ` +
      `buttons {"Cancel", "Deploy"} default button "Cancel" cancel button "Cancel" ` +
      `with icon caution giving up after 180`;
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    return result.status === 0 && /button returned:Deploy/.test(result.stdout) && !/gave up:true/.test(result.stdout);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("approval needs the macOS dialog or an interactive terminal");
  }
  const code = randomBytes(3).toString("hex");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${summary}\n\nType ${code} to deploy to PRODUCTION: `);
  rl.close();
  return answer.trim() === code;
}

function assertCheckout(expectedHead) {
  const branch = git("branch", "--show-current");
  if (branch !== "main") fail(`on branch "${branch}"; deploy from main`);
  if (git("status", "--porcelain") !== "") fail("working tree has uncommitted or untracked changes");
  const current = git("rev-parse", "HEAD");
  if (current !== git("rev-parse", "origin/main")) fail("HEAD is not origin/main; push or pull first");
  if (expectedHead && current !== expectedHead) fail("HEAD moved while checks were running");
  return current;
}

console.log("→ fetching origin/main");
git("fetch", "--quiet", "origin", "main");
const head = assertCheckout(null);

run("install (frozen lockfile)", "pnpm", ["install", "--frozen-lockfile"]);
run("typecheck", "pnpm", ["typecheck"]);
run("tests", "pnpm", ["test"]);
run("web build", "pnpm", ["--filter", "@flow/web", "build"]);
const dryRunDir = mkdtempSync(join(tmpdir(), "flow-deploy-"));
try {
  run("wrangler dry run", "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--config", configPath, "--outdir", dryRunDir], apiDir);
} finally {
  rmSync(dryRunDir, { recursive: true, force: true });
}

const config = readJsonc(configPath);
const hosts = (config.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
const summary = [
  `Worker: ${config.name}`,
  `Config: ${configPath}`,
  `Routes: ${hosts.join(", ") || "(none)"}`,
  `Commit: ${head.slice(0, 7)} ${git("log", "-1", "--format=%s")}`,
].join("\n");
console.log(`\n${summary}\n\n→ waiting for approval (dialog on the Mac)`);
if (!(await humanApproval(summary))) fail("not approved");

assertCheckout(head);
run("wrangler deploy", "pnpm", ["exec", "wrangler", "deploy", "--config", configPath], apiDir);
for (const host of hosts) {
  try {
    const res = await fetch(`https://${host.replace(/\/\*$/, "")}/api/health`);
    console.log(`\n✓ ${host}/api/health → ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`\n! ${host}/api/health unreachable: ${err instanceof Error ? err.message : err}`);
  }
}
