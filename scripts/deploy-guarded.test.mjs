import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ROOT,
  OSASCRIPT_PATH,
  assertDeployConfigAuthVars,
  assertDeployConfigEmailVars,
  assertNoEnvFileOverrides,
  assertNoHiddenGitFlags,
  extractEffectiveRoutes,
  formatDialogSummary,
  formatResolvedConfig,
  humanApproval,
  parseConfigArg,
  parseDeployArgs,
  parseJsonc,
  resolveCloudflareAccount,
  resolveEffectiveConfig,
  sanitizedWranglerEnv,
  selectWebBuildScript,
  validateDeployConfig,
} from "./deploy-guarded.mjs";

const VALID_AUD = "a".repeat(64);
const VALID_EMAIL_VARS = {
  EMAIL_DRY_RUN: "false",
  EMAIL_FROM: "flow@mail.acme-ops.com",
  EMAIL_FROM_NAME: "Acme",
  EMAIL_BRAND_NAME: "Acme",
};

function gitCommit(cwd, msg = "init") {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@acme.test"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd });
}

function makeFixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "flow-guard-test-"));
  const checkout = join(base, "flow-checkout");
  const outside = join(base, "flow-private");

  mkdirSync(join(checkout, "apps", "api", "src"), { recursive: true });
  mkdirSync(join(checkout, "apps", "web", "dist"), { recursive: true });
  mkdirSync(join(checkout, "apps", "web", "dist-demo"), { recursive: true });
  mkdirSync(join(checkout, "apps", "static-assets"), { recursive: true });
  mkdirSync(join(checkout, "demo"), { recursive: true });
  mkdirSync(join(checkout, "sandbox"), { recursive: true });
  mkdirSync(join(outside, "apps", "api", "src"), { recursive: true });
  mkdirSync(join(outside, "apps", "web", "dist"), { recursive: true });

  writeFileSync(join(checkout, ".gitignore"), "apps/web/dist/\napps/web/dist-demo/\napps/api/wrangler.jsonc\n");
  writeFileSync(join(checkout, "apps", "api", "src", "index.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "src", "staging.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "src", "sandbox.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "tsconfig.json"), "{}\n");
  writeFileSync(join(checkout, "apps", "api", "blob.txt"), "hello\n");
  writeFileSync(join(checkout, "apps", "web", "package.json"), '{"name":"@flow/web"}\n');
  writeFileSync(join(checkout, "apps", "static-assets", "index.html"), "<html/>\n");
  writeFileSync(join(outside, "apps", "api", "src", "index.ts"), "export default {};\n");
  writeFileSync(join(outside, "tsconfig.json"), "{}\n");
  writeFileSync(join(outside, "secret.txt"), "x\n");

  gitCommit(checkout);

  const validConfig = join(checkout, "apps", "api", "wrangler.jsonc");
  writeFileSync(
    validConfig,
    JSON.stringify({
      name: "flow",
      main: "src/index.ts",
      assets: { directory: "../web/dist" },
      vars: VALID_EMAIL_VARS,
    })
  );

  const outsideConfig = join(outside, "apps", "api", "wrangler.jsonc");
  writeFileSync(
    outsideConfig,
    JSON.stringify({
      name: "flow-private",
      main: "src/index.ts",
      assets: { directory: "../web/dist" },
    })
  );

  return {
    base,
    checkout,
    outside,
    validConfig,
    outsideConfig,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe("parseJsonc", () => {
  it("preserves string literals containing //, /*, and trailing-comma patterns", () => {
    const parsed = parseJsonc(`{
      // top comment
      "url": "https://flow.example.com/*keep*/", /* inline comment */
      "tricky": "a, } b, ] \\", } \\" end",
      "arr": [1, 2, ],
    }`);
    assert.deepEqual(parsed, {
      url: "https://flow.example.com/*keep*/",
      tricky: 'a, } b, ] ", } " end',
      arr: [1, 2],
    });
  });
});

describe("parseDeployArgs and CLOUDFLARE_ENV", () => {
  it("parses --config, --env, and refuses CLOUDFLARE_ENV or unexpected flags", () => {
    assert.deepEqual(
      parseDeployArgs(["--", "--config", "wrangler.jsonc", "--env=staging"], {
        cwd: "/repo",
        env: {},
        root: "/repo",
      }),
      { configPath: "/repo/wrangler.jsonc", envName: "staging" }
    );
    assert.equal(
      parseConfigArg([], { cwd: "/repo", env: { FLOW_WRANGLER_CONFIG: "wrangler.jsonc" }, root: "/repo" }),
      "/repo/wrangler.jsonc"
    );
    assert.throws(
      () => parseDeployArgs([], { cwd: "/repo", env: { CLOUDFLARE_ENV: "staging" }, root: "/repo" }),
      /CLOUDFLARE_ENV is set/
    );
    assert.throws(
      () => parseDeployArgs(["--main", "foo.ts"], { cwd: "/repo", env: {}, root: "/repo" }),
      /unexpected argument/
    );

    const cleaned = sanitizedWranglerEnv({
      PATH: "/usr/bin",
      CLOUDFLARE_ENV: "prod",
      WRANGLER_CI_OVERRIDE_NAME: "hijack",
      WRANGLER_CONFIG_FILENAME: "other.jsonc",
      wrangler_api_environment: "staging",
    });
    assert.equal("CLOUDFLARE_ENV" in cleaned, false);
    assert.equal("WRANGLER_CI_OVERRIDE_NAME" in cleaned, false);
    assert.equal("WRANGLER_CONFIG_FILENAME" in cleaned, false);
    assert.equal("wrangler_api_environment" in cleaned, false);
    assert.equal(cleaned.PATH, "/usr/bin");
  });

  it("refuses .env or .dev.vars files in wrangler working dir that set CLOUDFLARE_* or WRANGLER_* vars", () => {
    const fx = makeFixtureRepo();
    try {
      const apiDir = join(fx.checkout, "apps", "api");
      // Local dev auth toggle in .dev.vars is fine; CLOUDFLARE_*/WRANGLER_* is not.
      writeFileSync(join(apiDir, ".dev.vars"), 'DEV_NO_AUTH="true"\n');
      assert.doesNotThrow(() => validateDeployConfig(fx.validConfig, fx.checkout));

      writeFileSync(join(apiDir, ".env"), "CLOUDFLARE_ENV=staging\nWRANGLER_CI_OVERRIDE_NAME=evil\n");
      assert.throws(
        () => validateDeployConfig(fx.validConfig, fx.checkout),
        /env file apps\/api\/\.env sets forbidden override variable\(s\): CLOUDFLARE_ENV, WRANGLER_CI_OVERRIDE_NAME/
      );
      rmSync(join(apiDir, ".env"));

      writeFileSync(join(apiDir, ".dev.vars.local"), "CLOUDFLARE_ACCOUNT_ID=acc_other\n");
      assert.throws(
        () => assertNoEnvFileOverrides([apiDir], fx.checkout),
        /env file apps\/api\/\.dev\.vars\.local sets forbidden override variable\(s\): CLOUDFLARE_ACCOUNT_ID/
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe("validateDeployConfig boundaries, env selection, and git tracking", () => {
  it("accepts tracked in-checkout full, demo, and sandbox configs", () => {
    const fx = makeFixtureRepo();
    try {
      const full = validateDeployConfig(fx.validConfig, fx.checkout, { requireAssetsExist: true });
      assert.equal(full.effectiveConfig.name, "flow");
      assert.equal(selectWebBuildScript(full.resolvedAssetsDir, fx.checkout), "build");

      const demoConfig = join(fx.checkout, "demo", "wrangler.jsonc");
      writeFileSync(
        demoConfig,
        JSON.stringify({ name: "flow-demo", assets: { directory: "../apps/web/dist-demo" } })
      );
      const demo = validateDeployConfig(demoConfig, fx.checkout);
      assert.equal(demo.resolvedMain, null);
      assert.equal(selectWebBuildScript(demo.resolvedAssetsDir, fx.checkout), "build:demo");

      const sandboxConfig = join(fx.checkout, "sandbox", "wrangler.jsonc");
      writeFileSync(
        sandboxConfig,
        JSON.stringify({ name: "flow-sandbox", main: "../apps/api/src/sandbox.ts" })
      );
      const sandbox = validateDeployConfig(sandboxConfig, fx.checkout);
      assert.equal(sandbox.resolvedAssetsDir, null);
      assert.equal(selectWebBuildScript(sandbox.resolvedAssetsDir, fx.checkout), null);
    } finally {
      fx.cleanup();
    }
  });

  it("refuses outside configs, symlinks, main, assets.directory, alias, define, rules, find_additional_modules, no_bundle, build.command, site.bucket, base_dir, tsconfig, and text_blobs", () => {
    const fx = makeFixtureRepo();
    try {
      assert.throws(() => validateDeployConfig(fx.outsideConfig, fx.checkout), /must be inside this checkout/);

      const linkCfg = join(fx.checkout, "apps", "api", "link.jsonc");
      symlinkSync(fx.outsideConfig, linkCfg);
      assert.throws(() => validateDeployConfig(linkCfg, fx.checkout), /must be inside this checkout/);

      const badCases = [
        ["main escape", { main: "../../../flow-private/apps/api/src/index.ts" }, /main escapes checkout/],
        ["assets escape", { main: "src/index.ts", assets: { directory: "../../../flow-private/apps/web/dist" } }, /assets\.directory escapes/],
        ["alias", { main: "src/index.ts", alias: { foo: "../../../flow-private/x.ts" } }, /alias is not allowed/],
        ["define", { main: "src/index.ts", define: { API_BASE: '"https://evil.test"' } }, /define is not allowed/],
        ["rules", { main: "src/index.ts", rules: [{ type: "Text", globs: ["../../../**/*.txt"] }] }, /rules is not allowed/],
        ["find_additional_modules", { main: "src/index.ts", find_additional_modules: true }, /find_additional_modules is not allowed/],
        ["no_bundle", { main: "src/index.ts", no_bundle: true }, /no_bundle is not allowed/],
        ["build.command", { main: "src/index.ts", build: { command: "echo pwn" } }, /build\.command is not allowed/],
        ["build.cwd", { main: "src/index.ts", build: { cwd: "../../.." } }, /build\.cwd escapes/],
        ["site.bucket", { main: "src/index.ts", site: { bucket: "../../../flow-private" } }, /site\.bucket escapes/],
        ["base_dir", { main: "src/index.ts", base_dir: "../../../flow-private/apps/api" }, /base_dir escapes/],
        ["tsconfig", { main: "src/index.ts", tsconfig: "../../../flow-private/tsconfig.json" }, /tsconfig escapes/],
        ["text_blobs", { main: "src/index.ts", text_blobs: { KEY: "../../../flow-private/secret.txt" } }, /text_blobs\.KEY escapes/],
        ["env override", { main: "src/index.ts", env: { stg: { tsconfig: "../../../flow-private/tsconfig.json" } } }, /env\.stg\.tsconfig escapes/],
        ["env define", { main: "src/index.ts", env: { stg: { define: { X: "1" } } } }, /env\.stg\.define is not allowed/],
        ["env find_additional_modules", { main: "src/index.ts", env: { stg: { find_additional_modules: true } } }, /env\.stg\.find_additional_modules is not allowed/],
      ];

      for (const [label, body, expected] of badCases) {
        const p = join(fx.checkout, "apps", "api", `bad-${label.replace(/[^a-z]/g, "")}.jsonc`);
        writeFileSync(p, JSON.stringify({ name: "flow", ...body }));
        assert.throws(() => validateDeployConfig(p, fx.checkout), expected, `expected failure for ${label}`);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("refuses untracked main, untracked custom assets.directory, and skip-worktree or assume-unchanged tracked files", () => {
    const fx = makeFixtureRepo();
    try {
      const untrackedMain = join(fx.checkout, "apps", "api", "src", "untracked.ts");
      writeFileSync(untrackedMain, "export default {};\n");
      const cfg1 = join(fx.checkout, "apps", "api", "untracked-main.jsonc");
      writeFileSync(cfg1, JSON.stringify({ name: "flow", main: "src/untracked.ts" }));
      assert.throws(() => validateDeployConfig(cfg1, fx.checkout), /main is not tracked by git/);

      const untrackedAssets = join(fx.checkout, "apps", "untracked-assets");
      mkdirSync(untrackedAssets, { recursive: true });
      writeFileSync(join(untrackedAssets, "index.html"), "<html/>\n");
      const cfg2 = join(fx.checkout, "apps", "api", "untracked-assets.jsonc");
      writeFileSync(
        cfg2,
        JSON.stringify({ name: "flow", main: "src/index.ts", assets: { directory: "../untracked-assets" } })
      );
      assert.throws(() => validateDeployConfig(cfg2, fx.checkout), /assets\.directory is not tracked by git/);

      // Tracked static directory passes cleanly.
      const cfg3 = join(fx.checkout, "apps", "api", "tracked-assets.jsonc");
      writeFileSync(
        cfg3,
        JSON.stringify({ name: "flow", main: "src/index.ts", assets: { directory: "../static-assets" } })
      );
      assert.doesNotThrow(() => validateDeployConfig(cfg3, fx.checkout));

      // --skip-worktree or --assume-unchanged on any tracked file hides edits and must fail.
      execFileSync("git", ["update-index", "--skip-worktree", "apps/api/src/index.ts"], { cwd: fx.checkout });
      assert.throws(
        () => validateDeployConfig(fx.validConfig, fx.checkout),
        /skip-worktree or assume-unchanged set: apps\/api\/src\/index\.ts \(skip-worktree\)/
      );
      execFileSync("git", ["update-index", "--no-skip-worktree", "apps/api/src/index.ts"], { cwd: fx.checkout });

      execFileSync("git", ["update-index", "--assume-unchanged", "apps/api/src/staging.ts"], { cwd: fx.checkout });
      assert.throws(
        () => assertNoHiddenGitFlags(fx.checkout),
        /skip-worktree or assume-unchanged set: apps\/api\/src\/staging\.ts \(assume-unchanged\)/
      );
      execFileSync("git", ["update-index", "--no-assume-unchanged", "apps/api/src/staging.ts"], { cwd: fx.checkout });
      assert.doesNotThrow(() => validateDeployConfig(fx.validConfig, fx.checkout));
    } finally {
      fx.cleanup();
    }
  });

  it("resolves and checks the effective --env configuration, including singular route and inherited routes", () => {
    const fx = makeFixtureRepo();
    try {
      const cfg = join(fx.checkout, "apps", "api", "multi-env.jsonc");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../web/dist" },
          routes: [{ pattern: "top.acme-ops.com", custom_domain: true }],
          vars: { EMAIL_DRY_RUN: "true" },
          env: {
            inherited: {
              main: "src/staging.ts",
              vars: { EMAIL_DRY_RUN: "false", EMAIL_FROM: "flow@yourdomain.com" },
            },
            singular: {
              route: "one.acme-ops.com/*",
              vars: { EMAIL_DRY_RUN: "false", ...VALID_EMAIL_VARS },
            },
            cleared: {
              routes: [],
              vars: { EMAIL_DRY_RUN: "true" },
            },
          },
        })
      );

      const top = validateDeployConfig(cfg, fx.checkout);
      assert.equal(top.environment, "(top-level)");
      assert.deepEqual(extractEffectiveRoutes(top.effectiveConfig), ["top.acme-ops.com"]);
      assert.doesNotThrow(() => assertDeployConfigEmailVars(top.effectiveConfig));

      const inh = validateDeployConfig(cfg, fx.checkout, { envName: "inherited" });
      assert.equal(inh.environment, "inherited");
      assert.equal(inh.effectiveConfig.name, "flow-inherited");
      assert.match(inh.resolvedMain ?? "", /apps\/api\/src\/staging\.ts$/);
      assert.deepEqual(extractEffectiveRoutes(inh.effectiveConfig), ["top.acme-ops.com"]);
      assert.throws(() => assertDeployConfigEmailVars(inh.effectiveConfig), /placeholder/);

      const single = validateDeployConfig(cfg, fx.checkout, { envName: "singular" });
      assert.deepEqual(extractEffectiveRoutes(single.effectiveConfig), ["one.acme-ops.com/*"]);
      assert.doesNotThrow(() => assertDeployConfigEmailVars(single.effectiveConfig));

      const cleared = validateDeployConfig(cfg, fx.checkout, { envName: "cleared" });
      assert.deepEqual(extractEffectiveRoutes(cleared.effectiveConfig), []);

      assert.throws(() => resolveEffectiveConfig(inh.config, "missing"), /not defined/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("assertDeployConfigEmailVars and assertDeployConfigAuthVars", () => {
  it("enforces widened email checks when EMAIL_DRY_RUN is false (even with keep_vars: true), and refuses DEV_NO_AUTH", () => {
    for (const placeholder of [
      "flow@mail.example.com",
      "ops@yourdomain.com",
      "flow@sub.your-domain.com",
      "flow@localhost",
      "flow@mail.local",
      "flow@acme.test",
      "owner@placeholder.flow",
      "flow@mail",
      "flow@<domain>",
    ]) {
      assert.throws(
        () =>
          assertDeployConfigEmailVars({
            main: "src/index.ts",
            keep_vars: true,
            vars: {
              EMAIL_DRY_RUN: "false",
              EMAIL_FROM: placeholder,
              EMAIL_FROM_NAME: "Acme",
              EMAIL_BRAND_NAME: "Acme",
            },
          }),
        /placeholder/,
        `expected rejection for ${placeholder}`
      );
    }

    assert.throws(
      () =>
        assertDeployConfigEmailVars({
          main: "src/index.ts",
          keep_vars: true,
          vars: { EMAIL_DRY_RUN: "false", EMAIL_FROM: "flow@mail.example.com" },
        }),
      /EMAIL_FROM_NAME.*EMAIL_BRAND_NAME.*EMAIL_FROM/
    );

    // EMAIL_REQUESTER_FROM_NAME stays optional.
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({ main: "src/index.ts", keep_vars: true, vars: VALID_EMAIL_VARS })
    );

    // Access configured alone does NOT treat email as live when dry-run is on/unset.
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({
        main: "src/index.ts",
        vars: { ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", ACCESS_AUD: VALID_AUD, EMAIL_DRY_RUN: "true" },
      })
    );

    // DEV_NO_AUTH is refused on any guarded Worker deploy.
    assert.throws(
      () => assertDeployConfigAuthVars({ main: "src/index.ts", vars: { DEV_NO_AUTH: "true" } }),
      /DEV_NO_AUTH cannot be "true"/
    );
    assert.throws(
      () => assertDeployConfigAuthVars({ main: "src/index.ts", vars: { DEV_NO_AUTH: true } }),
      /DEV_NO_AUTH cannot be "true"/
    );
    assert.doesNotThrow(() => assertDeployConfigAuthVars({ main: "src/index.ts", vars: {} }));
    assert.doesNotThrow(() => assertDeployConfigAuthVars({ vars: { DEV_NO_AUTH: "true" } }));
  });
});

describe("resolveCloudflareAccount and formatted summaries", () => {
  it("resolves account from whoami or explicit account_id and includes Environment and Account in dialog and stdout", () => {
    const fx = makeFixtureRepo();
    try {
      const acct = resolveCloudflareAccount({
        config: {},
        env: {},
        whoami: { loggedIn: true, accounts: [{ id: "acc_1", name: "Acme" }] },
      });
      assert.equal(acct.label, "Acme (acc_1)");

      const fromEnvMatch = resolveCloudflareAccount({
        config: {},
        env: { CLOUDFLARE_ACCOUNT_ID: "acc_1" },
        whoami: { loggedIn: true, accounts: [{ id: "acc_1", name: "Acme" }] },
      });
      assert.equal(fromEnvMatch.label, "Acme (acc_1)");

      const fromConfigNoWhoami = resolveCloudflareAccount({
        config: { account_id: "acc_cfg" },
        env: {},
        whoami: null,
      });
      assert.equal(fromConfigNoWhoami.label, "acc_cfg (configured)");

      assert.throws(
        () =>
          resolveCloudflareAccount({
            config: { account_id: "acc_1" },
            env: { CLOUDFLARE_ACCOUNT_ID: "acc_2" },
            whoami: null,
          }),
        /conflicts with CLOUDFLARE_ACCOUNT_ID/
      );

      assert.throws(
        () =>
          resolveCloudflareAccount({
            config: {},
            env: { CLOUDFLARE_ACCOUNT_ID: "acc_unknown" },
            whoami: { loggedIn: true, accounts: [{ id: "acc_1", name: "Acme" }] },
          }),
        /does not match any account from wrangler whoami/
      );

      assert.throws(
        () =>
          resolveCloudflareAccount({
            config: {},
            env: {},
            whoami: {
              loggedIn: true,
              accounts: [
                { id: "acc_1", name: "Acme" },
                { id: "acc_2", name: "Beta" },
              ],
            },
          }),
        /multiple Cloudflare accounts/
      );

      const validated = validateDeployConfig(fx.validConfig, fx.checkout);
      validated.effectiveConfig.route = "edge.acme-ops.com/*";
      validated.effectiveConfig.vars.ACCESS_TEAM_DOMAIN = "acme.cloudflareaccess.com";
      validated.effectiveConfig.vars.ACCESS_AUD = VALID_AUD;
      validated.effectiveConfig.vars.DEV_NO_AUTH = "false";
      validated.effectiveConfig.vars.CUSTOM_SECRET = "hidden";
      validated.effectiveConfig.vars.DB_PASSWORD = "pw";
      validated.effectiveConfig.vars.SSH_PRIVATE_KEY = "priv";
      validated.effectiveConfig.vars.SANDBOX_TOKEN = "tok";
      validated.effectiveConfig.vars.SIGNING_KEY = "key";
      const payload = {
        ...validated,
        account: acct,
        gitignored: true,
        checkoutRoot: fx.checkout,
        head: "1234567abcdef",
        commitSubject: "test commit",
      };

      const stdout = formatResolvedConfig(payload);
      const dialog = formatDialogSummary(payload);
      assert.match(stdout, /Environment:\s+\(top-level\)/);
      assert.match(stdout, /Account:\s+Acme \(acc_1\)/);
      assert.match(stdout, /Routes:\s+edge\.acme-ops\.com\/\*/);
      assert.match(stdout, /CUSTOM_SECRET = \[redacted\]/);
      assert.match(stdout, /DB_PASSWORD = \[redacted\]/);
      assert.match(stdout, /SSH_PRIVATE_KEY = \[redacted\]/);
      assert.match(stdout, /SANDBOX_TOKEN = \[redacted\]/);
      assert.match(stdout, /SIGNING_KEY = \[redacted\]/);
      assert.match(dialog, /Environment: \(top-level\)/);
      assert.match(dialog, /Account: Acme \(acc_1\)/);
      assert.match(dialog, /Routes: edge\.acme-ops\.com\/\*/);
      assert.match(dialog, /Auth: DEV_NO_AUTH=false, ACCESS_TEAM_DOMAIN=acme\.cloudflareaccess\.com, ACCESS_AUD=/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("humanApproval", () => {
  it("refuses off macOS and invokes /usr/bin/osascript by absolute path on darwin", async () => {
    await assert.rejects(() => humanApproval("summary", { platform: "linux" }), /requires macOS/);
    await assert.rejects(() => humanApproval("summary", { platform: "win32" }), /requires macOS/);

    let calledBin = null;
    const ok = await humanApproval("Worker: flow", {
      platform: "darwin",
      spawn: (bin) => {
        calledBin = bin;
        return { status: 0, stdout: "button returned:Deploy\n" };
      },
    });
    assert.equal(ok, true);
    assert.equal(calledBin, OSASCRIPT_PATH);
    assert.equal(OSASCRIPT_PATH, "/usr/bin/osascript");
  });
});

describe("deploy-guarded CLI and package.json invariants", () => {
  it("refuses external --config, FLOW_WRANGLER_CONFIG, and CLOUDFLARE_ENV immediately", () => {
    const fx = makeFixtureRepo();
    try {
      const cliRes = spawnSync(process.execPath, ["scripts/deploy-guarded.mjs", "--config", fx.outsideConfig], {
        cwd: DEFAULT_ROOT,
        encoding: "utf8",
      });
      assert.notEqual(cliRes.status, 0);
      assert.match(cliRes.stderr, /deploy refused:.*must be inside this checkout/);

      const envRes = spawnSync(process.execPath, ["scripts/deploy-guarded.mjs"], {
        cwd: DEFAULT_ROOT,
        env: { ...process.env, FLOW_WRANGLER_CONFIG: fx.outsideConfig },
        encoding: "utf8",
      });
      assert.notEqual(envRes.status, 0);
      assert.match(envRes.stderr, /deploy refused:.*must be inside this checkout/);

      const cfEnvRes = spawnSync(process.execPath, ["scripts/deploy-guarded.mjs", "--config", "wrangler.jsonc"], {
        cwd: DEFAULT_ROOT,
        env: { ...process.env, CLOUDFLARE_ENV: "production" },
        encoding: "utf8",
      });
      assert.notEqual(cfEnvRes.status, 0);
      assert.match(cfEnvRes.stderr, /CLOUDFLARE_ENV is set/);
    } finally {
      fx.cleanup();
    }
  });

  it("ensures all deploy scripts route through scripts/deploy-guarded.mjs and CI runs pnpm test", () => {
    const rootPkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, "package.json"), "utf8"));
    const apiPkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, "apps", "api", "package.json"), "utf8"));
    const ciYml = readFileSync(join(DEFAULT_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const rootWrangler = parseJsonc(readFileSync(join(DEFAULT_ROOT, "wrangler.jsonc"), "utf8"));

    assert.equal(rootWrangler.name, "flow-selfhost-example");
    assert.equal(rootPkg.scripts.deploy, "node scripts/deploy-guarded.mjs");
    assert.equal(rootPkg.scripts["deploy:guarded"], "node scripts/deploy-guarded.mjs");
    assert.match(rootPkg.scripts["deploy:demo"], /scripts\/deploy-guarded\.mjs/);
    assert.match(rootPkg.scripts["deploy:sandbox"], /scripts\/deploy-guarded\.mjs/);
    assert.match(apiPkg.scripts.deploy, /scripts\/deploy-guarded\.mjs/);
    assert.match(ciYml, /run:\s+pnpm test\b/);
    assert.doesNotMatch(ciYml, /deploy-worker\.mjs/);

    const pkgFiles = [join(DEFAULT_ROOT, "package.json")];
    for (const dir of ["apps", "packages"]) {
      const base = join(DEFAULT_ROOT, dir);
      for (const entry of readdirSync(base)) {
        const candidate = join(base, entry, "package.json");
        try {
          readFileSync(candidate);
          pkgFiles.push(candidate);
        } catch {
          // skip
        }
      }
    }
    for (const file of pkgFiles) {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
        assert.equal(
          /wrangler\s+deploy/.test(String(cmd)),
          false,
          `${file} script "${name}" must not call wrangler deploy directly: ${cmd}`
        );
      }
    }
  });
});
