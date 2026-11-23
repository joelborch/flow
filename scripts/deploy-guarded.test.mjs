import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ROOT,
  OSASCRIPT_PATH,
  assertDeployConfigEmailVars,
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
  EMAIL_FROM: "flow@acme.test",
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

    const cleaned = sanitizedWranglerEnv({ PATH: "/usr/bin", CLOUDFLARE_ENV: "prod" });
    assert.equal("CLOUDFLARE_ENV" in cleaned, false);
    assert.equal(cleaned.PATH, "/usr/bin");
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

  it("refuses outside configs, symlinks, main, assets.directory, alias, build.command, site.bucket, base_dir, tsconfig, and text_blobs", () => {
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
        ["build.command", { main: "src/index.ts", build: { command: "echo pwn" } }, /build\.command is not allowed/],
        ["build.cwd", { main: "src/index.ts", build: { cwd: "../../.." } }, /build\.cwd escapes/],
        ["site.bucket", { main: "src/index.ts", site: { bucket: "../../../flow-private" } }, /site\.bucket escapes/],
        ["base_dir", { main: "src/index.ts", base_dir: "../../../flow-private/apps/api" }, /base_dir escapes/],
        ["tsconfig", { main: "src/index.ts", tsconfig: "../../../flow-private/tsconfig.json" }, /tsconfig escapes/],
        ["text_blobs", { main: "src/index.ts", text_blobs: { KEY: "../../../flow-private/secret.txt" } }, /text_blobs\.KEY escapes/],
        ["env override", { main: "src/index.ts", env: { stg: { tsconfig: "../../../flow-private/tsconfig.json" } } }, /env\.stg\.tsconfig escapes/],
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

  it("refuses untracked main or untracked custom assets.directory", () => {
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
    } finally {
      fx.cleanup();
    }
  });

  it("resolves and checks the effective --env configuration instead of top-level", () => {
    const fx = makeFixtureRepo();
    try {
      const cfg = join(fx.checkout, "apps", "api", "multi-env.jsonc");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../web/dist" },
          vars: { EMAIL_DRY_RUN: "true" },
          env: {
            staging: {
              main: "src/staging.ts",
              vars: { EMAIL_DRY_RUN: "false", EMAIL_FROM: "flow@mail.example.com" },
            },
          },
        })
      );

      const top = validateDeployConfig(cfg, fx.checkout);
      assert.equal(top.environment, "(top-level)");
      assert.doesNotThrow(() => assertDeployConfigEmailVars(top.effectiveConfig));

      const stg = validateDeployConfig(cfg, fx.checkout, { envName: "staging" });
      assert.equal(stg.environment, "staging");
      assert.equal(stg.effectiveConfig.name, "flow-staging");
      assert.match(stg.resolvedMain ?? "", /apps\/api\/src\/staging\.ts$/);
      assert.throws(() => assertDeployConfigEmailVars(stg.effectiveConfig), /placeholder/);
      assert.throws(() => resolveEffectiveConfig(stg.config, "missing"), /not defined/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("assertDeployConfigEmailVars", () => {
  it("enforces email checks when EMAIL_DRY_RUN is false (even with keep_vars: true), and does nothing otherwise", () => {
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
      validated.config.vars.CUSTOM_SECRET = "hidden";
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
      assert.match(stdout, /CUSTOM_SECRET = \[redacted\]/);
      assert.match(dialog, /Environment: \(top-level\)/);
      assert.match(dialog, /Account: Acme \(acc_1\)/);
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
