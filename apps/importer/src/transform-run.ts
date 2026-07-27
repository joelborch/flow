import { readFileSync } from "node:fs";
import { Comment, List, Space, Subtask, Task, User } from "@flow/shared";
import { FLOW, RAW, ensureDir, makePaths, readJsonIf, writeJson } from "./paths.js";
import { IdMap, type IdMapFile } from "./idmap.js";
import { info, warn, fail, WarnTally } from "./log.js";
import { DEFAULT_SCOPE_DAYS, makeScope } from "./scope.js";
import { transform, type RoleOverrides, type TransformInput } from "./transform.js";
import type {
  CuAttachment,
  CuComment,
  CuFolder,
  CuList,
  CuSpace,
  CuTask,
  CuTeam,
} from "./clickup-types.js";

export type TransformRunOptions = {
  dataDir: string;
  scopeDays: number;
  /** Path prefix rewritten ClickUp links point at. */
  taskUrlPrefix: string;
  /** Refuse to write output when any entity fails its zod schema. */
  strict: boolean;
  /** Path to a JSON file of email -> role; overrides FLOW_ROLE_OVERRIDES. */
  rolesFile?: string;
};

const VALID_ROLES = new Set(["owner", "admin", "member"]);

/**
 * Role overrides come from --roles <file> or the FLOW_ROLE_OVERRIDES env var,
 * both a JSON object of email -> owner|admin|member. Returns undefined when
 * neither is set, in which case the transform defaults the ClickUp team owner
 * to Flow's owner and everyone else to member.
 */
export function loadRoleOverrides(rolesFile?: string): RoleOverrides | undefined {
  const raw = rolesFile
    ? readFileSync(rolesFile, "utf8")
    : process.env["FLOW_ROLE_OVERRIDES"];
  if (!raw) return undefined;
  const source = rolesFile ?? "FLOW_ROLE_OVERRIDES";
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: RoleOverrides = {};
  for (const [email, role] of Object.entries(parsed)) {
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      throw new Error(`${source}: role for ${email} must be owner|admin|member, got ${String(role)}`);
    }
    out[email.toLowerCase()] = role as RoleOverrides[string];
  }
  return out;
}

// Structural stand-in for a zod schema, so the importer does not need zod as
// a direct dependency just to call safeParse on the contract's schemas.
type Issue = { path: (string | number | symbol)[]; message: string };
type Validator = {
  safeParse(input: unknown): { success: true } | { success: false; error: { issues: Issue[] } };
};

/** Validates every row and reports the first few failures per entity kind. */
function validate(kind: string, schema: Validator, rows: unknown[]): string[] {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    const res = schema.safeParse(row);
    if (!res.success && errors.length < 5) {
      const id = (row as { id?: string }).id ?? `#${i}`;
      const detail = res.error.issues
        .map((x) => `${x.path.map(String).join(".")} ${x.message}`)
        .join("; ");
      errors.push(`${kind} ${id}: ${detail}`);
    }
  });
  return errors;
}

export function runTransform(opts: TransformRunOptions): void {
  const paths = makePaths(opts.dataDir);
  ensureDir(paths.flow);

  const need = <T>(name: string): T => {
    const v = readJsonIf<T>(paths.rawFile(name));
    if (v === null) throw new Error(`missing ${paths.rawFile(name)} — run \`extract\` first`);
    return v;
  };

  const input: TransformInput = {
    team: need<CuTeam>(RAW.team),
    spaces: need<CuSpace[]>(RAW.spaces),
    foldersBySpace: need<Record<string, CuFolder[]>>(RAW.folders),
    lists: need<CuList[]>(RAW.lists),
    tasks: need<CuTask[]>(RAW.tasks),
    commentsByTask: readJsonIf<Record<string, CuComment[]>>(paths.rawFile(RAW.comments)) ?? {},
    attachmentsByTask:
      readJsonIf<Record<string, CuAttachment[]>>(paths.rawFile(RAW.attachments)) ?? {},
  };
  info(
    `raw: ${input.spaces.length} spaces, ${input.lists.length} lists, ${input.tasks.length} tasks, ` +
      `${Object.keys(input.commentsByTask).length} comment sets`
  );

  // Reusing the existing id map preserves importedAt, so synthesized
  // createdAt values (spaces/lists have none in ClickUp) do not drift between
  // runs and re-transforming is byte-stable.
  const idMap = new IdMap(readJsonIf<IdMapFile>(paths.flowFile(FLOW.idmap)));
  const warnings = new WarnTally();
  const roleOverrides = loadRoleOverrides(opts.rolesFile);
  const result = transform(input, {
    idMap,
    scope: makeScope(opts.scopeDays),
    warnings,
    taskUrlPrefix: opts.taskUrlPrefix,
    ...(roleOverrides !== undefined ? { roleOverrides } : {}),
  });
  const b = result.bundle;

  const errors = [
    ...validate("user", User, b.users),
    ...validate("space", Space, b.spaces),
    ...validate("list", List, b.lists),
    ...validate("task", Task, b.tasks),
    ...validate("subtask", Subtask, b.subtasks),
    ...validate("comment", Comment, b.comments),
  ];

  warnings.flush();
  for (const [listId, reason] of result.skippedLists) info(`skipped list ${listId}: ${reason}`);
  info(
    `transformed: ${b.users.length} users, ${b.spaces.length} spaces, ${b.lists.length} lists, ` +
      `${b.tasks.length} tasks, ${b.subtasks.length} subtasks, ${b.comments.length} comments, ` +
      `${b.attachments.length} attachments`
  );
  info(
    `link rewrite: ${result.rewrite.links} links in ${result.rewrite.tasks} descriptions and ` +
      `${result.rewrite.comments} comments; ${result.rewrite.unresolved.length} unresolved ids`
  );

  if (errors.length > 0) {
    for (const e of errors) fail(`schema: ${e}`);
    if (opts.strict) {
      throw new Error(`${errors.length}+ rows failed @flow/shared validation; nothing written`);
    }
    warn("continuing despite schema failures (--no-strict)");
  }

  writeJson(paths.flowFile(FLOW.users), b.users);
  writeJson(paths.flowFile(FLOW.spaces), b.spaces);
  writeJson(paths.flowFile(FLOW.lists), b.lists);
  writeJson(paths.flowFile(FLOW.tasks), b.tasks);
  writeJson(paths.flowFile(FLOW.subtasks), b.subtasks);
  writeJson(paths.flowFile(FLOW.comments), b.comments);
  writeJson(paths.flowFile(FLOW.attachments), b.attachments);
  writeJson(paths.flowFile(FLOW.idmap), idMap.toFile());
  writeJson(paths.flowFile(FLOW.report), {
    generatedAt: Date.now(),
    importedAt: idMap.importedAt,
    scopeDays: opts.scopeDays,
    counts: {
      users: b.users.length,
      spaces: b.spaces.length,
      lists: b.lists.length,
      tasks: b.tasks.length,
      subtasks: b.subtasks.length,
      comments: b.comments.length,
      attachments: b.attachments.length,
    },
    linkRewrite: result.rewrite,
    skippedLists: Object.fromEntries(result.skippedLists),
    warnings: warnings.entries,
    schemaErrors: errors,
  });
  info(`wrote ${paths.flow}`);
}

export function defaultTransformOptions(): TransformRunOptions {
  return {
    dataDir: "./data",
    scopeDays: DEFAULT_SCOPE_DAYS,
    taskUrlPrefix: "/t/",
    strict: true,
  };
}
