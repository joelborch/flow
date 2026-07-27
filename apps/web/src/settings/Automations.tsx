// Automations tab: what exists, what it does, what it
// has been doing, and the one control worth exposing — the enable switch.
//
// There is deliberately no authoring UI. Rules are a nested discriminated union
// that agents and the API create; a form for them would be a worse editor than
// `flow_upsert_automation` and a permanent maintenance cost. What a human needs
// here is to see the inventory, read a rule in plain English, check the run log,
// and turn one off in a hurry.
import type { AutomationRule, AutomationRunLog } from "@flow/shared";
import { useState } from "preact/hooks";
import { settingsApi } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { cn, relativeTime } from "../shell/format.js";
import { openTask } from "../shell/nav.js";
import {
  automationRules, listById, spaceById, tasks, userById,
} from "../store/index.js";
import { closeSettings } from "./route.js";
import {
  actionChip, actionKindLabel, actionSummary, conditionSummary, scopeSummary,
  triggerSummary, type Names,
} from "./summary.js";
import {
  Button, ChevronDown, ChevronRight, Confirm, Empty, ErrorNote, Loading, Panel,
  Switch, Tag, useAsync, errorMessage,
} from "./ui.js";

/** Display names pulled from the store's computed lookup maps. Called during
 *  render so the signal reads register as dependencies. */
function useNames(): Names {
  const users = userById.value;
  const lists = listById.value;
  const spaces = spaceById.value;
  return {
    user: (id) => (id ? (users.get(id)?.name ?? id) : "nobody"),
    list: (id) => lists.get(id)?.name ?? id,
    space: (id) => spaces.get(id)?.name ?? id,
  };
}

/** A run row names a task; clicking it should land on the board with the panel
 *  open, so settings closes first and the deep link is written after. The log
 *  outlives the things it mentions, so a task that has since been deleted reads
 *  as deleted rather than as an opaque id wearing a link's clothes. */
function TaskLink({ taskId }: { taskId: string }) {
  const task = tasks.value.get(taskId);
  if (!task) {
    return (
      <span class="min-w-0 truncate text-[12.5px] text-faint italic" title={taskId}>
        deleted task
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        closeSettings();
        openTask(taskId);
      }}
      class="min-w-0 truncate text-left text-[12.5px] text-accent underline-offset-2 hover:underline"
    >
      {task.title}
    </button>
  );
}

/** One action outcome. A dry run is the only place a suppressed email shows up
 *  at all, so it gets its own amber chip rather than reading as a success. */
function ResultChip({ result }: { result: AutomationRunLog["results"][number] }) {
  const label = actionKindLabel(result.action);
  if (result.dryRun) {
    return (
      <Tag tone="warn" title={result.detail ?? undefined}>
        {label} · dry run
      </Tag>
    );
  }
  return (
    <Tag tone={result.ok ? "ok" : "danger"} title={result.detail ?? undefined}>
      {result.ok ? label : `${label} · failed`}
    </Tag>
  );
}

function RunRow({ run, ruleName }: { run: AutomationRunLog; ruleName?: string }) {
  return (
    <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-4 py-2 text-[12.5px]">
      <span class="w-[74px] shrink-0 text-[11.5px] tabular-nums text-faint">
        {relativeTime(run.at)}
      </span>
      {ruleName ? (
        <span class="shrink-0 font-medium text-text">{ruleName}</span>
      ) : (
        <span class="shrink-0 text-faint italic" title={run.ruleId}>
          deleted rule
        </span>
      )}
      <TaskLink taskId={run.taskId} />
      <span class="shrink-0 text-[11.5px] text-faint">{actionKindLabel(run.trigger)}</span>
      {run.depth > 0 && <Tag title="Fired by another automation">depth {run.depth}</Tag>}
      <span class="flex flex-wrap items-center gap-1">
        {run.results.map((r, i) => (
          <ResultChip key={i} result={r} />
        ))}
      </span>
    </div>
  );
}

/** Newest firings across every rule — the "are the automations behaving?" view. */
function RecentActivity() {
  const { status, data, error, reload } = useAsync(() => settingsApi.automationRuns(20), []);
  const byId = new Map(automationRules.value.map((r) => [r.id, r.name]));

  return (
    <Panel
      title="Recent activity"
      description="The last 20 firings across every rule. A failed action never fails the mutation that triggered it, so this log is the only place it shows up."
      right={
        <Button size="xs" onClick={reload}>
          Refresh
        </Button>
      }
    >
      {status === "loading" && <Loading />}
      {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
      {status === "ok" && data && data.runs.length === 0 && <Empty>No automation has fired yet.</Empty>}
      {status === "ok" && data && data.runs.length > 0 && (
        <div class="divide-y divide-line">
          {data.runs.map((run) => (
            <RunRow key={run.id} run={run} ruleName={byId.get(run.ruleId)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

/** The expanded body of one rule: the readable breakdown plus its last 10 runs. */
function RuleDetail({ rule, names }: { rule: AutomationRule; names: Names }) {
  const { status, data, error, reload } = useAsync(() => settingsApi.ruleRuns(rule.id, 10), [rule.id]);

  return (
    <div class="border-t border-line bg-raised/60 px-4 py-3">
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h4 class="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
            When
          </h4>
          <p class="text-[12.5px] text-text">{triggerSummary(rule.trigger, names)}</p>

          <h4 class="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
            And all of
          </h4>
          {rule.conditions.length === 0 ? (
            <p class="text-[12.5px] text-faint">No conditions — every trigger match runs it.</p>
          ) : (
            <ul class="space-y-0.5">
              {rule.conditions.map((c, i) => (
                <li key={i} class="text-[12.5px] text-text">
                  {conditionSummary(c, names)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 class="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
            Then, in order
          </h4>
          <ol class="space-y-1">
            {rule.actions.map((a, i) => (
              <li key={i} class="flex gap-2 text-[12.5px] text-text">
                <span class="w-3 shrink-0 text-right tabular-nums text-faint">{i + 1}</span>
                <span class="min-w-0">{actionSummary(a, names)}</span>
              </li>
            ))}
          </ol>
          <p class="mt-3 text-[11.5px] text-faint">
            Scope: {scopeSummary(rule, names)} · Rule {rule.id} · updated{" "}
            {relativeTime(rule.updatedAt)}
          </p>
        </div>
      </div>

      <h4 class="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
        Last 10 runs
      </h4>
      <div class="-mx-4 border-t border-line">
        {status === "loading" && <Loading />}
        {status === "error" && error && <ErrorNote message={error} onRetry={reload} />}
        {status === "ok" && data && data.runs.length === 0 && (
          <Empty>This rule has never fired.</Empty>
        )}
        {status === "ok" && data && data.runs.length > 0 && (
          <div class="divide-y divide-line">
            {data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  names,
  expanded,
  onToggleExpand,
}: {
  rule: AutomationRule;
  names: Names;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // Optimistic: the switch answers immediately, and the DO's own delta (or a
  // rollback on failure) is what finally settles the value.
  async function apply(enabled: boolean): Promise<void> {
    setConfirming(false);
    setBusy(true);
    const before = automationRules.value;
    automationRules.value = before.map((r) => (r.id === rule.id ? { ...r, enabled } : r));
    try {
      const saved = await settingsApi.setAutomationEnabled(rule, enabled);
      automationRules.value = automationRules.value.map((r) => (r.id === saved.id ? saved : r));
    } catch (err) {
      automationRules.value = before;
      toast(`Could not ${enabled ? "enable" : "disable"} "${rule.name}": ${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div class={cn("border-b border-line last:border-b-0", expanded && "bg-raised/40")}>
      <div class="flex items-start gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${rule.name}` : `Expand ${rule.name}`}
          class="mt-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-bg hover:text-text"
        >
          <Chevron class="h-3.5 w-3.5" />
        </button>

        <div class="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggleExpand}
            class="block max-w-full truncate text-left text-[13px] font-medium text-text"
          >
            {rule.name}
          </button>
          <p class="mt-0.5 truncate text-[12px] text-muted">
            {triggerSummary(rule.trigger, names)}
            {rule.conditions.length > 0 && (
              <span class="text-faint"> · {rule.conditions.length} condition
                {rule.conditions.length === 1 ? "" : "s"}</span>
            )}
          </p>
          <div class="mt-1.5 flex flex-wrap items-center gap-1">
            {rule.actions.map((a, i) => (
              <Tag key={i} tone="accent">
                {actionChip(a, names)}
              </Tag>
            ))}
          </div>
        </div>

        <span class="hidden w-[160px] shrink-0 truncate text-[12px] text-muted sm:block">
          {scopeSummary(rule, names)}
        </span>

        <span class="flex shrink-0 items-center gap-2">
          <span class={rule.enabled ? "text-[11.5px] text-ok" : "text-[11.5px] text-faint"}>
            {rule.enabled ? "On" : "Off"}
          </span>
          <Switch
            checked={rule.enabled}
            busy={busy}
            label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
            onChange={(next) => {
              // Turning a rule off is safe and immediate. Turning one on points
              // it at live tasks, so it asks first.
              if (next) setConfirming(true);
              else void apply(false);
            }}
          />
        </span>
      </div>

      {confirming && (
        <div class="px-4 pb-2.5">
          <Confirm
            message={`Enable "${rule.name}"? This rule will act on real tasks.`}
            confirmLabel="Enable"
            onConfirm={() => void apply(true)}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}

      {expanded && <RuleDetail rule={rule} names={names} />}
    </div>
  );
}

export function AutomationsTab() {
  const names = useNames();
  const rules = automationRules.value;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div class="space-y-4">
      <RecentActivity />

      <Panel
        title={`Rules (${rules.length})`}
        description="Rules are created and edited by agents and the API. Here you can read them and switch them on or off."
      >
        {rules.length === 0 ? (
          <Empty>No automation rules yet.</Empty>
        ) : (
          rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              names={names}
              expanded={expanded === rule.id}
              onToggleExpand={() => setExpanded(expanded === rule.id ? null : rule.id)}
            />
          ))
        )}
      </Panel>
    </div>
  );
}
