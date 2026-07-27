// Fractional ordering keys. Cards carry a float `position` inside a status
// column, so a reorder only ever rewrites the moved card.
const GAP = 1;
const MIN_GAP = 1e-6;

/**
 * Position for a card dropped between `before` and `after` (either may be
 * undefined at the ends of a column). Returns null when the neighbours have
 * collapsed too close together — the caller should then omit `position` and
 * let the server rebalance.
 */
export function between(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - GAP;
  if (after === undefined) return before + GAP;
  if (after - before < MIN_GAP) return null;
  return before + (after - before) / 2;
}

/** Position that appends to a column ordered by `position`. */
export function append(positions: readonly number[]): number {
  let max = -Infinity;
  for (const p of positions) if (p > max) max = p;
  return max === -Infinity ? 0 : max + GAP;
}
