#!/usr/bin/env node
// Guarded production deploy with checkout-boundary checks, clean-origin/main
// verification, resolved config inspection, and native macOS (or interactive TTY)
// human-presence confirmation.
//
// Usage:
//   pnpm run deploy
//   pnpm run deploy -- --config apps/api/wrangler.jsonc
//   pnpm run deploy:demo
//   pnpm run deploy:sandbox
//   FLOW_WRANGLER_CONFIG=apps/api/wrangler.jsonc pnpm run deploy

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_PROD_EMAIL_VARS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_BRAND_NAME",
  "EMAIL_REQUESTER_FROM_NAME",
];
export const DEFAULT_EMAIL_FROM = "flow@mail.example.com";

const SECRET_VAR_PATTERN = /(SECRET|PASSWORD|PRIVATE_KEY)/i;

function fail(message) {
  console.error(`\n✗ deploy refused: ${message}`);
  process.exit(1);
}

/**
 * Parse CLI arguments strictly: only `--config <path>`, `--config=<path>`,
 * `-c <path>`, or `FLOW_WRANGLER_CONFIG` may choose a config inside the
 * checkout; unexpected flags or positional args are refused.
 */
export function parseConfigArg(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const root = opts.root ?? DEFAULT_ROOT;

  let cliConfig = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--config" || arg === "-c") {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a path`);
      if (cliConfig !== null) throw new Error("duplicate config flag");
      cliConfig = resolve(cwd, next);
      continue;
    }
    if (arg.startsWith("--config=")) {
      const val = arg.slice("--config=".length);
      if (!val) throw new Error("--config= requires a non-empty path");
      if (cliConfig !== null) throw new Error("duplicate config flag");
      cliConfig = resolve(cwd, val);
      continue;
    }
    throw new Error(`unexpected argument "${arg}"; deploy-guarded only accepts --config <path>`);
  }

  if (cliConfig !== null) return cliConfig;
  const fromEnv = env.FLOW_WRANGLER_CONFIG?.trim();
  if (fromEnv) return resolve(cwd, fromEnv);
  return join(root, "apps", "api", "wrangler.jsonc");
}

/** Return true iff `targetReal` equals `parentReal` or lies strictly inside it. */
export function isWithinDir(parentReal, targetReal) {
  const rel = relative(parentReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `absPath` through the deepest existing ancestor's `realpathSync`, so
 * symlinks in parent directories are caught even before build output exists.
 */
export function resolveRealThroughAncestors(absPath) {
  const normalized = resolve(absPath);
  const tail = [];
  let cur = normalized;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return normalized;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

/** wrangler.jsonc allows comments and trailing commas; JSON.parse doesn't. */
export function readJsonc(path) {
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
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function validateTargetPaths(target, labelPrefix, configDir, realRoot, requireAssetsExist) {
  let resolvedMain = null;
  if (target.main !== undefined) {
    if (typeof target.main !== "string" || !target.main.trim()) {
      throw new Error(`${labelPrefix}main must be a non-empty string`);
    }
    const rawMain = resolve(configDir, target.main);
    if (!isWithinDir(realRoot, rawMain)) {
      throw new Error(`${labelPrefix}main escapes checkout (${target.main} -> ${rawMain})`);
    }
    const ancestorRealMain = resolveRealThroughAncestors(rawMain);
    if (!isWithinDir(realRoot, ancestorRealMain)) {
      throw new Error(`${labelPrefix}main symlink escapes checkout (${target.main} -> ${ancestorRealMain})`);
    }
    if (!existsSync(rawMain)) {
      throw new Error(`${labelPrefix}main does not exist: ${rawMain}`);
    }
    const realMain = realpathSync(rawMain);
    if (!isWithinDir(realRoot, realMain)) {
      throw new Error(`${labelPrefix}main resolves outside checkout (${target.main} -> ${realMain})`);
    }
    resolvedMain = realMain;
  }

  let resolvedAssetsDir = null;
  if (target.assets !== undefined) {
    if (!target.assets || typeof target.assets !== "object" || Array.isArray(target.assets)) {
      throw new Error(`${labelPrefix}assets must be an object`);
    }
    if (target.assets.directory !== undefined) {
      if (typeof target.assets.directory !== "string" || !target.assets.directory.trim()) {
        throw new Error(`${labelPrefix}assets.directory must be a non-empty string`);
      }
      const rawAssets = resolve(configDir, target.assets.directory);
      if (!isWithinDir(realRoot, rawAssets)) {
        throw new Error(
          `${labelPrefix}assets.directory escapes checkout (${target.assets.directory} -> ${rawAssets})`
        );
      }
      const ancestorRealAssets = resolveRealThroughAncestors(rawAssets);
      if (!isWithinDir(realRoot, ancestorRealAssets)) {
        throw new Error(
          `${labelPrefix}assets.directory symlink escapes checkout (${target.assets.directory} -> ${ancestorRealAssets})`
        );
      }
      if (existsSync(rawAssets)) {
        const realAssets = realpathSync(rawAssets);
        if (!isWithinDir(realRoot, realAssets)) {
          throw new Error(
            `${labelPrefix}assets.directory resolves outside checkout (${target.assets.directory} -> ${realAssets})`
          );
        }
        resolvedAssetsDir = realAssets;
      } else {
        if (requireAssetsExist) {
          throw new Error(`${labelPrefix}assets.directory does not exist: ${ancestorRealAssets}`);
        }
        resolvedAssetsDir = ancestorRealAssets;
      }
    }
  }

  return { resolvedMain, resolvedAssetsDir };
}

/**
 * Verify that `configPath`, its `main`, and its `assets.directory` (top-level
 * and every `env.<name>` override) resolve strictly inside `checkoutRoot`.
 */
export function validateDeployConfig(configPath, checkoutRoot, opts = {}) {
  const requireAssetsExist = opts.requireAssetsExist ?? false;
  const realRoot = realpathSync(checkoutRoot);

  if (!existsSync(configPath)) {
    throw new Error(`wrangler config not found: ${configPath}`);
  }
  const realConfigPath = realpathSync(configPath);
  if (!isWithinDir(realRoot, realConfigPath)) {
    throw new Error(`wrangler config must be inside this checkout (${realRoot}): ${realConfigPath}`);
  }

  const rawBytes = readFileSync(realConfigPath);
  const configSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const config = readJsonc(realConfigPath);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`wrangler config must parse to an object: ${realConfigPath}`);
  }

  const configDir = dirname(realConfigPath);
  const { resolvedMain, resolvedAssetsDir } = validateTargetPaths(
    config,
    "",
    configDir,
    realRoot,
    requireAssetsExist
  );

  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) {
      throw new Error("env must be an object");
    }
    for (const [envName, envBlock] of Object.entries(config.env)) {
      if (!envBlock || typeof envBlock !== "object" || Array.isArray(envBlock)) {
        throw new Error(`env.${envName} must be an object`);
      }
      validateTargetPaths(envBlock, `env.${envName}.`, configDir, realRoot, requireAssetsExist);
    }
  }

  return {
    configPath: realConfigPath,
    config,
    configSha256,
    resolvedMain,
    resolvedAssetsDir,
  };
}

/**
 * Mirror apps/api `signInMode` Access check so deploy-guarded catches missing
 * production email branding vars before running Wrangler.
 */
function hasConfiguredAccess(vars) {
  const aud = String(vars.ACCESS_AUD ?? "").trim();
  const team = String(vars.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const teamSet = team.endsWith(".cloudflareaccess.com") && team !== "your-team.cloudflareaccess.com";
  return /^[0-9a-f]{64}$/i.test(aud) && teamSet;
}

/** Fail closed when a production Worker config omits explicit email branding vars. */
export function assertDeployConfigEmailVars(config) {
  if (!config.main || config.keep_vars === true) return;
  const vars = config.vars && typeof config.vars === "object" ? config.vars : {};
  if (vars.DEV_NO_AUTH === "true" || vars.SANDBOX === "true") return;

  const isProd = hasConfiguredAccess(vars) || vars.EMAIL_DRY_RUN === "false";
  if (!isProd) return;

  const missing = [];
  for (const key of REQUIRED_PROD_EMAIL_VARS) {
    const val = vars[key];
    if (typeof val !== "string" || !val.trim()) missing.push(key);
  }
  if (typeof vars.EMAIL_FROM === "string" && vars.EMAIL_FROM.trim().toLowerCase() === DEFAULT_EMAIL_FROM) {
    missing.push(`EMAIL_FROM (placeholder ${DEFAULT_EMAIL_FROM})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `production config requires explicit email branding vars (${missing.join(", ")})`
    );
  }
}

/** Pick the Vite build script matching `resolvedAssetsDir`, or null for API-only configs. */
export function selectWebBuildScript(resolvedAssetsDir, checkoutRoot) {
  if (!resolvedAssetsDir) return null;
  const demoOut = join(realpathSync(checkoutRoot), "apps", "web", "dist-demo");
  return resolvedAssetsDir === demoOut ? "build:demo" : "build";
}

function summarizeBindings(config) {
  const parts = [];
  if (config.durable_objects?.bindings?.length) {
    parts.push(
      `DO[${config.durable_objects.bindings.map((b) => `${b.name}:${b.class_name}`).join(", ")}]`
    );
  }
  if (config.r2_buckets?.length) {
    parts.push(`R2[${config.r2_buckets.map((b) => `${b.binding}:${b.bucket_name}`).join(", ")}]`);
  }
  if (config.queues?.producers?.length) {
    parts.push(`Queues[${config.queues.producers.map((q) => `${q.binding}:${q.queue}`).join(", ")}]`);
  }
  if (config.send_email?.length) {
    parts.push(`Email[${config.send_email.map((e) => e.name).join(", ")}]`);
  }
  if (config.ratelimits?.length) {
    parts.push(`RateLimits[${config.ratelimits.map((r) => r.name).join(", ")}]`);
  }
  if (config.triggers?.crons?.length) {
    parts.push(`Crons[${config.triggers.crons.join(", ")}]`);
  }
  return parts.join(", ") || "(none)";
}

/**
 * Format the resolved deploy configuration (including gitignored status,
 * SHA-256, resolved paths, bindings, routes, and redacted sorted vars) so
 * operators always inspect what is actually about to deploy.
 */
export function formatResolvedConfig({
  config,
  configPath,
  configSha256,
  gitignored,
  resolvedMain,
  resolvedAssetsDir,
  checkoutRoot,
  head,
  commitSubject,
}) {
  const realRoot = realpathSync(checkoutRoot);
  const relConfig = relative(realRoot, configPath) || configPath;
  const relMain = resolvedMain ? relative(realRoot, resolvedMain) : "(none — assets only)";
  const relAssets = resolvedAssetsDir ? relative(realRoot, resolvedAssetsDir) : "(none)";
  const hosts = (config.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  const vars = config.vars && typeof config.vars === "object" ? config.vars : {};
  const varEntries = Object.keys(vars)
    .sort()
    .map((key) => {
      const value = SECRET_VAR_PATTERN.test(key) ? "[redacted]" : JSON.stringify(vars[key]);
      return `  ${key} = ${value}`;
    });

  const lines = [
    `Worker:   ${config.name ?? "(unnamed)"}`,
    `Config:   ${relConfig} (${gitignored ? "gitignored" : "tracked"}, sha256 ${configSha256.slice(0, 12)})`,
    `Main:     ${relMain}`,
    `Assets:   ${relAssets}`,
    `Routes:   ${hosts.join(", ") || "(none)"} (workers_dev: ${Boolean(config.workers_dev)})`,
    `Bindings: ${summarizeBindings(config)}`,
    `Commit:   ${head.slice(0, 7)} ${commitSubject}`,
    `Vars:`,
    ...(varEntries.length > 0 ? varEntries : ["  (none)"]),
  ];
  return lines.join("\n");
}

function formatDialogSummary({ config, configPath, configSha256, gitignored, resolvedMain, resolvedAssetsDir, checkoutRoot, head, commitSubject }) {
  const realRoot = realpathSync(checkoutRoot);
  const hosts = (config.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  const vars = config.vars && typeof config.vars === "object" ? config.vars : {};
  const keyVars = [
    `APP_HOSTNAME=${vars.APP_HOSTNAME ?? "(unset)"}`,
    `EMAIL_FROM=${vars.EMAIL_FROM ?? "(unset)"}`,
    `EMAIL_DRY_RUN=${vars.EMAIL_DRY_RUN ?? "(unset)"}`,
  ].join(", ");
  return [
    `Worker: ${config.name}`,
    `Config: ${relative(realRoot, configPath)} (${gitignored ? "gitignored" : "tracked"}, sha256 ${configSha256.slice(0, 12)})`,
    `Main: ${resolvedMain ? relative(realRoot, resolvedMain) : "(none — assets only)"}`,
    `Assets: ${resolvedAssetsDir ? relative(realRoot, resolvedAssetsDir) : "(none)"}`,
    `Routes: ${hosts.join(", ") || "(none)"}`,
    `Vars: ${keyVars}`,
    `Commit: ${head.slice(0, 7)} ${commitSubject}`,
  ].join("\n");
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

async function main() {
  const root = DEFAULT_ROOT;
  const realRoot = realpathSync(root);
  const apiDir = join(realRoot, "apps", "api");

  const requestedConfig = parseConfigArg(process.argv.slice(2), { root: realRoot });
  const initial = validateDeployConfig(requestedConfig, realRoot);
  assertDeployConfigEmailVars(initial.config);

  const git = (...args) => execFileSync("git", args, { cwd: realRoot, encoding: "utf8" }).trim();
  const run = (label, cmd, args, cwd = realRoot) => {
    console.log(`\n→ ${label}`);
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
    if (result.status !== 0) fail(`${label} failed`);
  };
  const assertCheckout = (expectedHead) => {
    const branch = git("branch", "--show-current");
    if (branch !== "main") fail(`on branch "${branch}"; deploy from main`);
    if (git("status", "--porcelain") !== "") fail("working tree has uncommitted or untracked changes");
    const current = git("rev-parse", "HEAD");
    if (current !== git("rev-parse", "origin/main")) fail("HEAD is not origin/main; push or pull first");
    if (expectedHead && current !== expectedHead) fail("HEAD moved while checks were running");
    return current;
  };
  const assertConfigUnchanged = (expectedSha256) => {
    const verified = validateDeployConfig(initial.configPath, realRoot, { requireAssetsExist: true });
    if (verified.configSha256 !== expectedSha256) {
      fail("wrangler config changed while deploy checks were running");
    }
    return verified;
  };

  console.log("→ fetching origin/main");
  git("fetch", "--quiet", "origin", "main");
  const head = assertCheckout(null);

  run("install (frozen lockfile)", "pnpm", ["install", "--frozen-lockfile"]);
  run("typecheck", "pnpm", ["typecheck"]);
  run("tests", "pnpm", ["test"]);

  const buildScript = selectWebBuildScript(initial.resolvedAssetsDir, realRoot);
  if (buildScript) {
    run(`web ${buildScript}`, "pnpm", ["--filter", "@flow/web", buildScript]);
  }

  const afterBuild = assertConfigUnchanged(initial.configSha256);
  assertDeployConfigEmailVars(afterBuild.config);

  const dryRunDir = mkdtempSync(join(tmpdir(), "flow-deploy-"));
  try {
    run(
      "wrangler dry run",
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--config", afterBuild.configPath, "--outdir", dryRunDir],
      apiDir
    );
  } finally {
    rmSync(dryRunDir, { recursive: true, force: true });
  }

  const relConfig = relative(realRoot, afterBuild.configPath);
  const gitignored = spawnSync("git", ["check-ignore", "-q", relConfig], { cwd: realRoot }).status === 0;
  const info = {
    ...afterBuild,
    gitignored,
    checkoutRoot: realRoot,
    head,
    commitSubject: git("log", "-1", "--format=%s"),
  };

  console.log(`\n${formatResolvedConfig(info)}\n\n→ waiting for approval (dialog on the Mac)`);
  if (!(await humanApproval(formatDialogSummary(info)))) fail("not approved");

  assertCheckout(head);
  assertConfigUnchanged(initial.configSha256);
  run("wrangler deploy", "pnpm", ["exec", "wrangler", "deploy", "--config", afterBuild.configPath], apiDir);

  const hosts = (afterBuild.config.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  for (const host of hosts) {
    try {
      const res = await fetch(`https://${host.replace(/\/\*$/, "")}/api/health`);
      console.log(`\n✓ ${host}/api/health → ${res.status} ${await res.text()}`);
    } catch (err) {
      console.error(`\n! ${host}/api/health unreachable: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
