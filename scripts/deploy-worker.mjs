// `pnpm deploy` from the repo root, after the SPA is built. Self-hosters keep
// their real config in apps/api/wrangler.jsonc (gitignored, copied from
// wrangler.example.jsonc) and deploy with it. A fresh copy of the repo, such
// as the one the "Deploy to Cloudflare" button makes, has no such file, so it
// deploys with the committed root wrangler.jsonc instead.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = fileURLToPath(new URL("../apps/api/wrangler.jsonc", import.meta.url));
const oneClick = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const args = ["--filter", "@flow/api", "exec", "wrangler", "deploy", ...process.argv.slice(2)];
if (!existsSync(local)) args.push("--config", oneClick);
console.log(`Deploying with ${existsSync(local) ? "apps/api/wrangler.jsonc" : "the one-click wrangler.jsonc"}`);
execFileSync("pnpm", args, { stdio: "inherit" });
