// ClickUp -> Flow importer. Runs locally in Node (tsx), never deployed.
// Owned by the importer agent. Three passes: extract to raw JSON on disk,
// transform to Flow entities, load via the Flow REST API (import mode:
// automations never fire on imported mutations — that guarantee is the API's,
// this CLI just uses the import routes).
//
//   pnpm --filter @flow/importer extract
//   pnpm --filter @flow/importer transform
//   pnpm --filter @flow/importer load --api https://flow.example.com --key flow_xxx
//
// Plain argv parsing on purpose — no commander, no new runtime deps.
import { runExtract } from "./extract.js";
import { runTransform } from "./transform-run.js";
import { runLoad } from "./load.js";
import { DEFAULT_SCOPE_DAYS } from "./scope.js";
import { fail } from "./log.js";

type Flags = { flags: Map<string, string>; bools: Set<string> };

function parseArgs(argv: string[]): Flags {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      bools.add(name);
    }
  }
  return { flags, bools };
}

const str = (f: Flags, name: string, dflt: string): string => f.flags.get(name) ?? dflt;
const num = (f: Flags, name: string, dflt: number): number => {
  const v = f.flags.get(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
};
const bool = (f: Flags, name: string): boolean =>
  f.bools.has(name) || f.flags.get(name) === "true";

const USAGE = `
flow importer — ClickUp -> Flow, three passes

  extract     crawl ClickUp v2 into <data-dir>/raw/*.json
  transform   raw -> <data-dir>/flow/*.json in @flow/shared shapes
  load        POST <data-dir>/flow/*.json to the Flow import endpoints

Common
  --data-dir <path>     default ./data
  --scope-days <n>      default ${DEFAULT_SCOPE_DAYS}; open tasks always in scope,
                        closed ones only if closed/updated inside the window

extract
  --team <id>           ClickUp team (workspace) id. Required unless
                        CLICKUP_TEAM_ID is set.
  --env-file <path>     dotenv holding CLICKUP_TOKEN; by default the token is
                        read from the CLICKUP_TOKEN env var
  --fresh               ignore the checkpoint and start over
  --max-pages <n>       stop after N task pages (dry test; no bulk crawl)
  --no-comments         skip the per-task comment pass
  --no-attachments      skip the per-task attachment-metadata pass

transform
  --task-url-prefix <s> default /t/ — what rewritten ClickUp links point at
  --roles <path>        JSON file of email -> owner|admin|member role
                        overrides. Or set FLOW_ROLE_OVERRIDES to the same
                        JSON. Default: the ClickUp team owner becomes owner.
  --no-strict           write output even if rows fail zod validation

load
  --api <url>           Flow base URL, e.g. https://flow.example.com
  --key <flow_xxx>      Flow API key (Bearer). Or set FLOW_API_KEY.
  --batch-size <n>      default 200
  --dry-run             log the requests, send nothing
  --no-attachments      skip the attachment streaming pass
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = parseArgs(rest);
  const dataDir = str(f, "data-dir", "./data");
  const scopeDays = num(f, "scope-days", DEFAULT_SCOPE_DAYS);

  switch (cmd) {
    case "extract": {
      const envFile = f.flags.get("env-file");
      const teamId = f.flags.get("team") ?? process.env["CLICKUP_TEAM_ID"];
      if (!teamId) throw new Error("extract needs --team <id> (or CLICKUP_TEAM_ID)");
      await runExtract({
        teamId,
        dataDir,
        scopeDays,
        ...(envFile !== undefined ? { envFile } : {}),
        resume: !bool(f, "fresh"),
        ...(f.flags.has("max-pages") ? { maxPages: num(f, "max-pages", 1) } : {}),
        skipComments: bool(f, "no-comments"),
        skipAttachments: bool(f, "no-attachments"),
      });
      break;
    }
    case "transform": {
      const rolesFile = f.flags.get("roles");
      runTransform({
        dataDir,
        scopeDays,
        taskUrlPrefix: str(f, "task-url-prefix", "/t/"),
        strict: !bool(f, "no-strict"),
        ...(rolesFile !== undefined ? { rolesFile } : {}),
      });
      break;
    }
    case "load": {
      const api = f.flags.get("api") ?? process.env["FLOW_API_BASE"];
      const key = f.flags.get("key") ?? process.env["FLOW_API_KEY"];
      if (!api) throw new Error("load needs --api <url> (or FLOW_API_BASE)");
      if (!key) throw new Error("load needs --key <flow_xxx> (or FLOW_API_KEY)");
      await runLoad({
        dataDir,
        apiBase: api,
        apiKey: key,
        batchSize: num(f, "batch-size", 200),
        dryRun: bool(f, "dry-run"),
        skipAttachments: bool(f, "no-attachments"),
      });
      break;
    }
    default:
      console.log(USAGE.trim());
      if (cmd !== undefined && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
