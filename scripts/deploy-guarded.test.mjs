import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_ROOT,
  assertDeployConfigEmailVars,
  formatResolvedConfig,
  parseConfigArg,
  selectWebBuildScript,
  validateDeployConfig,
} from "./deploy-guarded.mjs";

const VALID_AUD = "a".repeat(64);
const VALID_PROD_VARS = {
  ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
  ACCESS_AUD: VALID_AUD,
  EMAIL_DRY_RUN: "true",
  EMAIL_FROM: "flow@acme.test",
  EMAIL_FROM_NAME: "Acme",
  EMAIL_BRAND_NAME: "Acme",
  EMAIL_REQUESTER_FROM_NAME: "Acme Support",
};

function makeFixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "flow-guard-test-"));
  const checkout = join(base, "flow-checkout");
  const outside = join(base, "flow-private");

  mkdirSync(join(checkout, "apps", "api", "src"), { recursive: true });
  mkdirSync(join(checkout, "apps", "web", "dist"), { recursive: true });
  mkdirSync(join(checkout, "apps", "web", "dist-demo"), { recursive: true });
  mkdirSync(join(checkout, "demo"), { recursive: true });
  mkdirSync(join(checkout, "sandbox"), { recursive: true });
  mkdirSync(join(outside, "apps", "api", "src"), { recursive: true });
  mkdirSync(join(outside, "apps", "web", "dist"), { recursive: true });

  writeFileSync(join(checkout, "apps", "api", "src", "index.ts"), "export default {};\n");
  writeFileSync(join(checkout, "apps", "api", "src", "sandbox.ts"), "export default {};\n");
  writeFileSync(join(outside, "apps", "api", "src", "index.ts"), "export default {};\n");

  const validConfig = join(checkout, "apps", "api", "wrangler.jsonc");
  writeFileSync(
    validConfig,
    JSON.stringify({
      name: "flow",
      main: "src/index.ts",
      assets: { directory: "../web/dist" },
      vars: VALID_PROD_VARS,
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

describe("parseConfigArg", () => {
  it("parses --config, --config=, -c, and FLOW_WRANGLER_CONFIG", () => {
    assert.equal(
      parseConfigArg(["--", "--config", "apps/api/wrangler.jsonc"], { cwd: "/repo", env: {}, root: "/repo" }),
      "/repo/apps/api/wrangler.jsonc"
    );
    assert.equal(
      parseConfigArg(["--config=demo/wrangler.jsonc"], { cwd: "/repo", env: {}, root: "/repo" }),
      "/repo/demo/wrangler.jsonc"
    );
    assert.equal(
      parseConfigArg(["-c", "sandbox/wrangler.jsonc"], { cwd: "/repo", env: {}, root: "/repo" }),
      "/repo/sandbox/wrangler.jsonc"
    );
    assert.equal(
      parseConfigArg([], { cwd: "/repo", env: { FLOW_WRANGLER_CONFIG: "wrangler.jsonc" }, root: "/repo" }),
      "/repo/wrangler.jsonc"
    );
    assert.equal(
      parseConfigArg([], { cwd: "/repo", env: {}, root: "/repo" }),
      "/repo/apps/api/wrangler.jsonc"
    );
  });

  it("refuses unexpected flags or duplicate config options", () => {
    assert.throws(() => parseConfigArg(["--main", "foo.ts"], { cwd: "/repo", env: {}, root: "/repo" }), /unexpected argument/);
    assert.throws(
      () => parseConfigArg(["--config", "a.jsonc", "-c", "b.jsonc"], { cwd: "/repo", env: {}, root: "/repo" }),
      /duplicate config/
    );
  });
});

describe("validateDeployConfig checkout boundary", () => {
  it("accepts in-checkout full, demo (assets-only), and sandbox (worker-only) configs", () => {
    const fx = makeFixtureRepo();
    try {
      const full = validateDeployConfig(fx.validConfig, fx.checkout, { requireAssetsExist: true });
      assert.equal(full.config.name, "flow");
      assert.ok(full.configSha256.length === 64);
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

  it("refuses a config outside the checkout", () => {
    const fx = makeFixtureRepo();
    try {
      assert.throws(
        () => validateDeployConfig(fx.outsideConfig, fx.checkout),
        /must be inside this checkout/
      );
    } finally {
      fx.cleanup();
    }
  });

  it("refuses a symlinked config pointing outside the checkout", () => {
    const fx = makeFixtureRepo();
    try {
      const linkConfig = join(fx.checkout, "apps", "api", "symlink.jsonc");
      symlinkSync(fx.outsideConfig, linkConfig);
      assert.throws(
        () => validateDeployConfig(linkConfig, fx.checkout),
        /must be inside this checkout/
      );
    } finally {
      fx.cleanup();
    }
  });

  it("refuses main escaping the checkout via ../ or symlink", () => {
    const fx = makeFixtureRepo();
    try {
      const relEscape = join(fx.checkout, "apps", "api", "escape-main.jsonc");
      writeFileSync(
        relEscape,
        JSON.stringify({ name: "flow", main: "../../../flow-private/apps/api/src/index.ts" })
      );
      assert.throws(() => validateDeployConfig(relEscape, fx.checkout), /main escapes checkout/);

      const linkTarget = join(fx.checkout, "apps", "api", "src", "linked-index.ts");
      symlinkSync(join(fx.outside, "apps", "api", "src", "index.ts"), linkTarget);
      const symlinkEscape = join(fx.checkout, "apps", "api", "symlink-main.jsonc");
      writeFileSync(symlinkEscape, JSON.stringify({ name: "flow", main: "src/linked-index.ts" }));
      assert.throws(() => validateDeployConfig(symlinkEscape, fx.checkout), /main symlink escapes checkout/);
    } finally {
      fx.cleanup();
    }
  });

  it("refuses assets.directory escaping the checkout via ../ or symlink (even before build)", () => {
    const fx = makeFixtureRepo();
    try {
      const relEscape = join(fx.checkout, "apps", "api", "escape-assets.jsonc");
      writeFileSync(
        relEscape,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../../../flow-private/apps/web/dist" },
        })
      );
      assert.throws(
        () => validateDeployConfig(relEscape, fx.checkout),
        /assets\.directory escapes checkout/
      );

      const linkedWeb = join(fx.checkout, "apps", "linked-web");
      symlinkSync(join(fx.outside, "apps", "web"), linkedWeb);
      const futureAssets = join(fx.checkout, "apps", "api", "symlink-assets.jsonc");
      writeFileSync(
        futureAssets,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../linked-web/nonexistent-yet" },
        })
      );
      assert.throws(
        () => validateDeployConfig(futureAssets, fx.checkout),
        /assets\.directory symlink escapes checkout/
      );
    } finally {
      fx.cleanup();
    }
  });

  it("refuses env.<name> main or assets.directory escaping checkout", () => {
    const fx = makeFixtureRepo();
    try {
      const envEscape = join(fx.checkout, "apps", "api", "env-escape.jsonc");
      writeFileSync(
        envEscape,
        JSON.stringify({
          name: "flow",
          main: "src/index.ts",
          assets: { directory: "../web/dist" },
          env: {
            staging: {
              main: "../../../flow-private/apps/api/src/index.ts",
            },
          },
        })
      );
      assert.throws(() => validateDeployConfig(envEscape, fx.checkout), /env\.staging\.main escapes checkout/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("assertDeployConfigEmailVars", () => {
  it("fails closed when production Access config is missing any email branding var or uses example.com", () => {
    for (const missingKey of [
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_BRAND_NAME",
      "EMAIL_REQUESTER_FROM_NAME",
    ]) {
      const vars = { ...VALID_PROD_VARS };
      delete vars[missingKey];
      assert.throws(
        () => assertDeployConfigEmailVars({ main: "src/index.ts", vars }),
        new RegExp(missingKey)
      );
    }

    assert.throws(
      () =>
        assertDeployConfigEmailVars({
          main: "src/index.ts",
          vars: { ...VALID_PROD_VARS, EMAIL_FROM: "flow@mail.example.com" },
        }),
      /flow@mail\.example\.com/
    );

    assert.throws(
      () =>
        assertDeployConfigEmailVars({
          main: "src/index.ts",
          vars: { EMAIL_DRY_RUN: "false", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
        }),
      /EMAIL_FROM/
    );
  });

  it("allows complete production vars, dev/sandbox/demo/keep_vars, and unconfigured dry-run templates", () => {
    assert.doesNotThrow(() => assertDeployConfigEmailVars({ main: "src/index.ts", vars: VALID_PROD_VARS }));
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({ main: "src/index.ts", vars: { DEV_NO_AUTH: "true", ACCESS_AUD: VALID_AUD } })
    );
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({ main: "src/index.ts", vars: { SANDBOX: "true" } })
    );
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({ assets: { directory: "../web/dist-demo" } })
    );
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({ main: "src/index.ts", keep_vars: true, vars: { ACCESS_AUD: VALID_AUD } })
    );
    assert.doesNotThrow(() =>
      assertDeployConfigEmailVars({
        main: "src/index.ts",
        vars: { ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com", ACCESS_AUD: "", EMAIL_DRY_RUN: "true" },
      })
    );
  });
});

describe("formatResolvedConfig", () => {
  it("displays gitignored status, SHA-256, resolved paths, routes, bindings, and redacted sorted vars", () => {
    const fx = makeFixtureRepo();
    try {
      const validated = validateDeployConfig(fx.validConfig, fx.checkout);
      validated.config.routes = [{ pattern: "flow.acme.test", custom_domain: true }];
      validated.config.durable_objects = { bindings: [{ name: "WORKSPACE", class_name: "Workspace" }] };
      validated.config.vars.CUSTOM_SECRET = "should-not-print";

      const rendered = formatResolvedConfig({
        ...validated,
        gitignored: true,
        checkoutRoot: fx.checkout,
        head: "1234567abcdef",
        commitSubject: "test commit",
      });

      assert.match(rendered, /Worker:\s+flow/);
      assert.match(rendered, /apps\/api\/wrangler\.jsonc \(gitignored, sha256 [0-9a-f]{12}\)/);
      assert.match(rendered, /Main:\s+apps\/api\/src\/index\.ts/);
      assert.match(rendered, /Assets:\s+apps\/web\/dist/);
      assert.match(rendered, /Routes:\s+flow\.acme\.test/);
      assert.match(rendered, /DO\[WORKSPACE:Workspace\]/);
      assert.match(rendered, /EMAIL_FROM = "flow@acme\.test"/);
      assert.match(rendered, /CUSTOM_SECRET = \[redacted\]/);
      assert.doesNotMatch(rendered, /should-not-print/);
    } finally {
      fx.cleanup();
    }
  });
});

describe("deploy-guarded CLI and package.json invariants", () => {
  it("refuses --config and FLOW_WRANGLER_CONFIG pointing outside the checkout before touching git", () => {
    const fx = makeFixtureRepo();
    try {
      const cliRes = spawnSync(
        process.execPath,
        ["scripts/deploy-guarded.mjs", "--config", fx.outsideConfig],
        { cwd: DEFAULT_ROOT, encoding: "utf8" }
      );
      assert.notEqual(cliRes.status, 0);
      assert.match(cliRes.stderr, /deploy refused:.*must be inside this checkout/);

      const envRes = spawnSync(process.execPath, ["scripts/deploy-guarded.mjs"], {
        cwd: DEFAULT_ROOT,
        env: { ...process.env, FLOW_WRANGLER_CONFIG: fx.outsideConfig },
        encoding: "utf8",
      });
      assert.notEqual(envRes.status, 0);
      assert.match(envRes.stderr, /deploy refused:.*must be inside this checkout/);
    } finally {
      fx.cleanup();
    }
  });

  it("ensures all deploy scripts route through scripts/deploy-guarded.mjs and none call wrangler deploy directly", () => {
    const rootPkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, "package.json"), "utf8"));
    const apiPkg = JSON.parse(readFileSync(join(DEFAULT_ROOT, "apps", "api", "package.json"), "utf8"));

    assert.equal(rootPkg.scripts.deploy, "node scripts/deploy-guarded.mjs");
    assert.equal(rootPkg.scripts["deploy:guarded"], "node scripts/deploy-guarded.mjs");
    assert.match(rootPkg.scripts["deploy:demo"], /scripts\/deploy-guarded\.mjs/);
    assert.match(rootPkg.scripts["deploy:sandbox"], /scripts\/deploy-guarded\.mjs/);
    assert.match(apiPkg.scripts.deploy, /scripts\/deploy-guarded\.mjs/);

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

    assert.throws(() => readFileSync(join(DEFAULT_ROOT, "scripts", "deploy-worker.mjs")), /ENOENT/);
  });
});
