#!/usr/bin/env node
// Guarded macOS production deploy with checkout-boundary checks, git-tracked
// target checks (no skip-worktree/assume-unchanged or gitignored source files),
// strict .env/env-override rejection, explicit environment & Cloudflare account
// resolution, resolved config inspection, and native /usr/bin/osascript
// human-presence confirmation.
//
// Limitations (fail-closed scope):
// - Refuses any .env* / .dev.vars* file holding CLOUDFLARE_API_TOKEN (or any
//   CLOUDFLARE_*, WRANGLER_*, or CF_* variable); authenticate via
//   `wrangler login` or shell env outside .env files instead. Multiline quoted
//   .env / .dev.vars values (e.g. pretty-printed JSON) fail closed cleanly as
//   unparseable rather than guessing across lines.
// - Inspects only the checked-out wrangler config `vars` block and cannot see
//   DEV_NO_AUTH if set remotely as a Worker secret or dashboard variable
//   (for example under `keep_vars: true`).
// - Human-presence confirmation via `/usr/bin/osascript` relies on macOS
//   Accessibility boundaries (any local process already granted macOS
//   Accessibility permission could script clicking the dialog button).
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
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLACEHOLDER_EMAIL_DOMAINS,
  isPlaceholderEmail,
} from "../packages/shared/src/placeholder-email.mjs";

export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_LIVE_EMAIL_VARS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_BRAND_NAME",
];
export const OSASCRIPT_PATH = "/usr/bin/osascript";

export { PLACEHOLDER_EMAIL_DOMAINS, isPlaceholderEmail };

const SECRET_VAR_PATTERN = /(SECRET|PASSWORD|PRIVATE_KEY|TOKEN|KEY)/i;
const FORBIDDEN_ENV_FILE_VAR_PATTERN = /^(CLOUDFLARE_|WRANGLER_|CF_)/i;
const ENV_FILE_NAME_PATTERN = /^(\.env(\..+)?|\.dev\.vars(\..+)?)$/;
const INHERITABLE_WRANGLER_KEYS = [
  "name",
  "main",
  "assets",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "keep_vars",
  "base_dir",
  "tsconfig",
  "site",
  "build",
  "alias",
  "route",
  "routes",
  "triggers",
  "migrations",
  "text_blobs",
  "data_blobs",
  "wasm_modules",
  "rules",
  "find_additional_modules",
  "no_bundle",
];

function fail(message) {
  console.error(`\n✗ deploy refused: ${message}`);
  process.exit(1);
}

/**
 * Parse CLI arguments strictly and refuse ambient `CLOUDFLARE_ENV`,
 * `CLOUDFLARE_API_BASE_URL`, `CF_API_BASE_URL`, `CLOUDFLARE_API_HEADERS`, or
 * `CLOUDFLARE_COMPLIANCE_REGION`. Only `--config <path>`, `--config=<path>`,
 * `-c <path>`, `--env <name>`, `--env=<name>`, `-e <name>`, or
 * `FLOW_WRANGLER_CONFIG` are accepted.
 */
export function parseDeployArgs(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const root = opts.root ?? DEFAULT_ROOT;

  if (env.CLOUDFLARE_ENV?.trim()) {
    throw new Error(
      "CLOUDFLARE_ENV is set; unset it and pass --env <name> explicitly so the target environment is unambiguous"
    );
  }
  if (env.CLOUDFLARE_API_BASE_URL?.trim()) {
    throw new Error(
      "CLOUDFLARE_API_BASE_URL is set; unset it so deploy-guarded uses Cloudflare's default API endpoint"
    );
  }
  if (env.CF_API_BASE_URL?.trim()) {
    throw new Error(
      "CF_API_BASE_URL is set; unset it so deploy-guarded uses Cloudflare's default API endpoint"
    );
  }
  if (env.CLOUDFLARE_API_HEADERS?.trim()) {
    throw new Error(
      "CLOUDFLARE_API_HEADERS is set; unset it before running deploy-guarded"
    );
  }
  if (env.CLOUDFLARE_COMPLIANCE_REGION?.trim()) {
    throw new Error(
      "CLOUDFLARE_COMPLIANCE_REGION is set; unset it so deploy-guarded uses Cloudflare's default compliance endpoint"
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

/**
 * Return a copy of `env` stripped of `CLOUDFLARE_ENV`, `CLOUDFLARE_API_BASE_URL`,
 * `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CLOUDFLARE_API_HEADERS`,
 * `CLOUDFLARE_COMPLIANCE_REGION`, `CLOUDFLARE_INCLUDE_PROCESS_ENV`, every
 * `WRANGLER_*` override, and `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_API_BASE_URL`,
 * `CF_API_KEY`, and `CF_EMAIL`.
 */
export function sanitizedWranglerEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      /^(CLOUDFLARE_ENV|CLOUDFLARE_API_BASE_URL|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|CLOUDFLARE_API_HEADERS|CLOUDFLARE_COMPLIANCE_REGION|CLOUDFLARE_INCLUDE_PROCESS_ENV|WRANGLER_.*|CF_API_TOKEN|CF_ACCOUNT_ID|CF_API_BASE_URL|CF_API_KEY|CF_EMAIL)$/i.test(
        key
      )
    ) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/** Return a copy of `env` stripped of ambient `VITE_*` variables before building the SPA. */
export function sanitizedWebBuildEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^VITE_/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Strictly scan `.env*` and `.dev.vars*` files in `dirs` (handling CRLF, lone
 * `\r`, U+2028/U+2029, and `KEY=value` or `KEY: value`), refusing any
 * unparseable non-comment line or any `CLOUDFLARE_*`, `WRANGLER_*`, or `CF_*`
 * key. Never logs or interpolates variable values.
 */
export function assertNoEnvFileOverrides(dirs, checkoutRoot) {
  const realRoot = realpathSync(checkoutRoot);
  const visitedDirs = new Set();
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    const realDir = realpathSync(dir);
    if (visitedDirs.has(realDir)) continue;
    visitedDirs.add(realDir);

    const names = readdirSync(realDir).sort();
    for (const name of names) {
      if (!ENV_FILE_NAME_PATTERN.test(name)) continue;
      const fullPath = join(realDir, name);
      let isFile = false;
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;

      const relFile = isWithinDir(realRoot, fullPath) ? relative(realRoot, fullPath) : fullPath;
      const found = [];
      const raw = readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
      const lines = raw.split(/\r\n|\r|\n|\u2028|\u2029/);
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();
        if (!line || line.startsWith("#")) continue;
        const match = /^(?:export\s+)?([A-Za-z_][\w.-]*)(?:\s*=|:\s+)/.exec(line);
        if (!match) {
          throw new Error(
            `env file ${relFile} line ${idx + 1} cannot be parsed as KEY=value or KEY: value`
          );
        }
        const varName = match[1];
        if (FORBIDDEN_ENV_FILE_VAR_PATTERN.test(varName) && !found.includes(varName)) {
          found.push(varName);
        }
      }
      if (found.length > 0) {
        throw new Error(
          `env file ${relFile} sets forbidden override variable(s): ${found.join(", ")}; remove them before running deploy-guarded`
        );
      }
    }
  }
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
 * when `envName` is null). Follows Wrangler inheritance: inheritable settings
 * (`route`, `routes`, `workers_dev`, `preview_urls`, `triggers`, `migrations`,
 * etc.) inherit independently into `env.<name>` unless overridden on the env
 * block; `vars`, `define`, and bindings are NOT inherited.
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
  // Non-inheritable bindings/vars/define come exclusively from the selected env block.
  for (const [key, val] of Object.entries(envBlock)) {
    if (!INHERITABLE_WRANGLER_KEYS.includes(key)) merged[key] = val;
  }
  return {
    environment: envName,
    envName,
    effectiveConfig: merged,
  };
}

function validateTargetBlock(
  target,
  labelPrefix,
  configDir,
  inheritedBaseDir,
  realRoot,
  requireAssetsExist,
  checkDefaultSiteEntry = false
) {
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

  if (target.define !== undefined) {
    if (!isPlainObject(target.define)) {
      throw new Error(`${labelPrefix}define must be an object`);
    }
    if (Object.keys(target.define).length > 0) {
      throw new Error(
        `${labelPrefix}define is not allowed in guarded deploys (${Object.keys(target.define).join(", ")})`
      );
    }
  }

  if (target.rules !== undefined) {
    if (!Array.isArray(target.rules)) {
      throw new Error(`${labelPrefix}rules must be an array`);
    }
    if (target.rules.length > 0) {
      throw new Error(`${labelPrefix}rules is not allowed in guarded deploys`);
    }
  }

  if (target.find_additional_modules !== undefined) {
    if (typeof target.find_additional_modules !== "boolean") {
      throw new Error(`${labelPrefix}find_additional_modules must be a boolean`);
    }
    if (target.find_additional_modules) {
      throw new Error(`${labelPrefix}find_additional_modules is not allowed in guarded deploys`);
    }
  }

  if (target.no_bundle !== undefined) {
    if (typeof target.no_bundle !== "boolean") {
      throw new Error(`${labelPrefix}no_bundle must be a boolean`);
    }
    if (target.no_bundle) {
      throw new Error(`${labelPrefix}no_bundle is not allowed in guarded deploys`);
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

  // Wrangler always resolves main, assets.directory, tsconfig, and site paths
  // relative to configDir (ignoring base_dir, which only controls moduleRoot).
  let resolvedMain = null;
  if (target.main !== undefined) {
    resolvedMain = resolveContainedPath(target.main, `${labelPrefix}main`, configDir, realRoot, {
      mustExist: true,
    });
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
        configDir,
        realRoot,
        { mustExist: requireAssetsExist }
      );
    }
  }

  let resolvedSiteEntryPoint = null;
  if (target.site !== undefined) {
    if (!isPlainObject(target.site)) {
      throw new Error(`${labelPrefix}site must be an object`);
    }
    if (target.site.bucket !== undefined) {
      resolveContainedPath(target.site.bucket, `${labelPrefix}site.bucket`, configDir, realRoot);
    }
    const rawEntry = target.site["entry-point"];
    if (rawEntry !== undefined) {
      if (typeof rawEntry !== "string" || !rawEntry.trim()) {
        throw new Error(`${labelPrefix}site["entry-point"] must be a non-empty string`);
      }
      resolvedSiteEntryPoint = resolveContainedPath(
        rawEntry,
        `${labelPrefix}site["entry-point"]`,
        configDir,
        realRoot,
        { mustExist: true }
      );
    } else if (checkDefaultSiteEntry && target.main === undefined) {
      resolvedSiteEntryPoint = resolveContainedPath(
        "workers-site",
        `${labelPrefix}site["entry-point"] (default workers-site)`,
        configDir,
        realRoot,
        { mustExist: true }
      );
    }
  }

  const resolvedTsconfigs = [];
  if (target.tsconfig !== undefined) {
    const candidate = resolveContainedPath(target.tsconfig, `${labelPrefix}tsconfig`, configDir, realRoot, {
      mustExist: true,
    });
    resolvedTsconfigs.push(candidate);
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

  for (const arrayField of ["tail_consumers", "streaming_tail_consumers", "services", "containers"]) {
    if (target[arrayField] !== undefined) {
      if (!Array.isArray(target[arrayField])) {
        throw new Error(`${labelPrefix}${arrayField} must be an array`);
      }
      if (target[arrayField].length > 0) {
        throw new Error(`${labelPrefix}${arrayField} is not allowed in guarded deploys`);
      }
    }
  }

  if (target.unsafe !== undefined) {
    if (!isPlainObject(target.unsafe)) {
      throw new Error(`${labelPrefix}unsafe must be an object`);
    }
    if (Object.keys(target.unsafe).length > 0) {
      throw new Error(
        `${labelPrefix}unsafe is not allowed in guarded deploys (${Object.keys(target.unsafe).join(", ")})`
      );
    }
  }

  if (target.durable_objects !== undefined) {
    if (!isPlainObject(target.durable_objects)) {
      throw new Error(`${labelPrefix}durable_objects must be an object`);
    }
    if (target.durable_objects.script_name !== undefined && target.durable_objects.script_name !== null) {
      throw new Error(`${labelPrefix}durable_objects.script_name is not allowed in guarded deploys`);
    }
    if (target.durable_objects.bindings !== undefined) {
      if (!Array.isArray(target.durable_objects.bindings)) {
        throw new Error(`${labelPrefix}durable_objects.bindings must be an array`);
      }
      for (let i = 0; i < target.durable_objects.bindings.length; i++) {
        const binding = target.durable_objects.bindings[i];
        if (!isPlainObject(binding)) {
          throw new Error(`${labelPrefix}durable_objects.bindings[${i}] must be an object`);
        }
        if (binding.script_name !== undefined && binding.script_name !== null && String(binding.script_name).trim() !== "") {
          throw new Error(
            `${labelPrefix}durable_objects.bindings[${i}].script_name is not allowed in guarded deploys`
          );
        }
      }
    }
  }

  if (target.migrations !== undefined) {
    if (!Array.isArray(target.migrations)) {
      throw new Error(`${labelPrefix}migrations must be an array`);
    }
    for (let i = 0; i < target.migrations.length; i++) {
      const migration = target.migrations[i];
      if (!isPlainObject(migration)) {
        throw new Error(`${labelPrefix}migrations[${i}] must be an object`);
      }
      if (migration.deleted_classes !== undefined) {
        if (!Array.isArray(migration.deleted_classes)) {
          throw new Error(`${labelPrefix}migrations[${i}].deleted_classes must be an array`);
        }
        if (migration.deleted_classes.length > 0) {
          throw new Error(
            `${labelPrefix}migrations[${i}].deleted_classes is not allowed in guarded deploys`
          );
        }
      }
    }
  }

  return {
    resolvedMain,
    resolvedAssetsDir,
    resolvedSiteEntryPoint,
    resolvedBaseDir: effectiveBaseDir,
    resolvedTsconfigs,
  };
}

/**
 * Fail closed if any tracked file has `skip-worktree` (`S`) or `assume-unchanged`
 * (lowercase tag in `git ls-files -v`), which hides local edits from `git status`
 * and `git diff`.
 */
export function assertNoHiddenGitFlags(checkoutRoot) {
  const realRoot = realpathSync(checkoutRoot);
  const out = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-v"], {
    cwd: realRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const flagged = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (/^[Sa-z] /.test(line)) {
      const tag = line[0] === "S" ? "skip-worktree" : "assume-unchanged";
      flagged.push(`${line.slice(2)} (${tag})`);
    }
  }
  if (flagged.length > 0) {
    throw new Error(
      `tracked files have skip-worktree or assume-unchanged set: ${flagged.join(", ")}`
    );
  }
}

/**
 * Fail closed if any gitignored or `.git/info/exclude` file exists under
 * `apps/api/src`, `apps/web/src`, or `packages` (ignoring only top-level
 * workspace `packages/<pkg>/node_modules/` directories). Always passes
 * `-unormal` so local `status.showUntrackedFiles=no` cannot blind the scan.
 */
export function assertNoIgnoredSourceFiles(checkoutRoot) {
  const realRoot = realpathSync(checkoutRoot);
  const targets = ["apps/api/src", "apps/web/src", "packages"].filter((p) => existsSync(join(realRoot, p)));
  if (targets.length === 0) return;

  const out = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "status", "--porcelain", "--ignored", "-unormal", "--", ...targets],
    {
      cwd: realRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const ignored = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("!! ")) continue;
    if (/^!! packages\/[^/]+\/node_modules\/$/.test(line)) continue;
    ignored.push(line.slice(3));
  }
  if (ignored.length > 0) {
    throw new Error(`gitignored or excluded files exist in source trees: ${ignored.join(", ")}`);
  }
}

/**
 * Verify that `main`, `tsconfig`, `site["entry-point"]`, `assets.directory` (or
 * `apps/web` for built SPA outputs) are tracked by git in `realRoot`, no
 * tracked file hides edits via index flags, and no gitignored/excluded files
 * exist under `apps/api/src`, `apps/web/src`, or `packages`.
 */
export function assertTrackedDeployPaths(
  { resolvedMain, resolvedAssetsDir, resolvedSiteEntryPoint = null, resolvedTsconfigs = [], configDir, resolvedBaseDir },
  checkoutRoot
) {
  const realRoot = realpathSync(checkoutRoot);
  assertNoHiddenGitFlags(realRoot);
  assertNoIgnoredSourceFiles(realRoot);

  const assertGitTrackedFile = (absPath, label) => {
    const relPath = relative(realRoot, absPath);
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: realRoot,
      encoding: "utf8",
    });
    if (tracked.status !== 0) {
      throw new Error(`${label} is not tracked by git: ${relPath}`);
    }
  };

  const assertGitTrackedDir = (absDir, label) => {
    const relDir = relative(realRoot, absDir) || ".";
    const trackedFiles = execFileSync("git", ["ls-files", "--", relDir], {
      cwd: realRoot,
      encoding: "utf8",
    }).trim();
    if (!trackedFiles) {
      throw new Error(`${label} is not tracked by git: ${relDir}`);
    }
    const untrackedOrIgnored = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "status", "--porcelain", "--ignored", "-unormal", "--", relDir],
      { cwd: realRoot, encoding: "utf8" }
    ).trim();
    if (untrackedOrIgnored !== "") {
      throw new Error(`${label} contains untracked or gitignored files: ${relDir}`);
    }
  };

  if (resolvedMain) {
    assertGitTrackedFile(resolvedMain, "main");
  }

  if (resolvedSiteEntryPoint) {
    if (statSync(resolvedSiteEntryPoint).isDirectory()) {
      assertGitTrackedDir(resolvedSiteEntryPoint, 'site["entry-point"]');
    } else {
      assertGitTrackedFile(resolvedSiteEntryPoint, 'site["entry-point"]');
    }
  }

  const tsconfigSet = new Set(resolvedTsconfigs);
  for (const dir of [configDir, resolvedBaseDir]) {
    if (!dir) continue;
    const implicitTsconfig = join(dir, "tsconfig.json");
    if (existsSync(implicitTsconfig)) {
      const realTsconfig = realpathSync(implicitTsconfig);
      if (!isWithinDir(realRoot, realTsconfig)) {
        throw new Error(`tsconfig.json resolves outside checkout: ${realTsconfig}`);
      }
      tsconfigSet.add(realTsconfig);
    }
  }
  for (const tsconfigPath of tsconfigSet) {
    assertGitTrackedFile(tsconfigPath, "tsconfig");
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
      const webDirty = execFileSync(
        "git",
        ["-c", "core.quotePath=false", "status", "--porcelain", "--ignored", "-unormal", "--", "apps/web"],
        { cwd: realRoot, encoding: "utf8" }
      )
        .split(/\r?\n/)
        .filter((line) => line && !/^!! apps\/web\/(node_modules|dist|dist-demo)\/$/.test(line));
      if (webDirty.length > 0) {
        throw new Error(`apps/web has uncommitted, untracked, or gitignored changes: ${webDirty.join(", ")}`);
      }
    } else {
      assertGitTrackedDir(resolvedAssetsDir, "assets.directory");
    }
  }
}

/**
 * Verify `configPath`, its effective target, and all `env.<name>` blocks keep
 * every path (`main`, `assets.directory`, `base_dir`, `site.bucket`,
 * `site["entry-point"]`, `tsconfig`, `text_blobs`, `build`, `alias`) inside
 * `checkoutRoot`, and verify git-tracked `main`, `site`, `tsconfig`, and
 * `assets` targets unless `checkGitTracked: false`.
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
  assertNoEnvFileOverrides([configDir, join(realRoot, "apps", "api"), realRoot], realRoot);

  const topPaths = validateTargetBlock(
    config,
    "",
    configDir,
    configDir,
    realRoot,
    envName ? false : requireAssetsExist,
    envName ? false : true
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
        blockName === envName ? requireAssetsExist : false,
        false
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
    requireAssetsExist,
    true
  );

  if (checkGitTracked) {
    assertTrackedDeployPaths(
      { ...effectivePaths, configDir },
      realRoot
    );
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
    resolvedSiteEntryPoint: effectivePaths.resolvedSiteEntryPoint,
  };
}

/**
 * Fail closed if `DEV_NO_AUTH` is enabled on a Worker or Workers Sites target
 * in a guarded production deploy.
 */
export function assertDeployConfigAuthVars(effectiveConfig) {
  if (!effectiveConfig?.main && !effectiveConfig?.site) return;
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  const raw = vars.DEV_NO_AUTH;
  if (raw === true || String(raw ?? "").trim().toLowerCase() === "true") {
    throw new Error('DEV_NO_AUTH cannot be "true" for a guarded production deploy');
  }
}

/** Extract all effective route patterns from both singular `route` and array `routes`. */
export function extractEffectiveRoutes(effectiveConfig) {
  const patterns = [];
  const addRoute = (r) => {
    const pattern = typeof r === "string" ? r : isPlainObject(r) && typeof r.pattern === "string" ? r.pattern : null;
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  };
  if (effectiveConfig?.route !== undefined) addRoute(effectiveConfig.route);
  if (Array.isArray(effectiveConfig?.routes)) {
    for (const r of effectiveConfig.routes) addRoute(r);
  }
  return patterns;
}

/** Format effective route entries for display, marking `custom_domain: true` routes. */
export function formatEffectiveRoutes(effectiveConfig) {
  const entries = [];
  const seen = new Set();
  const addRoute = (r) => {
    const pattern = typeof r === "string" ? r : isPlainObject(r) && typeof r.pattern === "string" ? r.pattern : null;
    if (!pattern || seen.has(pattern)) return;
    seen.add(pattern);
    entries.push(isPlainObject(r) && r.custom_domain ? `${pattern} (custom_domain)` : pattern);
  };
  if (effectiveConfig?.route !== undefined) addRoute(effectiveConfig.route);
  if (Array.isArray(effectiveConfig?.routes)) {
    for (const r of effectiveConfig.routes) addRoute(r);
  }
  return entries;
}

/**
 * Resolve effective `workers_dev` setting: matches Wrangler's default of
 * publishing on `*.workers.dev` when unset and no `route`/`routes` exist.
 */
export function resolveEffectiveWorkersDev(effectiveConfig) {
  if (typeof effectiveConfig?.workers_dev === "boolean") {
    return { value: effectiveConfig.workers_dev, defaulted: false };
  }
  return { value: extractEffectiveRoutes(effectiveConfig).length === 0, defaulted: true };
}

/**
 * Resolve effective `preview_urls` setting: matches live `subdomainDeploy`
 * (`previews_enabled: undefined` when unset, preserving remote state).
 */
export function resolveEffectivePreviewUrls(effectiveConfig) {
  if (typeof effectiveConfig?.preview_urls === "boolean") {
    return { value: effectiveConfig.preview_urls, defaulted: false };
  }
  return { value: null, defaulted: true };
}

/** Extract effective cron expressions from `triggers.crons`. */
export function extractEffectiveCrons(effectiveConfig) {
  return Array.isArray(effectiveConfig?.triggers?.crons) ? effectiveConfig.triggers.crons : [];
}

function formatBoolSetting(resolved) {
  if (resolved.value === null) return "unchanged (unset)";
  return resolved.defaulted ? `${resolved.value} (default)` : String(resolved.value);
}

/** Summarize DO migrations (tag plus added/renamed/transferred classes) for inspection. */
export function summarizeMigrations(effectiveConfig) {
  if (!Array.isArray(effectiveConfig?.migrations) || effectiveConfig.migrations.length === 0) {
    return "(none)";
  }
  return effectiveConfig.migrations
    .map((m) => {
      const parts = [];
      if (Array.isArray(m.new_sqlite_classes) && m.new_sqlite_classes.length) {
        parts.push(`new_sqlite:${m.new_sqlite_classes.join("+")}`);
      }
      if (Array.isArray(m.new_classes) && m.new_classes.length) {
        parts.push(`new:${m.new_classes.join("+")}`);
      }
      if (Array.isArray(m.renamed_classes) && m.renamed_classes.length) {
        parts.push(`rename:${m.renamed_classes.map((r) => `${r.from}->${r.to}`).join("+")}`);
      }
      if (Array.isArray(m.transferred_classes) && m.transferred_classes.length) {
        parts.push(`transfer:${m.transferred_classes.map((t) => `${t.from}:${t.from_script}->${t.to}`).join("+")}`);
      }
      const tag = m.tag ?? "(untagged)";
      return parts.length > 0 ? `${tag}(${parts.join(",")})` : tag;
    })
    .join(", ");
}

/**
 * Fail closed at deploy time ONLY when live email sending is enabled
 * (`EMAIL_DRY_RUN === "false"`). Applied even when `keep_vars` is true, and
 * skipped only for assets-only or sandbox configs. `EMAIL_REQUESTER_FROM_NAME`
 * remains optional; Access vars do NOT mark email as live.
 */
export function assertDeployConfigEmailVars(effectiveConfig) {
  if (!effectiveConfig?.main && !effectiveConfig?.site) return;
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  if (vars.SANDBOX === "true") return;
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
      "account_id in config conflicts with CLOUDFLARE_ACCOUNT_ID; unset CLOUDFLARE_ACCOUNT_ID or align them"
    );
  }
  const lookupId = cfgId || envId || null;
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];

  if (lookupId) {
    const matched = accounts.find((a) => a && a.id === lookupId);
    if (matched) {
      return { id: matched.id, name: matched.name ?? null, label: `${matched.name} (${matched.id})` };
    }
    if (cfgId) {
      return { id: cfgId, name: null, label: `${cfgId} (configured)` };
    }
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID does not match any account from wrangler whoami; run `wrangler login` or set account_id in config"
    );
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

function queryWranglerWhoami(apiDir, wranglerEnv, spawnFn = spawnSync) {
  const res = spawnFn("pnpm", ["exec", "wrangler", "whoami", "--json"], {
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

/** Deterministically hash all files in `dirPath` (refusing symlinks). */
export function hashDirectory(dirPath) {
  if (lstatSync(dirPath).isSymbolicLink()) {
    throw new Error(`symlink not allowed in assets directory: ${dirPath}`);
  }
  const hasher = createHash("sha256");
  const walk = (cur, prefix) => {
    const entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const full = join(cur, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || lstatSync(full).isSymbolicLink()) {
        throw new Error(`symlink not allowed in assets directory: ${rel}`);
      }
      if (entry.isDirectory()) {
        hasher.update(`D\0${rel}\0`);
        walk(full, rel);
      } else {
        hasher.update(`F\0${rel}\0`);
        hasher.update(readFileSync(full));
        hasher.update("\0");
      }
    }
  };
  walk(dirPath, "");
  return hasher.digest("hex");
}

/** Format full resolved deploy summary (environment, account, routes/defaults, crons, migrations, bindings, vars). */
export function formatResolvedConfig({
  effectiveConfig,
  environment,
  account,
  configPath,
  configSha256,
  gitignored,
  resolvedMain,
  resolvedAssetsDir,
  resolvedSiteEntryPoint = null,
  checkoutRoot,
  head,
  commitSubject,
}) {
  const realRoot = realpathSync(checkoutRoot);
  const relConfig = relative(realRoot, configPath) || configPath;
  const relMain = resolvedMain
    ? relative(realRoot, resolvedMain)
    : resolvedSiteEntryPoint
      ? `${relative(realRoot, resolvedSiteEntryPoint)} (site entry-point)`
      : "(none — assets only)";
  const relAssets = resolvedAssetsDir ? relative(realRoot, resolvedAssetsDir) : "(none)";
  const hosts = formatEffectiveRoutes(effectiveConfig);
  const workersDev = resolveEffectiveWorkersDev(effectiveConfig);
  const previewUrls = resolveEffectivePreviewUrls(effectiveConfig);
  const crons = extractEffectiveCrons(effectiveConfig);
  const migrations = summarizeMigrations(effectiveConfig);
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
    `Routes:      ${hosts.join(", ") || "(none)"} (workers_dev: ${formatBoolSetting(workersDev)}, preview_urls: ${formatBoolSetting(previewUrls)})`,
    `Crons:       ${crons.join(", ") || "(none)"}`,
    `Migrations:  ${migrations}`,
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
  resolvedSiteEntryPoint = null,
  checkoutRoot,
  head,
  commitSubject,
}) {
  const realRoot = realpathSync(checkoutRoot);
  const relMain = resolvedMain
    ? relative(realRoot, resolvedMain)
    : resolvedSiteEntryPoint
      ? `${relative(realRoot, resolvedSiteEntryPoint)} (site entry-point)`
      : "(none — assets only)";
  const hosts = formatEffectiveRoutes(effectiveConfig);
  const workersDev = resolveEffectiveWorkersDev(effectiveConfig);
  const previewUrls = resolveEffectivePreviewUrls(effectiveConfig);
  const crons = extractEffectiveCrons(effectiveConfig);
  const migrations = summarizeMigrations(effectiveConfig);
  const vars = isPlainObject(effectiveConfig.vars) ? effectiveConfig.vars : {};
  const fmtVar = (val) => (val === undefined ? "(unset)" : JSON.stringify(val));
  const authVars = [
    `OWNER_EMAIL=${fmtVar(vars.OWNER_EMAIL)}`,
    `DEV_NO_AUTH=${fmtVar(vars.DEV_NO_AUTH)}`,
    `ACCESS_TEAM_DOMAIN=${fmtVar(vars.ACCESS_TEAM_DOMAIN)}`,
    `ACCESS_AUD=${fmtVar(vars.ACCESS_AUD)}`,
  ];
  if (vars.MCP_ACCESS_OAUTH_ENABLED !== undefined || vars.MCP_ACCESS_AUD !== undefined) {
    authVars.push(
      `MCP_ACCESS_OAUTH_ENABLED=${fmtVar(vars.MCP_ACCESS_OAUTH_ENABLED)}`,
      `MCP_ACCESS_AUD=${fmtVar(vars.MCP_ACCESS_AUD)}`
    );
  }
  const keyVars = [
    `APP_HOSTNAME=${fmtVar(vars.APP_HOSTNAME)}`,
    `EMAIL_FROM=${fmtVar(vars.EMAIL_FROM)}`,
    `EMAIL_DRY_RUN=${fmtVar(vars.EMAIL_DRY_RUN)}`,
  ].join(", ");
  return [
    `Worker: ${effectiveConfig.name ?? "(unnamed)"}`,
    `Environment: ${environment ?? "(top-level)"}`,
    `Account: ${account?.label ?? "(unknown)"}`,
    `Config: ${relative(realRoot, configPath)} (${gitignored ? "gitignored" : "tracked"}, sha256 ${configSha256.slice(0, 12)})`,
    `Main: ${relMain}`,
    `Assets: ${resolvedAssetsDir ? relative(realRoot, resolvedAssetsDir) : "(none)"}`,
    `Routes: ${hosts.join(", ") || "(none)"} (workers_dev: ${formatBoolSetting(workersDev)}, preview_urls: ${formatBoolSetting(previewUrls)})`,
    `Crons: ${crons.join(", ") || "(none)"}`,
    `Migrations: ${migrations}`,
    `Bindings: ${summarizeBindings(effectiveConfig)}`,
    `Auth: ${authVars.join(", ")}`,
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

/**
 * End-to-end guarded production deploy workflow. Accepts injectable runtime
 * hooks so automated tests can drive every gate cleanly without calling
 * live Cloudflare APIs.
 */
export async function runDeploy(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const realRoot = realpathSync(root);
  const apiDir = join(realRoot, "apps", "api");
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const execFn = opts.execFileSync ?? execFileSync;
  const spawnFn = opts.spawnSync ?? spawnSync;
  const fetchFn = opts.fetch ?? fetch;
  const approveFn = opts.humanApproval ?? ((summary) => humanApproval(summary, { platform, spawn: spawnFn }));
  const log = opts.log ?? console.log;
  const errLog = opts.errorLog ?? console.error;

  const { configPath, envName } = parseDeployArgs(argv, { cwd, env, root: realRoot });
  const initial = validateDeployConfig(configPath, realRoot, { envName });
  assertDeployConfigAuthVars(initial.effectiveConfig);
  assertDeployConfigEmailVars(initial.effectiveConfig);

  if (platform !== "darwin") {
    throw new Error(
      "guarded production deploy requires macOS (/usr/bin/osascript) human-presence approval; off macOS, build and deploy with wrangler directly"
    );
  }

  const wranglerEnv = sanitizedWranglerEnv(env);
  const webBuildEnv = sanitizedWebBuildEnv(env);
  const git = (...args) => execFn("git", args, { cwd: realRoot, encoding: "utf8" }).trim();
  const run = (label, cmd, args, runCwd = realRoot, runEnv = env) => {
    log(`\n→ ${label}`);
    const result = spawnFn(cmd, args, { cwd: runCwd, env: runEnv, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${label} failed`);
  };
  const assertCheckout = (expectedHead) => {
    const branch = git("branch", "--show-current");
    if (branch !== "main") throw new Error(`on branch "${branch}"; deploy from main`);
    if (git("-c", "core.quotePath=false", "status", "--porcelain", "-unormal") !== "") {
      throw new Error("working tree has uncommitted or untracked changes");
    }
    assertNoHiddenGitFlags(realRoot);
    assertNoIgnoredSourceFiles(realRoot);
    const current = git("rev-parse", "HEAD");
    if (current !== git("rev-parse", "origin/main")) {
      throw new Error("HEAD is not origin/main; push or pull first");
    }
    if (expectedHead && current !== expectedHead) {
      throw new Error("HEAD moved while checks were running");
    }
    return current;
  };
  const assertConfigUnchanged = (expectedSha256) => {
    const verified = validateDeployConfig(initial.configPath, realRoot, {
      envName,
      requireAssetsExist: true,
    });
    if (verified.configSha256 !== expectedSha256) {
      throw new Error("wrangler config changed while deploy checks were running");
    }
    assertDeployConfigAuthVars(verified.effectiveConfig);
    assertDeployConfigEmailVars(verified.effectiveConfig);
    return verified;
  };

  log("→ fetching origin/main");
  git("fetch", "--quiet", "origin", "main");
  const head = assertCheckout(null);

  run("install (frozen lockfile)", "pnpm", ["install", "--frozen-lockfile"]);
  run("typecheck", "pnpm", ["typecheck"]);
  run("tests", "pnpm", ["test"]);

  const buildScript = selectWebBuildScript(initial.resolvedAssetsDir, realRoot);
  if (buildScript && initial.resolvedAssetsDir) {
    rmSync(initial.resolvedAssetsDir, { recursive: true, force: true });
    run(`web ${buildScript}`, "pnpm", ["--filter", "@flow/web", buildScript], realRoot, webBuildEnv);
  }

  const afterBuild = assertConfigUnchanged(initial.configSha256);
  const expectedAssetsHash = afterBuild.resolvedAssetsDir ? hashDirectory(afterBuild.resolvedAssetsDir) : null;

  const whoami = queryWranglerWhoami(apiDir, wranglerEnv, spawnFn);
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
  const gitignored = spawnFn("git", ["check-ignore", "-q", relConfig], { cwd: realRoot }).status === 0;
  const info = {
    ...afterBuild,
    account,
    gitignored,
    checkoutRoot: realRoot,
    head,
    commitSubject: git("log", "-1", "--format=%s"),
  };

  log(`\n${formatResolvedConfig(info)}\n\n→ waiting for approval (macOS dialog via ${OSASCRIPT_PATH})`);
  if (!(await approveFn(formatDialogSummary(info)))) throw new Error("not approved");

  assertCheckout(head);
  const preDeploy = assertConfigUnchanged(initial.configSha256);
  if (expectedAssetsHash !== null) {
    if (!preDeploy.resolvedAssetsDir || hashDirectory(preDeploy.resolvedAssetsDir) !== expectedAssetsHash) {
      throw new Error("built assets changed while waiting for deploy approval");
    }
  }
  run(
    "wrangler deploy",
    "pnpm",
    ["exec", "wrangler", "deploy", "--config", afterBuild.configPath, ...envFlags],
    apiDir,
    wranglerEnv
  );

  const hosts = extractEffectiveRoutes(afterBuild.effectiveConfig);
  for (const host of hosts) {
    try {
      const res = await fetchFn(`https://${host.replace(/\/\*$/, "")}/api/health`);
      log(`\n✓ ${host}/api/health → ${res.status} ${await res.text()}`);
    } catch (err) {
      errLog(`\n! ${host}/api/health unreachable: ${err instanceof Error ? err.message : err}`);
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
  runDeploy().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
