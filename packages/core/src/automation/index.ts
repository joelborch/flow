// Public surface of the automation engine.
// Imported by the DO (packages/core/src/index.ts) and, for the side-effect
// payload types, by apps/api via "@flow/core/automation".

export * from "./types.js";
export * from "./template.js";
export * from "./match.js";
export * from "./migrations.js";
export * from "./schedule.js";
export * from "./seeds.js";
export {
  AUTOMATION_MAX_DEPTH,
  evaluateAutomations,
  isDepthExceeded,
  loadEnabledRules,
  runRule,
  writeRunLog,
} from "./engine.js";
