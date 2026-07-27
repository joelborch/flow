// The handoff from the inline <head> script in index.html.
//
// That script opens the WebSocket and sends `hello` before this bundle has been
// fetched, which takes the connection setup (DNS, TLS, the upgrade round trip)
// and the server's snapshot build off the critical path entirely. It parks the
// socket, everything it has received, and whether it managed to send hello, on
// `window.__flowWS`; store/ws.ts adopts that instead of opening a second one.
//
// KEEP THIS SHAPE IN STEP WITH THE INLINE SCRIPT IN index.html.

export type EarlyWS = {
  socket: WebSocket;
  /** Frames received before a consumer was attached, oldest first. */
  frames: string[];
  /** True once the early `hello` went out, so ws.ts knows not to repeat it. */
  helloSent: boolean;
  /** Set by ws.ts on adopt; from then on frames go straight through. */
  onframe: ((data: string) => void) | null;
};

/** The early socket, if the inline script ran and its socket is still usable. */
export function earlySocket(): EarlyWS | null {
  const w = (globalThis as { __flowWS?: EarlyWS }).__flowWS;
  if (!w || !w.socket) return null;
  const state = w.socket.readyState;
  if (state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) return null;
  return w;
}

/** Forget the handoff, so a reconnect opens a fresh socket the normal way. */
export function releaseEarlySocket(): void {
  delete (globalThis as { __flowWS?: EarlyWS }).__flowWS;
}
