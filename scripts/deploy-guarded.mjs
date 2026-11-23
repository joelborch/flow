#!/usr/bin/env node
// Guarded macOS production deploy with checkout-boundary checks, git-tracked
// target checks, explicit environment & Cloudflare account resolution, resolved
// config inspection, and native /usr/bin/osascript human-presence confirmation.
//
// Usage (macOS only):
//   pnpm run deploy
//   pnpm run deploy -- --config apps/api/wrangler.jsonc
//   pnpm run deploy -- --config wrangler.jsonc --env production
//   pnpm run deploy:demo
//   pnpm run deploy:sandbox
//   FLOW_WRANGLER_CONFIG=apps/api/wrangler.jsonc pnpm run deploy

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_LIVE_EMAIL_VARS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_BRAND_NAME",
];
export const OSASCRIPT_PATH = "/usr/bin/osascript";

const PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "example.net", "example.org", "example"];
const SECRET_VAR_PATTERN = /(SECRET|PASSWORD|PRIVATE_KEY)/i;
const INHERITABLE_WRANGLER_KEYS = [
  "name",
  "main",
  "assets",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "keep_vars",
  "base_dir",
  "tsconfig",
  "site",
  "build",
  "alias",
  "text_blobs",
  "data_blobs",
  "wasm_modules",
];

function fail(message) {
  console.error(`\n✗ deploy refused: ${message}`);
  process.exit(1);
}

/**
 * Parse CLI arguments strictly and refuse ambient `CLOUDFLARE_ENV`. Only
 * `--config <path>`, `--config=<path>`, `-c <path>`, `--env <name>`,
 * `--env=<name>`, `-e <name>`, or `FLOW_WRANGLER_CONFIG` are accepted.
 */
export function parseDeployArgs(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const root = opts.root ?? DEFAULT_ROOT;

  if (env.CLOUDFLARE_ENV?.trim()) {
    throw new Error(
      `CLOUDFLARE_ENV is set ("${env.CLOUDFLARE_ENV}"); unset it and pass --env <name> explicitly so the target environment is unambiguous`
    );
  }

  let cliConfig = null;
  let envName = null;
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
    if (arg === "--env" || arg === "-e") {
      const next = argv[++i];
      if (!next?.trim()) throw new Error(`${arg} requires an environment name`);
      if (envName !== null) throw new Error("duplicate env flag");
      envName = next.trim();
      continue;
    }
    if (arg.startsWith("--env=")) {
      const val = arg.slice("--env=".length).trim();
      if (!val) throw new Error("--env= requires a non-empty environment name");
      if (envName !== null) throw new Error("duplicate env flag");
      envName = val;
      continue;
    }
    throw new Error(
      `unexpected argument "${arg}"; deploy-guarded only accepts --config <path> and --env <name>`
    );
  }

  let configPath;
  if (cliConfig !== null) {
    configPath = cliConfig;
  } else {
    const fromEnv = env.FLOW_WRANGLER_CONFIG?.trim();
    configPath = fromEnv ? resolve(cwd, fromEnv) : join(root, "apps", "api", "wrangler.jsonc");
  }

  return { configPath, envName };
}

/** Backwards-compatible wrapper returning only the resolved config path. */
export function parseConfigArg(argv, opts = {}) {
  return parseDeployArgs(argv, opts).configPath;
}

/** Return a copy of `env` with `CLOUDFLARE_ENV` stripped so Wrangler cannot silently pick one up. */
export function sanitizedWranglerEnv(env = process.env) {
  const clean = { ...env };
  delete clean.CLOUDFLARE_ENV;
  return clean;
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

/**
 * String-aware JSONC parser: strips comments (`//`, `/* ... *\/`) and trailing
 * commas strictly outside double-quoted string literals so string contents like
 * `", }"` or `"//"` are never altered.
 */
export function parseJsonc(src) {
  let noComments = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      noComments += ch;
      if (ch === "\\") {
        if (i + 1 < src.length) noComments += src[++i];
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      noComments += ch;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length) noComments += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) throw new Error("unterminated block comment in wrangler config");
      i = close + 1;
    } else {
      noComments += ch;
    }
  }

  let cleaned = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      cleaned += ch;
      if (ch === "\\") {
        if (i + 1 < noComments.length) cleaned += noComments[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === "}" || noComments[j] === "]") continue;
    }
    cleaned += ch;
  }

  return JSON.parse(cleaned);
}

/** Read and parse a JSONC file. */
export function readJsonc(path) {
  return parseJsonc(readFileSync(path, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Verify a path field resolves strictly inside `realRoot` relative to `baseDir` (including symlinks). */
function resolveContainedPath(rawValue, fieldName, baseDir, realRoot, { mustExist = false } = {}) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  const rawResolved = resolve(baseDir, rawValue);
  if (!isWithinDir(realRoot, rawResolved)) {
    throw new Error(`${fieldName} escapes checkout (${rawValue} -> ${rawResolved})`);
  }
  const ancestorReal = resolveRealThroughAncestors(rawResolved);
  if (!isWithinDir(realRoot, ancestorReal)) {
    throw new Error(`${fieldName} symlink escapes checkout (${rawValue} -> ${ancestorReal})`);
  }
  if (existsSync(rawResolved)) {
    const real = realpathSync(rawResolved);
    if (!isWithinDir(realRoot, real)) {
      throw new Error(`${fieldName} resolves outside checkout (${rawValue} -> ${real})`);
    }
    return real;
  }
  if (mustExist) {
    throw new Error(`${fieldName} does not exist: ${ancestorReal}`);
  }
  return ancestorReal;
}

/**
 * Compute the effective Wrangler target configuration for `envName` (or top-level
 * when `envName` is null). Follows Wrangler inheritance: top-level inheritable
 * settings carry over unless overridden, whereas `vars`, `routes`, and bindings
 * are NOT inherited into named `env.<name>` blocks.
 */
export function resolveEffectiveConfig(config, envName = null) {
  if (!envName) {
    return {
      environment: "(top-level)",
      envName: null,
      effectiveConfig: config,
    };
  }
  if (!isPlainObject(config.env) || !isPlainObject(config.env[envName])) {
    throw new Error(`wrangler environment "${envName}" is not defined in config.env`);
  }
  const envBlock = config.env[envName];
  const merged = {};
  for (const key of INHERITABLE_WRANGLER_KEYS) {
    if (envBlock[key] !== undefined) merged[key] = envBlock[key];
    else if (config[key] !== undefined) merged[key] = config[key];
  }
  if (envBlock.name === undefined && typeof config.name === "string" && config.name.trim()) {
    merged.name = `${config.name}-${envName}`;
  }
  // Non-inheritable bindings/vars/routes come exclusively from the selected env block.
  for (const [key, val] of Object.entries(envBlock)) {
    if (!INHERITABLE_WRANGLER_KEYS.includes(key)) merged[key] = val;
  }
  return {
    environment: envName,
    envName,
    effectiveConfig: merged,
  };
}

function validateTargetBlock(target, labelPrefix, configDir, inheritedBaseDir, realRoot, requireAssetsExist) {
  let effectiveBaseDir = inheritedBaseDir;
  if (target.base_dir !== undefined) {
    effectiveBaseDir = resolveContainedPath(
      target.base_dir,
      `${labelPrefix}base_dir`,
      configDir,
      realRoot,
      { mustExist: true }
    );
  }
  const baseCandidates = effectiveBaseDir === configDir ? [configDir] : [effectiveBaseDir, configDir];

  if (target.alias !== undefined) {
    if (!isPlainObject(target.alias)) {
      throw new Error(`${labelPrefix}alias must be an object`);
    }
    if (Object.keys(target.alias).length > 0) {
      throw new Error(
        `${labelPrefix}alias is not allowed in guarded deploys (${Object.keys(target.alias).join(", ")})`
      );
    }
  }

  if (target.build !== undefined) {
    if (!isPlainObject(target.build)) {
      throw new Error(`${labelPrefix}build must be an object`);
    }
    if (target.build.command !== undefined && target.build.command !== null) {
      throw new Error(`${labelPrefix}build.command is not allowed in guarded deploys`);
    }
    if (target.build.cwd !== undefined) {
      for (const base of baseCandidates) {
        resolveContainedPath(target.build.cwd, `${labelPrefix}build.cwd`, base, realRoot);
      }
    }
    if (target.build.watch_dir !== undefined) {
      const dirs = Array.isArray(target.build.watch_dir)
        ? target.build.watch_dir
        : [target.build.watch_dir];
      for (const dir of dirs) {
        for (const base of baseCandidates) {
          resolveContainedPath(dir, `${labelPrefix}build.watch_dir`, base, realRoot);
        }
      }
    }
  }

  let resolvedMain = null;
  if (target.main !== undefined) {
    resolvedMain = resolveContainedPath(target.main, `${labelPrefix}main`, effectiveBaseDir, realRoot, {
      mustExist: true,
    });
    if (effectiveBaseDir !== configDir) {
      const fromConfig = resolve(configDir, target.main);
      if (!isWithinDir(realRoot, fromConfig)) {
        throw new Error(`${labelPrefix}main escapes checkout relative to config dir (${target.main})`);
      }
    }
  }

  let resolvedAssetsDir = null;
  if (target.assets !== undefined) {
    if (!isPlainObject(target.assets)) {
      throw new Error(`${labelPrefix}assets must be an object`);
    }
    if (target.assets.directory !== undefined) {
      resolvedAssetsDir = resolveContainedPath(
        target.assets.directory,
        `${labelPrefix}assets.directory`,
        effectiveBaseDir,
        realRoot,
        { mustExist: requireAssetsExist }
      );
    }
  }

  if (target.site !== undefined) {
    if (!isPlainObject(target.site)) {
      throw new Error(`${labelPrefix}site must be an object`);
    }
    if (target.site.bucket !== undefined) {
      for (const base of baseCandidates) {
        resolveContainedPath(target.site.bucket, `${labelPrefix}site.bucket`, base, realRoot);
      }
    }
  }

  if (target.tsconfig !== undefined) {
    for (const base of baseCandidates) {
      resolveContainedPath(target.tsconfig, `${labelPrefix}tsconfig`, base, realRoot);
    }
  }

  for (const blobField of ["text_blobs", "data_blobs", "wasm_modules"]) {
    if (target[blobField] !== undefined) {
      if (!isPlainObject(target[blobField])) {
        throw new Error(`${labelPrefix}${blobField} must be an object`);
      }
      for (const [blobKey, blobPath] of Object.entries(target[blobField])) {
        for (const base of baseCandidates) {
          resolveContainedPath(blobPath, `${labelPrefix}${blobField}.${blobKey}`, base, realRoot);
        }
      }
    }
  }

  return { resolvedMain, resolvedAssetsDir, resolvedBaseDir: effectiveBaseDir };
}

/**
 * Verify that `main` (and `assets.directory`, or `apps/web` for built SPA outputs)
 * is tracked by git in `realRoot` so untracked or gitignored files cannot deploy.
 */
export function assertTrackedDeployPaths(
  { resolvedMain, resolvedAssetsDir },
  checkoutRoot
) {
  const realRoot = realpathSync(checkoutRoot);

  if (resolvedMain) {
    const relMain = relative(realRoot, resolvedMain);
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relMain], {
      cwd: realRoot,
      encoding: "utf8",
    });
    if (tracked.status !== 0) {
      throw new Error(`main is not tracked by git: ${relMain}`);
    }
  }

  if (resolvedAssetsDir) {
    const distDir = join(realRoot, "apps", "web", "dist");
    const demoDistDir = join(realRoot, "apps", "web", "dist-demo");
    if (resolvedAssetsDir === distDir || resolvedAssetsDir === demoDistDir) {
      const webPkg = spawnSync(
        "git",
        ["ls-files", "--error-unmatch", "--", "apps/web/package.json"],
        { cwd: realRoot, encoding: "utf8" }
      );
      if (webPkg.status !== 0) {
        throw new Error("apps/web/package.json is not tracked by git");
      }
      const webDirty = execFileSync("git", ["status", "--porcelain", "--", "apps/web"], {
        cwd: realRoot,
        encoding: "utf8",
      }).trim();
      if (webDirty !== "") {
        throw new Error("apps/web has uncommitted or untracked changes");
      }
    } else {
      const relAssets = relative(realRoot, resolvedAssetsDir) || ".";
      const trackedFiles = execFileSync("git", ["ls-files", "--", relAssets], {
        cwd: realRoot,
        encoding: "utf8",
      }).trim();
      if (!trackedFiles) {
        throw new Error(`assets.directory is not tracked by git: ${relAssets}`);
      }
      const untrackedOrIgnored = execFileSync(
        "git",
        ["status", "--porcelain", "--ignored", "--", relAssets],
        { cwd: realRoot, encoding: "utf8" }
      ).trim();
      if (untrackedOrIgnored !== "") {
        throw new Error(`assets.directory contains untracked or gitignored files: ${relAssets}`);
      }
    }
  }
}

/**
 * Verify `configPath`, its effective target, and all `env.<name>` blocks keep
 * every path (`main`, `assets.directory`, `base_dir`, `site.bucket`, `tsconfig`,
 * `text_blobs`, `build`, `alias`) inside `checkoutRoot`, and verify git-tracked
 * `main` and `assets` targets unless `checkGitTracked: false`.
 */
export function validateDeployConfig(configPath, checkoutRoot, opts = {}) {
  const requireAssetsExist = opts.requireAssetsExist ?? false;
  const checkGitTracked = opts.checkGitTracked ?? true;
  const envName = opts.envName ?? null;
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
  const config = parseJsonc(rawBytes.toString("utf8"));
  if (!isPlainObject(config)) {
    throw new Error(`wrangler config must parse to an object: ${realConfigPath}`);
  }

  const configDir = dirname(realConfigPath);
  const topPaths = validateTargetBlock(
    config,
    "",
    configDir,
    configDir,
    realRoot,
    envName ? false : requireAssetsExist
  );

  if (config.env !== undefined) {
    if (!isPlainObject(config.env)) {
      throw new Error("env must be an object");
    }
    for (const [blockName, envBlock] of Object.entries(config.env)) {
      if (!isPlainObject(envBlock)) {
        throw new Error(`env.${blockName} must be an object`);
      }
      validateTargetBlock(
        envBlock,
        `env.${blockName}.`,
        configDir,
        topPaths.resolvedBaseDir,
        realRoot,
        blockName === envName ? requireAssetsExist : false
      );
    }
  }

  const { environment, effectiveConfig } = resolveEffectiveConfig(config, envName);
  const effectivePaths = validateTargetBlock(
    effectiveConfig,
    envName ? `env.${envName}.` : "",
    configDir,
    configDir,
    realRoot,
    requireAssetsExist
  );

  if (checkGitTracked) {
    assertTrackedDeployPaths(effectivePaths, realRoot);
  }

  return {
    configPath: realConfigPath,
    config,
    effectiveConfig,
    environment,
    envName,
    configSha256,
    resolvedMain: effectivePaths.resolvedMain,
    resolvedAssetsDir: effectivePaths.resolvedAssetsDir,
  };
}

/** True when `email` is empty, malformed, or uses a placeholder `.example` domain. */
export function isPlaceholderEmail(email) {
  const trimmed = String(email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return true;
  const domain = trimmed.slice(at + 1);
  return PLACEHOLDER_EMAIL_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`));
}

/**
 * Fail closed at deploy time ONLY when live email sending is enabled
 * (`EMAIL_DRY_RUN === "false"`). Applied even when `keep_vars` is true, and
 * skipped only for assets-only/dev/sandbox configs. `EMAIL_REQUESTER_FROM_NAME`
 * remains optional; Access vars do NOT mark email as live.
 */
export function assertDeployConfigEmailVars(effectiveConfig) {
  if (!effectiveConfig.main) return;
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  if (vars.DEV_NO_AUTH === "true" || vars.SANDBOX === "true") return;
  if (vars.EMAIL_DRY_RUN !== "false") return;

  const missing = [];
  for (const key of REQUIRED_LIVE_EMAIL_VARS) {
    const val = vars[key];
    if (typeof val !== "string" || !val.trim()) missing.push(key);
  }
  if (typeof vars.EMAIL_FROM === "string" && vars.EMAIL_FROM.trim() && isPlaceholderEmail(vars.EMAIL_FROM)) {
    missing.push(`EMAIL_FROM (placeholder "${vars.EMAIL_FROM.trim()}")`);
  }
  if (missing.length > 0) {
    throw new Error(
      `live email config (EMAIL_DRY_RUN = "false") requires explicit sender branding (${missing.join(", ")})`
    );
  }
}

/** Pick the Vite build script matching `resolvedAssetsDir`, or null for worker-only/static configs. */
export function selectWebBuildScript(resolvedAssetsDir, checkoutRoot) {
  if (!resolvedAssetsDir) return null;
  const realRoot = realpathSync(checkoutRoot);
  if (resolvedAssetsDir === join(realRoot, "apps", "web", "dist-demo")) return "build:demo";
  if (resolvedAssetsDir === join(realRoot, "apps", "web", "dist")) return "build";
  return null;
}

/** Parse `wrangler whoami --json` stdout and resolve the single target Cloudflare account. */
export function resolveCloudflareAccount({ config, env = process.env, whoami = null }) {
  const cfgId = typeof config.account_id === "string" ? config.account_id.trim() : "";
  const envId = typeof env.CLOUDFLARE_ACCOUNT_ID === "string" ? env.CLOUDFLARE_ACCOUNT_ID.trim() : "";
  if (cfgId && envId && cfgId !== envId) {
    throw new Error(
      `account_id in config (${cfgId}) conflicts with CLOUDFLARE_ACCOUNT_ID (${envId})`
    );
  }
  const explicitId = cfgId || envId || null;
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];

  if (explicitId) {
    const matched = accounts.find((a) => a && a.id === explicitId);
    return matched
      ? { id: matched.id, name: matched.name ?? null, label: `${matched.name} (${matched.id})` }
      : { id: explicitId, name: null, label: `${explicitId} (configured)` };
  }

  if (!whoami || whoami.loggedIn !== true) {
    throw new Error("could not determine Cloudflare account (run `wrangler login` or set account_id)");
  }
  if (accounts.length === 1) {
    const acct = accounts[0];
    return { id: acct.id, name: acct.name ?? null, label: `${acct.name} (${acct.id})` };
  }
  if (accounts.length > 1) {
    throw new Error(
      `multiple Cloudflare accounts (${accounts.map((a) => `${a.name} <${a.id}>`).join(", ")}); set account_id or CLOUDFLARE_ACCOUNT_ID explicitly`
    );
  }
  throw new Error("wrangler whoami returned zero Cloudflare accounts");
}

function queryWranglerWhoami(apiDir, wranglerEnv) {
  const res = spawnSync("pnpm", ["exec", "wrangler", "whoami", "--json"], {
    cwd: apiDir,
    env: wranglerEnv,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  const raw = res.stdout ?? "";
  const brace = raw.indexOf("{");
  if (brace === -1) return null;
  try {
    return JSON.parse(raw.slice(brace));
  } catch {
    return null;
  }
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

/** Format full resolved deploy summary (environment, account, gitignored/tracked SHA-256, paths, bindings, vars). */
export function formatResolvedConfig({
  effectiveConfig,
  environment,
  account,
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
  const hosts = (effectiveConfig.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  const varEntries = Object.keys(vars)
    .sort()
    .map((key) => {
      const value = SECRET_VAR_PATTERN.test(key) ? "[redacted]" : JSON.stringify(vars[key]);
      return `  ${key} = ${value}`;
    });

  return [
    `Worker:      ${effectiveConfig.name ?? "(unnamed)"}`,
    `Environment: ${environment ?? "(top-level)"}`,
    `Account:     ${account?.label ?? "(unknown)"}`,
    `Config:      ${relConfig} (${gitignored ? "gitignored" : "tracked"}, sha256 ${configSha256.slice(0, 12)})`,
    `Main:        ${relMain}`,
    `Assets:      ${relAssets}`,
    `Routes:      ${hosts.join(", ") || "(none)"} (workers_dev: ${Boolean(effectiveConfig.workers_dev)})`,
    `Bindings:    ${summarizeBindings(effectiveConfig)}`,
    `Commit:      ${head.slice(0, 7)} ${commitSubject}`,
    `Vars:`,
    ...(varEntries.length > 0 ? varEntries : ["  (none)"]),
  ].join("\n");
}

/** Compact summary shown inside the macOS human-presence confirmation dialog. */
export function formatDialogSummary({
  effectiveConfig,
  environment,
  account,
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
  const hosts = (effectiveConfig.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  const keyVars = [
    `APP_HOSTNAME=${vars.APP_HOSTNAME ?? "(unset)"}`,
    `EMAIL_FROM=${vars.EMAIL_FROM ?? "(unset)"}`,
    `EMAIL_DRY_RUN=${vars.EMAIL_DRY_RUN ?? "(unset)"}`,
  ].join(", ");
  return [
    `Worker: ${effectiveConfig.name ?? "(unnamed)"}`,
    `Environment: ${environment ?? "(top-level)"}`,
    `Account: ${account?.label ?? "(unknown)"}`,
    `Config: ${relative(realRoot, configPath)} (${gitignored ? "gitignored" : "tracked"}, sha256 ${configSha256.slice(0, 12)})`,
    `Main: ${resolvedMain ? relative(realRoot, resolvedMain) : "(none — assets only)"}`,
    `Assets: ${resolvedAssetsDir ? relative(realRoot, resolvedAssetsDir) : "(none)"}`,
    `Routes: ${hosts.join(", ") || "(none)"}`,
    `Vars: ${keyVars}`,
    `Commit: ${head.slice(0, 7)} ${commitSubject}`,
  ].join("\n");
}

/**
 * Request physical macOS human-presence approval via `/usr/bin/osascript`.
 * Terminal prompts are NOT human presence; off macOS, refuse cleanly.
 */
export async function humanApproval(summary, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? spawnSync;
  if (platform !== "darwin") {
    throw new Error(
      "guarded production deploy requires macOS (/usr/bin/osascript) human-presence approval; off macOS, build and deploy with wrangler directly"
    );
  }
  const text = `${summary}\n\nThis deploys to PRODUCTION.`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  const script =
    `display dialog "${text}" with title "Flow production deploy" ` +
    `buttons {"Cancel", "Deploy"} default button "Cancel" cancel button "Cancel" ` +
    `with icon caution giving up after 180`;
  const result = spawn(OSASCRIPT_PATH, ["-e", script], { encoding: "utf8" });
  return result.status === 0 && /button returned:Deploy/.test(result.stdout) && !/gave up:true/.test(result.stdout);
}

async function main() {
  const root = DEFAULT_ROOT;
  const realRoot = realpathSync(root);
  const apiDir = join(realRoot, "apps", "api");

  const { configPath, envName } = parseDeployArgs(process.argv.slice(2), { root: realRoot });
  const initial = validateDeployConfig(configPath, realRoot, { envName });
  assertDeployConfigEmailVars(initial.effectiveConfig);

  if (process.platform !== "darwin") {
    fail(
      "guarded production deploy requires macOS (/usr/bin/osascript) human-presence approval; off macOS, build and deploy with wrangler directly"
    );
  }

  const wranglerEnv = sanitizedWranglerEnv(process.env);
  const git = (...args) => execFileSync("git", args, { cwd: realRoot, encoding: "utf8" }).trim();
  const run = (label, cmd, args, cwd = realRoot, env = process.env) => {
    console.log(`\n→ ${label}`);
    const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
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
    const verified = validateDeployConfig(initial.configPath, realRoot, {
      envName,
      requireAssetsExist: true,
    });
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
  if (buildScript && initial.resolvedAssetsDir) {
    rmSync(initial.resolvedAssetsDir, { recursive: true, force: true });
    run(`web ${buildScript}`, "pnpm", ["--filter", "@flow/web", buildScript]);
  }

  const afterBuild = assertConfigUnchanged(initial.configSha256);
  assertDeployConfigEmailVars(afterBuild.effectiveConfig);

  const whoami = queryWranglerWhoami(apiDir, wranglerEnv);
  const account = resolveCloudflareAccount({
    config: afterBuild.effectiveConfig,
    env: wranglerEnv,
    whoami,
  });

  const envFlags = envName ? ["--env", envName] : [];
  const dryRunDir = mkdtempSync(join(tmpdir(), "flow-deploy-"));
  try {
    run(
      "wrangler dry run",
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--config", afterBuild.configPath, ...envFlags, "--outdir", dryRunDir],
      apiDir,
      wranglerEnv
    );
  } finally {
    rmSync(dryRunDir, { recursive: true, force: true });
  }

  const relConfig = relative(realRoot, afterBuild.configPath);
  const gitignored = spawnSync("git", ["check-ignore", "-q", relConfig], { cwd: realRoot }).status === 0;
  const info = {
    ...afterBuild,
    account,
    gitignored,
    checkoutRoot: realRoot,
    head,
    commitSubject: git("log", "-1", "--format=%s"),
  };

  console.log(`\n${formatResolvedConfig(info)}\n\n→ waiting for approval (macOS dialog via ${OSASCRIPT_PATH})`);
  if (!(await humanApproval(formatDialogSummary(info)))) fail("not approved");

  assertCheckout(head);
  assertConfigUnchanged(initial.configSha256);
  run(
    "wrangler deploy",
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", afterBuild.configPath, ...envFlags],
    apiDir,
    wranglerEnv
  );

  const hosts = (afterBuild.effectiveConfig.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern));
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
