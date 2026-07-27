import { readFileSync, existsSync } from "node:fs";

// The ClickUp token never lives in this repo: it comes from the CLICKUP_TOKEN
// environment variable, or from a dotenv file passed with --env-file. The file
// is parsed directly so the importer carries no extra dependency for it.
export const DEFAULT_CLICKUP_BASE = "https://api.clickup.com/api/v2";

/** Minimal dotenv parse: KEY=VALUE, `#` comments, optional surrounding quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export type ClickUpAuth = { token: string; baseUrl: string; source: string };

/**
 * Resolution order: process env (so CI/one-offs can override) then the
 * optional --env-file dotenv.
 */
export function resolveClickUpAuth(envFile?: string): ClickUpAuth {
  const fromProcess = process.env["CLICKUP_TOKEN"];
  if (fromProcess) {
    return {
      token: fromProcess,
      baseUrl: process.env["CLICKUP_BASE_URL"] || DEFAULT_CLICKUP_BASE,
      source: "process.env",
    };
  }
  if (!envFile) {
    throw new Error("CLICKUP_TOKEN not set. Export CLICKUP_TOKEN or pass --env-file <path>.");
  }
  if (!existsSync(envFile)) {
    throw new Error(
      `CLICKUP_TOKEN not set and ${envFile} not found. Export CLICKUP_TOKEN or pass --env-file.`
    );
  }
  const parsed = parseDotEnv(readFileSync(envFile, "utf8"));
  const token = parsed["CLICKUP_TOKEN"];
  if (!token) throw new Error(`CLICKUP_TOKEN missing from ${envFile}`);
  return {
    token,
    baseUrl: parsed["CLICKUP_BASE_URL"] || DEFAULT_CLICKUP_BASE,
    source: envFile,
  };
}
