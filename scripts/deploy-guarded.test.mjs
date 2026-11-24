import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ROOT,
  OSASCRIPT_PATH,
  PLACEHOLDER_EMAIL_DOMAINS,
  assertDeployConfigAuthVars,
  assertDeployConfigEmailVars,
  assertNoEnvFileOverrides,
  assertNoHiddenGitFlags,
  assertNoIgnoredSourceFiles,
  extractEffectiveCrons,
  extractEffectiveRoutes,
  formatDialogSummary,
  formatResolvedConfig,
  humanApproval,
  isPlaceholderEmail,
  parseConfigArg,
  parseDeployArgs,
  parseJsonc,
  resolveCloudflareAccount,
  resolveEffectiveConfig,
  resolveEffectivePreviewUrls,
  resolveEffectiveWorkersDev,
  runDeploy,
  sanitizedWranglerEnv,
  selectWebBuildScript,
  summarizeMigrations,
  validateDeployConfig,
} from "./deploy-guarded.mjs";
import {
  PLACEHOLDER_EMAIL_DOMAINS as SHARED_PLACEHOLDER_DOMAINS,
  isPlaceholderEmail as sharedIsPlaceholderEmail,
} from "../packages/shared/src/placeholder-email.mjs";

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
  mkdirSync(join(checkout, "packages", "core", "src"), { recursive: true });
  mkdirSync(join(checkout, "packages", "core", "node_modules", "dep"), { recursive: true });
  mkdirSync(join(checkout, "demo"), { recursive: true });
  mkdirSync(join(checkout, "sandbox"), { recursive: true });
  mkdirSync(join(outside, "apps", "api", "src"), { recursive: true });
  mkdirSync(join(outside, "apps", "web", "dist"), { recursive: true });

  writeFileSync(
    join(checkout, ".gitignore"),
    "apps/web/dist/\napps/web/dist-demo/\napps/api/wrangler.jsonc\nnode_modules/\n"
  );
  writeFileSync(join(checkout, "apps", "api", "src", "index.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "src", "staging.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "src", "sandbox.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "tsconfig.json"), "{}\n");
  writeFileSync(join(checkout, "apps", "api", "custom.tsconfig.json"), "{}\n");
  writeFileSync(join(checkout, "apps", "api", "blob.txt"), "hello\n");
  writeFileSync(join(checkout, "apps", "web", "package.json"), '{"name":"@flow/web"}\n');
  writeFileSync(join(checkout, "apps", "static-assets", "index.html"), "<html/>\n");
  writeFileSync(join(checkout, "packages", "core", "src", "index.ts"), "export {};\n");
  writeFileSync(join(checkout, "packages", "core", "node_modules", "dep", "index.js"), "export {};\n");
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
  it("parses --config, --env, refuses CLOUDFLARE_ENV/API_BASE_URL, and strips CF_*/WRANGLER_*", () => {
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
      () => parseDeployArgs([], { cwd: "/repo", env: { CLOUDFLARE_API_BASE_URL: "https://evil.test" }, root: "/repo" }),
      /CLOUDFLARE_API_BASE_URL is set/
    );
    assert.throws(
      () => parseDeployArgs([], { cwd: "/repo", env: { CF_API_BASE_URL: "https://evil.test" }, root: "/repo" }),
      /CF_API_BASE_URL is set/
    );
    assert.throws(
      () => parseDeployArgs(["--main", "foo.ts"], { cwd: "/repo", env: {}, root: "/repo" }),
      /unexpected argument/
    );

    const cleaned = sanitizedWranglerEnv({
      PATH: "/usr/bin",
      CLOUDFLARE_ENV: "prod",
      CLOUDFLARE_API_BASE_URL: "https://evil.test",
      CF_API_TOKEN: "tok",
      CF_ACCOUNT_ID: "acc",
      CF_API_BASE_URL: "https://evil.test",
      WRANGLER_CI_OVERRIDE_NAME: "hijack",
      WRANGLER_CONFIG_FILENAME: "other.jsonc",
      wrangler_api_environment: "staging",
    });
    assert.equal("CLOUDFLARE_ENV" in cleaned, false);
    assert.equal("CLOUDFLARE_API_BASE_URL" in cleaned, false);
    assert.equal("CF_API_TOKEN" in cleaned, false);
    assert.equal("CF_ACCOUNT_ID" in cleaned, false);
    assert.equal("CF_API_BASE_URL" in cleaned, false);
    assert.equal("WRANGLER_CI_OVERRIDE_NAME" in cleaned, false);
    assert.equal("WRANGLER_CONFIG_FILENAME" in cleaned, false);
    assert.equal("wrangler_api_environment" in cleaned, false);
    assert.equal(cleaned.PATH, "/usr/bin");
  });

  it("strictly parses .env/.dev.vars (KEY=value, KEY: value, lone \\r, U+2028) and refuses CF_*/CLOUDFLARE_*/WRANGLER_* or unparseable lines", () => {
    const fx = makeFixtureRepo();
    try {
      const apiDir = join(fx.checkout, "apps", "api");
      // Local dev auth toggle + colon syntax + CRLF/CR/U+2028 are parsed cleanly without false errors.
      writeFileSync(
        join(apiDir, ".dev.vars"),
        '\uFEFF# comment\rDEV_NO_AUTH: "true"\u2028APP_MODE = local\r\n'
      );
      assert.doesNotThrow(() => validateDeployConfig(fx.validConfig, fx.checkout));

      // Unparseable non-comment line is refused without printing raw values.
      writeFileSync(join(apiDir, ".env"), "OK_VAR=1\nsome secret junk line\n");
      assert.throws(
        () => validateDeployConfig(fx.validConfig, fx.checkout),
        /env file apps\/api\/\.env line 2 cannot be parsed as KEY=value or KEY: value/
      );
      rmSync(join(apiDir, ".env"));

      // Forbidden CF_API_TOKEN / CF_ACCOUNT_ID / CF_API_BASE_URL with colon, CR, U+2028.
      writeFileSync(
        join(apiDir, ".env"),
        "CF_API_TOKEN: supersecret\rCF_ACCOUNT_ID=acc_x\u2028CF_API_BASE_URL=https://evil.test\nWRANGLER_CI_OVERRIDE_NAME=evil\n"
      );
      assert.throws(
        () => validateDeployConfig(fx.validConfig, fx.checkout),
        /CF_API_TOKEN, CF_ACCOUNT_ID, CF_API_BASE_URL, WRANGLER_CI_OVERRIDE_NAME/
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

  it("refuses outside configs, symlinks, paths, define/rules/find_additional_modules, unused features, and deleted_classes migrations", () => {
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
        ["tail_consumers", { main: "src/index.ts", tail_consumers: [{ service: "tail" }] }, /tail_consumers is not allowed/],
        ["services", { main: "src/index.ts", services: [{ binding: "SVC", service: "other" }] }, /services is not allowed/],
        ["unsafe", { main: "src/index.ts", unsafe: { bindings: [] } }, /unsafe is not allowed/],
        ["containers", { main: "src/index.ts", containers: [{ class_name: "Box" }] }, /containers is not allowed/],
        [
          "durable_objects script_name",
          { main: "src/index.ts", durable_objects: { bindings: [{ name: "DO", class_name: "X", script_name: "ext" }] } },
          /durable_objects\.bindings\[0\]\.script_name is not allowed/,
        ],
        [
          "deleted_classes migration",
          { main: "src/index.ts", migrations: [{ tag: "v2", deleted_classes: ["OldDO"] }] },
          /migrations\[0\]\.deleted_classes is not allowed/,
        ],
        ["env override", { main: "src/index.ts", env: { stg: { tsconfig: "../../../flow-private/tsconfig.json" } } }, /env\.stg\.tsconfig escapes/],
        ["env define", { main: "src/index.ts", env: { stg: { define: { X: "1" } } } }, /env\.stg\.define is not allowed/],
        ["env find_additional_modules", { main: "src/index.ts", env: { stg: { find_additional_modules: true } } }, /env\.stg\.find_additional_modules is not allowed/],
        [
          "env deleted_classes",
          { main: "src/index.ts", env: { stg: { migrations: [{ tag: "v2", deleted_classes: ["OldDO"] }] } } },
          /env\.stg\.migrations\[0\]\.deleted_classes is not allowed/,
        ],
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

  it("refuses untracked main/tsconfig/assets, gitignored or excluded files under apps/api/src and packages, and hidden git index flags", () => {
    const fx = makeFixtureRepo();
    try {
      const untrackedMain = join(fx.checkout, "apps", "api", "src", "untracked.ts");
      writeFileSync(untrackedMain, "export default {};\n");
      const cfg1 = join(fx.checkout, "apps", "api", "untracked-main.jsonc");
      writeFileSync(cfg1, JSON.stringify({ name: "flow", main: "src/untracked.ts" }));
      assert.throws(() => validateDeployConfig(cfg1, fx.checkout), /main is not tracked by git/);
      rmSync(untrackedMain);

      const untrackedTsconfig = join(fx.checkout, "apps", "api", "untracked.tsconfig.json");
      writeFileSync(untrackedTsconfig, "{}\n");
      const cfgTs = join(fx.checkout, "apps", "api", "untracked-ts.jsonc");
      writeFileSync(cfgTs, JSON.stringify({ name: "flow", main: "src/index.ts", tsconfig: "untracked.tsconfig.json" }));
      assert.throws(() => validateDeployConfig(cfgTs, fx.checkout), /tsconfig is not tracked by git/);
      rmSync(untrackedTsconfig);

      // Gitignored or excluded file under apps/api/src or packages must fail (while packages/*/node_modules is ignored).
      writeFileSync(join(fx.checkout, ".gitignore"), "apps/web/dist/\napps/web/dist-demo/\napps/api/wrangler.jsonc\nnode_modules/\n*.ignored.ts\n");
      writeFileSync(join(fx.checkout, "apps", "api", "src", "hidden.ignored.ts"), "export {};\n");
      assert.throws(() => validateDeployConfig(fx.validConfig, fx.checkout), /gitignored or excluded files exist.*apps\/api\/src\/hidden\.ignored\.ts/);
      rmSync(join(fx.checkout, "apps", "api", "src", "hidden.ignored.ts"));

      writeFileSync(join(fx.checkout, ".git", "info", "exclude"), "packages/core/src/excluded.ts\n");
      writeFileSync(join(fx.checkout, "packages", "core", "src", "excluded.ts"), "export {};\n");
      assert.throws(() => assertNoIgnoredSourceFiles(fx.checkout), /gitignored or excluded files exist.*packages\/core\/src\/excluded\.ts/);
      rmSync(join(fx.checkout, "packages", "core", "src", "excluded.ts"));
      writeFileSync(join(fx.checkout, ".git", "info", "exclude"), "");

      const untrackedAssets = join(fx.checkout, "apps", "untracked-assets");
      mkdirSync(untrackedAssets, { recursive: true });
      writeFileSync(join(untrackedAssets, "index.html"), "<html/>\n");
      const cfg2 = join(fx.checkout, "apps", "api", "untracked-assets.jsonc");
      writeFileSync(
        cfg2,
        JSON.stringify({ name: "flow", main: "src/index.ts", assets: { directory: "../untracked-assets" } })
      );
      assert.throws(() => validateDeployConfig(cfg2, fx.checkout), /assets\.directory is not tracked by git/);

      // Tracked static directory + tracked custom tsconfig pass cleanly.
      const cfg3 = join(fx.checkout, "apps", "api", "tracked-assets.jsonc");
      writeFileSync(
        cfg3,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          tsconfig: "custom.tsconfig.json",
          assets: { directory: "../static-assets" },
        })
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

  it("resolves effective --env (singular route + inherited routes, workers_dev/preview_urls defaults, crons, migrations)", () => {
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
          triggers: { crons: ["0 * * * *"] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Workspace"] }],
          vars: { EMAIL_DRY_RUN: "true" },
          env: {
            inherited: {
              main: "src/staging.ts",
              vars: { EMAIL_DRY_RUN: "false", EMAIL_FROM: "flow@yourdomain.com" },
            },
            singularPlusInherited: {
              route: "one.acme-ops.com/*",
              vars: { EMAIL_DRY_RUN: "false", ...VALID_EMAIL_VARS },
            },
            clearedWithNoRoutes: {
              routes: [],
              preview_urls: true,
              vars: { EMAIL_DRY_RUN: "true" },
            },
          },
        })
      );

      const top = validateDeployConfig(cfg, fx.checkout);
      assert.equal(top.environment, "(top-level)");
      assert.deepEqual(extractEffectiveRoutes(top.effectiveConfig), ["top.acme-ops.com"]);
      assert.deepEqual(resolveEffectiveWorkersDev(top.effectiveConfig), { value: false, defaulted: true });
      assert.deepEqual(resolveEffectivePreviewUrls(top.effectiveConfig), { value: false, defaulted: true });
      assert.deepEqual(extractEffectiveCrons(top.effectiveConfig), ["0 * * * *"]);
      assert.equal(summarizeMigrations(top.effectiveConfig), "v1(new_sqlite:Workspace)");
      assert.doesNotThrow(() => assertDeployConfigEmailVars(top.effectiveConfig));

      const inh = validateDeployConfig(cfg, fx.checkout, { envName: "inherited" });
      assert.equal(inh.environment, "inherited");
      assert.equal(inh.effectiveConfig.name, "flow-inherited");
      assert.match(inh.resolvedMain ?? "", /apps\/api\/src\/staging\.ts$/);
      assert.deepEqual(extractEffectiveRoutes(inh.effectiveConfig), ["top.acme-ops.com"]);
      assert.deepEqual(extractEffectiveCrons(inh.effectiveConfig), ["0 * * * *"]);
      assert.throws(() => assertDeployConfigEmailVars(inh.effectiveConfig), /placeholder/);

      // An env block specifying singular `route` under top-level `routes` deploys BOTH in Wrangler.
      const single = validateDeployConfig(cfg, fx.checkout, { envName: "singularPlusInherited" });
      assert.deepEqual(extractEffectiveRoutes(single.effectiveConfig), ["one.acme-ops.com/*", "top.acme-ops.com"]);
      assert.doesNotThrow(() => assertDeployConfigEmailVars(single.effectiveConfig));

      const cleared = validateDeployConfig(cfg, fx.checkout, { envName: "clearedWithNoRoutes" });
      assert.deepEqual(extractEffectiveRoutes(cleared.effectiveConfig), []);
      assert.deepEqual(resolveEffectiveWorkersDev(cleared.effectiveConfig), { value: true, defaulted: true });
      assert.deepEqual(resolveEffectivePreviewUrls(cleared.effectiveConfig), { value: true, defaulted: false });

      assert.throws(() => resolveEffectiveConfig(inh.config, "missing"), /not defined/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("assertDeployConfigEmailVars and assertDeployConfigAuthVars", () => {
  it("enforces shared placeholder list when EMAIL_DRY_RUN is false (even with DEV_NO_AUTH or keep_vars), and refuses DEV_NO_AUTH", () => {
    assert.equal(PLACEHOLDER_EMAIL_DOMAINS, SHARED_PLACEHOLDER_DOMAINS);
    assert.equal(isPlaceholderEmail, sharedIsPlaceholderEmail);

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
              DEV_NO_AUTH: "true",
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
      validated.effectiveConfig.triggers = { crons: ["0 * * * *"] };
      validated.effectiveConfig.migrations = [{ tag: "v1", new_sqlite_classes: ["Workspace"] }];
      validated.effectiveConfig.vars.OWNER_EMAIL = "owner@acme-ops.com";
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
      assert.match(stdout, /Routes:\s+edge\.acme-ops\.com\/\* \(workers_dev: false \(default\), preview_urls: false \(default\)\)/);
      assert.match(stdout, /Crons:\s+0 \* \* \* \*/);
      assert.match(stdout, /Migrations:\s+v1\(new_sqlite:Workspace\)/);
      assert.match(stdout, /CUSTOM_SECRET = \[redacted\]/);
      assert.match(stdout, /DB_PASSWORD = \[redacted\]/);
      assert.match(stdout, /SSH_PRIVATE_KEY = \[redacted\]/);
      assert.match(stdout, /SANDBOX_TOKEN = \[redacted\]/);
      assert.match(stdout, /SIGNING_KEY = \[redacted\]/);
      assert.match(dialog, /Environment: \(top-level\)/);
      assert.match(dialog, /Account: Acme \(acc_1\)/);
      assert.match(dialog, /Routes: edge\.acme-ops\.com\/\* \(workers_dev: false \(default\), preview_urls: false \(default\)\)/);
      assert.match(dialog, /Crons: 0 \* \* \* \*/);
      assert.match(dialog, /Migrations: v1\(new_sqlite:Workspace\)/);
      assert.match(
        dialog,
        /Auth: OWNER_EMAIL=owner@acme-ops\.com, DEV_NO_AUTH=false, ACCESS_TEAM_DOMAIN=acme\.cloudflareaccess\.com, ACCESS_AUD=/
      );
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
    const exampleWrangler = parseJsonc(readFileSync(join(DEFAULT_ROOT, "apps", "api", "wrangler.example.jsonc"), "utf8"));

    assert.equal(rootWrangler.name, "flow-selfhost-example");
    assert.equal(rootWrangler.r2_buckets[0].bucket_name, "flow-selfhost-example-attachments");
    assert.equal(rootWrangler.queues.producers[0].queue, "flow-selfhost-example-side-effects");
    assert.equal(rootWrangler.queues.consumers[0].queue, "flow-selfhost-example-side-effects");
    assert.equal(rootWrangler.queues.consumers[0].dead_letter_queue, "flow-selfhost-example-dlq");
    assert.equal(rootWrangler.queues.consumers[1].queue, "flow-selfhost-example-dlq");
    assert.notEqual(exampleWrangler.name, "flow");
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

describe("runDeploy end-to-end orchestration with stubs", () => {
  function setupRemoteRepo(wranglerVars = {}) {
    const base = mkdtempSync(join(tmpdir(), "flow-rundeploy-test-"));
    const bareRemote = join(base, "origin.git");
    const checkout = join(base, "checkout");
    execFileSync("git", ["init", "--bare", "-q", bareRemote]);
    mkdirSync(join(checkout, "apps", "api", "src"), { recursive: true });
    mkdirSync(join(checkout, "apps", "web", "dist"), { recursive: true });
    mkdirSync(join(checkout, "packages", "core", "src"), { recursive: true });

    writeFileSync(join(checkout, ".gitignore"), "apps/web/dist/\napps/api/wrangler.jsonc\nnode_modules/\n");
    writeFileSync(join(checkout, "apps", "api", "src", "index.ts"), "export default {};\n");
    writeFileSync(join(checkout, "apps", "api", "tsconfig.json"), "{}\n");
    writeFileSync(join(checkout, "apps", "web", "package.json"), '{"name":"@flow/web"}\n');
    writeFileSync(join(checkout, "apps", "web", "dist", "index.html"), "<html/>\n");
    writeFileSync(join(checkout, "packages", "core", "src", "index.ts"), "export {};\n");

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
    execFileSync("git", ["config", "user.email", "test@acme-ops.com"], { cwd: checkout });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: checkout });
    execFileSync("git", ["add", "-A"], { cwd: checkout });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: checkout });
    execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: checkout });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: checkout });

    const cfgPath = join(checkout, "apps", "api", "wrangler.jsonc");
    const writeConfig = (vars = {}) => {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../web/dist" },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Workspace"] }],
          vars: {
            OWNER_EMAIL: "owner@acme-ops.com",
            ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
            ACCESS_AUD: VALID_AUD,
            ...VALID_EMAIL_VARS,
            ...vars,
          },
        })
      );
    };
    writeConfig(wranglerVars);
    return { base, checkout, cfgPath, writeConfig, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("drives full runDeploy gate flow, scrubs child env, and aborts on DEV_NO_AUTH, CLOUDFLARE_API_BASE_URL, or hidden git flags", async () => {
    const fx = setupRemoteRepo();
    try {
      const commands = [];
      let deployedEnv = null;
      let dialogShown = "";
      const makeSpawn = () => (cmd, args, opts) => {
        if (cmd === "git") return spawnSync(cmd, args, opts);
        commands.push([cmd, ...args]);
        if (cmd === "pnpm" && args[0] === "--filter" && args[2] === "build") {
          mkdirSync(join(fx.checkout, "apps", "web", "dist"), { recursive: true });
          writeFileSync(join(fx.checkout, "apps", "web", "dist", "index.html"), "<html/>\n");
        }
        if (cmd === "pnpm" && args[1] === "wrangler" && args[2] === "whoami") {
          return {
            status: 0,
            stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: "acc_1", name: "Acme" }] }),
          };
        }
        if (cmd === "pnpm" && args[1] === "wrangler" && args[2] === "deploy" && !args.includes("--dry-run")) {
          deployedEnv = opts.env;
        }
        return { status: 0, stdout: "" };
      };

      await runDeploy({
        root: fx.checkout,
        cwd: fx.checkout,
        argv: [],
        platform: "darwin",
        env: {
          PATH: process.env.PATH,
          WRANGLER_CI_OVERRIDE_NAME: "hijack",
          CF_API_TOKEN: "stale_token",
        },
        spawnSync: makeSpawn(),
        humanApproval: async (summary) => {
          dialogShown = summary;
          return true;
        },
        fetch: async () => new Response('{"ok":true}', { status: 200 }),
        log: () => {},
        errorLog: () => {},
      });

      assert.match(dialogShown, /Routes: \(none\) \(workers_dev: true \(default\), preview_urls: true \(default\)\)/);
      assert.match(dialogShown, /Migrations: v1\(new_sqlite:Workspace\)/);
      assert.match(dialogShown, /Auth: OWNER_EMAIL=owner@acme-ops\.com/);
      assert.ok(commands.some((c) => c[0] === "pnpm" && c.includes("deploy") && !c.includes("--dry-run")));
      assert.equal("WRANGLER_CI_OVERRIDE_NAME" in deployedEnv, false);
      assert.equal("CF_API_TOKEN" in deployedEnv, false);

      // DEV_NO_AUTH is refused inside runDeploy before approval or deploy.
      fx.writeConfig({ DEV_NO_AUTH: "true" });
      let deployCalled = false;
      await assert.rejects(
        () =>
          runDeploy({
            root: fx.checkout,
            cwd: fx.checkout,
            argv: [],
            platform: "darwin",
            env: { PATH: process.env.PATH },
            spawnSync: makeSpawn(),
            humanApproval: async () => {
              deployCalled = true;
              return true;
            },
            log: () => {},
            errorLog: () => {},
          }),
        /DEV_NO_AUTH cannot be "true"/
      );
      assert.equal(deployCalled, false);
      fx.writeConfig({});

      // CLOUDFLARE_API_BASE_URL is refused immediately inside runDeploy.
      await assert.rejects(
        () =>
          runDeploy({
            root: fx.checkout,
            cwd: fx.checkout,
            argv: [],
            platform: "darwin",
            env: { PATH: process.env.PATH, CLOUDFLARE_API_BASE_URL: "https://evil.test" },
            spawnSync: makeSpawn(),
            log: () => {},
            errorLog: () => {},
          }),
        /CLOUDFLARE_API_BASE_URL is set/
      );

      // --skip-worktree added mid-run right before approval still stops deploy before wrangler runs.
      const beforeFailCount = commands.length;
      await assert.rejects(
        () =>
          runDeploy({
            root: fx.checkout,
            cwd: fx.checkout,
            argv: [],
            platform: "darwin",
            env: { PATH: process.env.PATH },
            spawnSync: makeSpawn(),
            humanApproval: async () => {
              execFileSync("git", ["update-index", "--skip-worktree", "apps/api/src/index.ts"], { cwd: fx.checkout });
              return true;
            },
            log: () => {},
            errorLog: () => {},
          }),
        /skip-worktree or assume-unchanged set/
      );
      const afterCommands = commands.slice(beforeFailCount);
      assert.equal(
        afterCommands.some((c) => c[0] === "pnpm" && c.includes("deploy") && !c.includes("--dry-run")),
        false
      );
    } finally {
      fx.cleanup();
    }
  });
});
