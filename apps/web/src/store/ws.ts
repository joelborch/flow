// WebSocket transport. One socket, hello/snapshot/deltas, exponential-backoff
// reconnect. The board never refetches: a gap the server cannot replay comes
// back as `resync`, which we answer by reconnecting from seq null.
//
// The first socket of a page load is usually not opened here at all — the inline
// script in index.html opens it and sends `hello` while the bundle is still
// downloading, and we adopt it below.
import type { ClientMsg, ServerMsg } from "@flow/shared";
import { api } from "../lib/api.js";
import { reconcileBootUser, writeCachedMe } from "../lib/boot-cache.js";
import { devSnapshot, devTaskCount } from "../lib/dev-snapshot.js";
import { earlySocket, releaseEarlySocket, type EarlyWS } from "../lib/early-ws.js";
import { toast } from "../lib/toast.js";
import { applyDeltas, hydrate, invalidateBootCache, scheduleBootCacheFlush } from "./apply.js";
import { connected, hydrated, lastSeq, me, setSeq, users } from "./state.js";

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 20_000;

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let stopped = false;
let settle: (() => void) | null = null;
let connecting: Promise<void> | null = null;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function send(msg: ClientMsg): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function clearTimers(): void {
  if (pingTimer !== null) clearInterval(pingTimer);
  if (retryTimer !== null) clearTimeout(retryTimer);
  pingTimer = null;
  retryTimer = null;
}

function done(): void {
  if (settle) {
    settle();
    settle = null;
  }
}

/** DEV convenience: a workable board when no Worker is running. */
function devFallback(): void {
  if (!import.meta.env.DEV || hydrated.value) return;
  hydrate(devSnapshot(devTaskCount()));
  if (!me.value) me.value = users.value[0] ?? null;
  toast("Offline — showing sample data", "info", 4000);
}

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = Math.min(MAX_BACKOFF_MS, 400 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
  attempt++;
  retryTimer = setTimeout(open, delay);
}

function handle(msg: ServerMsg): void {
  switch (msg.type) {
    case "snapshot":
      hydrate(msg.snapshot);
      return;
    case "deltas":
      // A replay only makes sense on top of entities we hold. If the boot cache
      // was rejected after the early script already asked for one, drop it and
      // wait for the snapshot the corrective hello asked for.
      if (hydrated.value) applyDeltas(msg.deltas);
      return;
    case "resync":
      setSeq(null);
      hydrated.value = false;
      // The stored board is exactly the state the server just refused to replay
      // from, so it must not seed the next load either.
      invalidateBootCache();
      socket?.close();
      return;
    case "pong":
      return;
  }
}

function onMessageData(data: unknown): void {
  if (typeof data !== "string") return;
  try {
    handle(JSON.parse(data) as ServerMsg);
  } catch {
    /* ignore malformed frames rather than tearing down the socket */
  }
}

/** Shared once a socket — ours or the early one — reaches OPEN. */
function onOpen(helloAlreadySent: boolean): void {
  attempt = 0;
  connected.value = true;
  // Only replay from a seq we still hold entities for; a page that could not
  // restore its cache has an empty index and must ask for a full snapshot.
  //
  // The early script sends its own optimistic hello from the cached seq. When
  // that guess turns out wrong — a bumped schema stamp, a corrupt record — we
  // are not hydrated here, and one corrective hello asks for the snapshot the
  // server would otherwise not have sent.
  if (!helloAlreadySent || !hydrated.value) {
    send({ type: "hello", sinceSeq: hydrated.value ? lastSeq.value : null });
  }
  pingTimer = setInterval(() => send({ type: "ping" }), PING_MS);
  done();
}

function onClose(): void {
  connected.value = false;
  if (pingTimer !== null) clearInterval(pingTimer);
  pingTimer = null;
  socket = null;
  devFallback();
  done();
  scheduleReconnect();
}

/**
 * Take over the socket index.html opened, if it is still usable. Its buffered
 * frames are replayed through the normal handler, in order, so nothing that
 * arrived before the bundle parsed is lost.
 */
function adopt(early: EarlyWS): boolean {
  const ws = early.socket;
  socket = ws;
  // One handoff only. Consuming it here means a later `open()` — a reconnect,
  // or the visibility handler firing while this socket is still CONNECTING —
  // builds a socket of its own instead of adopting this one a second time.
  releaseEarlySocket();

  // Buffered frames first, then take over the pipe. Both steps run in one
  // synchronous block, so no frame can slip past in between.
  const take = (): void => {
    for (const frame of early.frames.splice(0, early.frames.length)) onMessageData(frame);
    early.onframe = onMessageData;
  };

  ws.addEventListener("close", onClose);
  ws.addEventListener("error", () => {
    /* `close` always follows */
  });

  if (ws.readyState === WebSocket.OPEN) {
    onOpen(early.helloSent);
    take();
  } else {
    ws.addEventListener("open", () => {
      onOpen(early.helloSent);
      take();
    });
  }
  return true;
}

function open(): void {
  if (stopped) return;

  const early = earlySocket();
  if (early && adopt(early)) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    devFallback();
    done();
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => onOpen(false));
  ws.addEventListener("message", (ev) => onMessageData(ev.data));
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", () => {
    // `close` always follows; nothing to do but keep the console quiet.
  });
}

/**
 * Open the live connection. Resolves on the first outcome (connected, or failed
 * and fell back) so the caller can render immediately either way.
 */
export function connect(): Promise<void> {
  if (connecting) return connecting;
  stopped = false;
  connecting = new Promise<void>((resolve) => {
    settle = resolve;
    open();
  });
  void api
    .me()
    .then((user) => {
      // A cached board belongs to whoever was signed in when it was written.
      // If that is no longer this person, reconcileBootUser wipes and reloads.
      if (reconcileBootUser(user)) return;
      me.value = user;
      writeCachedMe(user);
      // The identity is what the boot cache is keyed on, so a board hydrated
      // before /api/me answered can only be persisted now.
      scheduleBootCacheFlush();
    })
    .catch(() => {
      if (import.meta.env.DEV && !me.value) me.value = users.value[0] ?? null;
    });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !connected.value && !stopped) {
        attempt = 0;
        clearTimers();
        open();
      }
    });
  }
  return connecting;
}

export function disconnect(): void {
  stopped = true;
  clearTimers();
  socket?.close();
  socket = null;
  connected.value = false;
  connecting = null;
}
