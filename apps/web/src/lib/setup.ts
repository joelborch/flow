// A fresh deploy has no sign-in configured yet, so every API call is a 401.
// The usual answer to a 401 is a trip through Cloudflare Access's login, which
// doesn't exist on a hostname without Access, so the visitor would land on an
// error page. Before taking that trip, api.ts asks the public /api/setup once;
// "unconfigured" raises `setupNeeded` and main.tsx shows the setup steps.
import { signal } from "@preact/signals";

export const setupNeeded = signal(false);

let check: Promise<boolean> | null = null;

/** True when the server says sign-in isn't configured. Asked once per page load. */
export function signInUnconfigured(): Promise<boolean> {
  check ??= fetch("/api/setup", { credentials: "same-origin" })
    .then((res) => (res.ok ? (res.json() as Promise<{ signIn?: string }>) : null))
    .then((body) => body?.signIn === "unconfigured")
    .catch(() => false);
  return check;
}

/** Test hook. */
export function resetSetupCheck(): void {
  check = null;
  setupNeeded.value = false;
}
