// Native pointer-event drag and drop. Deliberately imperative: nothing here
// touches signals during a drag, so a 500-card board never re-renders while the
// pointer moves. The lifted card is a cloned node driven by `transform`, the
// insertion point is a single fixed-position rule, and hit testing runs off
// cached rects — transform/opacity only, no layout writes in the hot path.
import { moveTask, statusById, tasksByListAndStatus } from "../store/index.js";
import { between } from "../lib/frac.js";

type Column = { el: HTMLElement; listId: string; statusId: string };

const columns = new Map<string, Column>();

export function registerColumn(statusId: string, listId: string, el: HTMLElement | null): void {
  if (el) columns.set(statusId, { el, listId, statusId });
  else columns.delete(statusId);
}

const DRAG_THRESHOLD = 4;
const TOUCH_HOLD_MS = 340;
const EDGE = 52;
const EDGE_SPEED = 14;

type CardRect = { id: string; top: number; bottom: number };

type Drag = {
  taskId: string;
  fromListId: string;
  source: HTMLElement;
  ghost: HTMLElement;
  rule: HTMLElement;
  grabX: number;
  grabY: number;
  x: number;
  y: number;
  frame: number | null;
  overStatusId: string | null;
  index: number;
  cache: { statusId: string; scrollTop: number; rects: CardRect[] } | null;
};

let drag: Drag | null = null;
let candidate: {
  taskId: string;
  listId: string;
  el: HTMLElement;
  startX: number;
  startY: number;
  pointerId: number;
  holdTimer: number | null;
} | null = null;

let lastDragEnd = 0;

/** True right after a drag, so the card's click handler can stand down. */
export function consumedByDrag(): boolean {
  return Date.now() - lastDragEnd < 120;
}

export function isDragging(): boolean {
  return drag !== null;
}

// --- start -----------------------------------------------------------------

export function onCardPointerDown(ev: PointerEvent, taskId: string, listId: string): void {
  if (ev.button !== 0 || drag) return;
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) return;
  const target = ev.target as HTMLElement | null;
  if (target?.closest("button, a, input, textarea, select, [data-no-drag]")) return;

  candidate = {
    taskId,
    listId,
    el,
    startX: ev.clientX,
    startY: ev.clientY,
    pointerId: ev.pointerId,
    holdTimer: null,
  };

  if (ev.pointerType === "touch") {
    const { clientX, clientY } = ev;
    candidate.holdTimer = window.setTimeout(() => {
      if (candidate) start(candidate.el, candidate.taskId, candidate.listId, clientX, clientY);
    }, TOUCH_HOLD_MS);
  }

  window.addEventListener("pointermove", onCandidateMove, { passive: false });
  window.addEventListener("pointerup", onCandidateUp, { passive: true });
  window.addEventListener("pointercancel", onCandidateUp, { passive: true });
}

function clearCandidate(): void {
  if (candidate?.holdTimer !== null && candidate?.holdTimer !== undefined) {
    clearTimeout(candidate.holdTimer);
  }
  candidate = null;
  window.removeEventListener("pointermove", onCandidateMove);
  window.removeEventListener("pointerup", onCandidateUp);
  window.removeEventListener("pointercancel", onCandidateUp);
}

function onCandidateMove(ev: PointerEvent): void {
  if (!candidate || drag) return;
  const dx = ev.clientX - candidate.startX;
  const dy = ev.clientY - candidate.startY;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (ev.pointerType === "touch") {
    // A swipe that never became a hold is a scroll, not a drag.
    clearCandidate();
    return;
  }
  start(candidate.el, candidate.taskId, candidate.listId, ev.clientX, ev.clientY);
}

function onCandidateUp(): void {
  if (!drag) clearCandidate();
}

function suppressContextMenu(ev: Event): void {
  ev.preventDefault();
}

let prevTouchAction = "";

function start(el: HTMLElement, taskId: string, fromListId: string, x: number, y: number): void {
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);

  const rule = document.createElement("div");
  rule.className = "drop-rule";
  rule.style.opacity = "0";
  document.body.appendChild(rule);

  el.classList.add("drag-source");
  document.body.classList.add("is-dragging");
  // A touch drag begins mid-gesture, after the hold timer; killing pan on the
  // body stops the column scrolling out from under the finger, and the
  // long-press context menu never gets to interrupt.
  prevTouchAction = document.body.style.touchAction;
  document.body.style.touchAction = "none";
  window.addEventListener("contextmenu", suppressContextMenu);

  drag = {
    taskId,
    fromListId,
    source: el,
    ghost,
    rule,
    grabX: x - rect.left,
    grabY: y - rect.top,
    x,
    y,
    frame: null,
    overStatusId: null,
    index: 0,
    cache: null,
  };

  clearCandidate();
  window.addEventListener("pointermove", onDragMove, { passive: false });
  window.addEventListener("pointerup", onDragUp, { passive: true });
  window.addEventListener("pointercancel", cancelDrag, { passive: true });
  window.addEventListener("keydown", onDragKey);
  paint();
}

// --- move ------------------------------------------------------------------

function onDragMove(ev: PointerEvent): void {
  if (!drag) return;
  ev.preventDefault();
  drag.x = ev.clientX;
  drag.y = ev.clientY;
  if (drag.frame === null) drag.frame = requestAnimationFrame(paint);
}

function columnAt(x: number, y: number): Column | null {
  let fallback: Column | null = null;
  let bestDx = Infinity;
  for (const col of columns.values()) {
    const r = col.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top - 200 && y <= r.bottom + 200) return col;
    const dx = Math.abs(x - (r.left + r.width / 2));
    if (dx < bestDx) {
      bestDx = dx;
      fallback = col;
    }
  }
  return fallback;
}

function cardRects(col: Column): CardRect[] {
  const scrollTop = col.el.scrollTop;
  const cache = drag?.cache;
  if (cache && cache.statusId === col.statusId && cache.scrollTop === scrollTop) return cache.rects;
  const nodes = col.el.querySelectorAll<HTMLElement>("[data-task-id]");
  const rects: CardRect[] = [];
  for (const node of nodes) {
    const id = node.dataset.taskId;
    if (!id || id === drag?.taskId) continue;
    const r = node.getBoundingClientRect();
    rects.push({ id, top: r.top, bottom: r.bottom });
  }
  if (drag) drag.cache = { statusId: col.statusId, scrollTop, rects };
  return rects;
}

function paint(): void {
  const d = drag;
  if (!d) return;
  d.frame = null;

  d.ghost.style.transform = `translate3d(${d.x - d.grabX}px, ${d.y - d.grabY}px, 0) rotate(1deg) scale(1.02)`;

  const col = columnAt(d.x, d.y);
  if (!col) {
    d.rule.style.opacity = "0";
    return;
  }

  if (d.overStatusId !== col.statusId) {
    if (d.overStatusId) columns.get(d.overStatusId)?.el.parentElement?.classList.remove("is-over");
    col.el.parentElement?.classList.add("is-over");
    d.overStatusId = col.statusId;
    d.cache = null;
  }

  // Auto-scroll when hovering near a column's ends.
  const r = col.el.getBoundingClientRect();
  if (d.y < r.top + EDGE) col.el.scrollTop -= EDGE_SPEED;
  else if (d.y > r.bottom - EDGE) col.el.scrollTop += EDGE_SPEED;

  const rects = cardRects(col);
  let index = rects.length;
  for (let i = 0; i < rects.length; i++) {
    const c = rects[i]!;
    if (d.y < c.top + (c.bottom - c.top) / 2) {
      index = i;
      break;
    }
  }
  d.index = index;

  const prev = index > 0 ? rects[index - 1] : undefined;
  const next = rects[index];
  let ruleY: number;
  if (prev && next) ruleY = (prev.bottom + next.top) / 2;
  else if (prev) ruleY = prev.bottom + 3;
  else if (next) ruleY = next.top - 4;
  else ruleY = r.top + 8;
  ruleY = Math.min(Math.max(ruleY, r.top + 2), r.bottom - 4);

  d.rule.style.opacity = "1";
  d.rule.style.width = `${r.width - 16}px`;
  d.rule.style.transform = `translate3d(${r.left + 8}px, ${ruleY}px, 0)`;
}

function onDragKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") cancelDrag();
}

// --- end -------------------------------------------------------------------

function teardown(): void {
  const d = drag;
  if (!d) return;
  if (d.frame !== null) cancelAnimationFrame(d.frame);
  d.ghost.remove();
  d.rule.remove();
  d.source.classList.remove("drag-source");
  document.body.classList.remove("is-dragging");
  document.body.style.touchAction = prevTouchAction;
  window.removeEventListener("contextmenu", suppressContextMenu);
  if (d.overStatusId) columns.get(d.overStatusId)?.el.parentElement?.classList.remove("is-over");
  drag = null;
  lastDragEnd = Date.now();
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragUp);
  window.removeEventListener("pointercancel", cancelDrag);
  window.removeEventListener("keydown", onDragKey);
}

function cancelDrag(): void {
  teardown();
}

function onDragUp(): void {
  const d = drag;
  if (!d) return;
  const statusId = d.overStatusId;
  const col = statusId ? columns.get(statusId) : null;
  const index = d.index;
  const taskId = d.taskId;
  teardown();
  if (!col || !statusId) return;

  const status = statusById.value.get(statusId);
  if (!status) return;

  // Neighbours come from the store, not the DOM, so the fractional key is
  // computed against authoritative positions.
  const column = tasksByListAndStatus(col.listId).peek().get(statusId) ?? [];
  const others = column.filter((t) => t.id !== taskId);
  const clamped = Math.min(Math.max(index, 0), others.length);
  const before = others[clamped - 1];
  const after = others[clamped];

  // Removing the card first means "insert at its own index" is the no-op.
  const origIndex = column.findIndex((t) => t.id === taskId);
  if (origIndex !== -1 && col.listId === d.fromListId && origIndex === clamped) return;

  const position = between(before?.position, after?.position);
  void moveTask({
    taskId,
    listId: col.listId,
    status: status.name,
    ...(position === null ? {} : { position }),
  });
}
