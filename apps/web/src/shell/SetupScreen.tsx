// Shown instead of the app when the server reports sign-in isn't configured
// (see lib/setup.ts): a fresh deploy, before Cloudflare Access is set up.
// It names the hostname being visited so the steps can be followed as-is.

import type { ComponentChildren } from "preact";

const GUIDE_URL = "https://github.com/joelborch/flow/blob/main/docs/SELF_HOSTING.md#5-cloudflare-access";

function Step({ n, title, children }: { n: number; title: string; children: ComponentChildren }) {
  return (
    <li class="flex gap-3">
      <span class="mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
        {n}
      </span>
      <div class="min-w-0">
        <p class="text-[14px] font-medium text-text">{title}</p>
        <div class="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

function Code({ children }: { children: ComponentChildren }) {
  return <code class="rounded bg-bg px-1 py-px font-mono text-[12px] text-text">{children}</code>;
}

export function SetupScreen() {
  const host = typeof location === "undefined" ? "your-hostname" : location.host;
  return (
    <div class="grid min-h-screen place-items-center bg-bg px-4 py-10">
      <div class="w-full max-w-[560px] rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <p class="text-[12px] font-semibold uppercase tracking-[0.08em] text-accent">Almost there</p>
        <h1 class="mt-2 text-[22px] font-semibold tracking-[-0.01em] text-text">Flow is deployed. Set up sign-in next.</h1>
        <p class="mt-2 text-[14px] leading-relaxed text-muted">
          Flow signs people in with Cloudflare Access, which is free for small teams. Until it's set up, every request
          to <Code>{host}</Code> is turned away, so this page is all you'll see.
        </p>
        <ol class="mt-6 space-y-5">
          <Step n={1} title="Create two Access applications">
            In the Zero Trust dashboard: a <strong>bypass</strong> app for <Code>{host}/api/*</Code>,{" "}
            <Code>/mcp</Code>, <Code>/mcp/*</Code>, <Code>/ws</Code> and <Code>/assets/*</Code>, and an{" "}
            <strong>allow</strong> app for <Code>{host}</Code> with your team's emails.
          </Step>
          <Step n={2} title="Tell the Worker about them">
            Set <Code>ACCESS_TEAM_DOMAIN</Code> (like <Code>your-team.cloudflareaccess.com</Code>), the allow app's{" "}
            <Code>ACCESS_AUD</Code> tag, and <Code>OWNER_EMAIL</Code> (your address) under the Worker's settings, then
            redeploy.
          </Step>
          <Step n={3} title="Reload this page">
            Access asks you to sign in, and signing in as <Code>OWNER_EMAIL</Code> makes you the workspace owner. From
            there you can invite your team and mint API keys for your agents.
          </Step>
        </ol>
        <a
          href={GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-7 inline-flex items-center rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:bg-accent/90"
        >
          Open the step-by-step guide
        </a>
      </div>
    </div>
  );
}
