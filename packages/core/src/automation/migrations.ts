// //
// Schema owned by the automation engine. `automation_rules` and
// `automation_runs` are created by the DO's own base schema
// (packages/core/src/schema.ts) — deliberately NOT duplicated here, since those
// CREATE TABLEs are not IF NOT EXISTS and would collide.
//
// What IS here is the due-date fired-guard the sweep helper in ./schedule.ts
// needs. Apply it from the DO's migration runner AFTER the base migrations:
//
//   import { AUTOMATION_MIGRATIONS } from "./automation/migrations.js";
//   for (const m of AUTOMATION_MIGRATIONS) for (const s of m.statements) sql.exec(s);
//
// Every statement is IF NOT EXISTS, so re-running is a no-op and the runner
// needn't version them — though recording m.id alongside its own versions is
// tidier.
//
// Columns the engine depends on, for the record:
//   automation_rules — id, name, enabled, scope, trigger, conditions, actions,
//                      created_at, updated_at (each of scope/trigger/
//                      conditions/actions a JSON TEXT blob); a single `json`
//                      column holding a whole AutomationRule also works.
//   automation_runs  — rule_id, task_id, trigger, results (JSON), depth, at.

export interface Migration {
  /** Stable identifier; a versioning runner can record it and skip re-applying. */
  id: string;
  /** Statements applied in order. All idempotent. */
  statements: string[];
}

export const AUTOMATION_MIGRATIONS: Migration[] = [
  {
    id: "automation-0001-due-fires",
    statements: [
      // One row per (rule, task, dueDate): moving a due date arms the reminder
      // again, an unchanged one never fires twice, and two rules with different
      // daysBefore windows on the same task don't shadow each other.
      `CREATE TABLE IF NOT EXISTS automation_due_fires (
         rule_id   TEXT NOT NULL,
         task_id   TEXT NOT NULL,
         due_date  INTEGER NOT NULL,
         fired_at  INTEGER NOT NULL,
         PRIMARY KEY (rule_id, task_id, due_date)
       )`,
      `CREATE INDEX IF NOT EXISTS automation_due_fires_due
         ON automation_due_fires (due_date)`,
    ],
  },
];
