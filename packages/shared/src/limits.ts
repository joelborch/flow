// Zod-free on purpose: the web bundle imports this module directly, and pulling
// it from the package index would drag every schema (and all of zod) into the
// main chunk just for a few numbers.

// ---------------------------------------------------------------------------
// Input size caps. One place, so REST, MCP and the DO all reject the same
// oversized input with the same message. `importBatch` is deliberately exempt
// (see packages/core/src/import.ts): historical ClickUp rows are truncated
// rather than rejected, because a migration must not lose a task.
// ---------------------------------------------------------------------------
export const LIMITS = {
  titleMax: 500,
  descriptionMax: 100_000,
  commentBodyMax: 20_000,
  subtaskTitleMax: 500,
  tagMax: 100,
  tagsMax: 50,
  /** "waiting on…" note that rides along with a snooze. One line, not an essay. */
  blockedNoteMax: 200,
  /** Plain-text context on a checklist step — a paragraph, not a document. */
  subtaskNoteMax: 2_000,
  /** importBatch only: titles longer than this are truncated, never rejected. */
  importTitleMax: 2_000,
  /** What a handoff wants back ("a table of page, sessions, change date"). */
  handoffReturnMax: 1_000,
  /** Tasks a handoff points the recipient's agent at for context. */
  handoffContextMax: 20,
} as const;
