import {
  type AgentProfile,
  AgentProfileInput,
  type PolicyAction,
  type PolicyPreset,
  type PolicyRule,
  PRESET_DESCRIPTIONS,
  type ToolKind,
  type WorkspaceMode,
} from "@quantaflow/core";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, cx, KIND_LABEL } from "../../components/ui";
import { WORKSPACE_TEXT } from "../../jobs/NewJobDialog";
import { api } from "../../lib/backend";
import { errorMessage } from "../../lib/errors";
import { useQf } from "../../store/store";

const PRESETS: { id: PolicyPreset; label: string }[] = [
  { id: "readonly", label: "Read only" },
  { id: "safe", label: "Ask first" },
  { id: "trusted", label: "Trusted" },
];

const KINDS = Object.keys(KIND_LABEL) as ToolKind[];

const field =
  "w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-line-strong";

interface Draft {
  id: string;
  name: string;
  description: string;
  harness: string;
  model: string;
  instructions: string;
  workspace: WorkspaceMode;
  preset: PolicyPreset;
  rules: PolicyRule[];
  maxMinutes: string;
}

function toDraft(agent: AgentProfile | null, defaultHarness: string): Draft {
  return {
    id: agent?.id ?? "",
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    harness: agent?.harness ?? defaultHarness,
    model: agent?.model ?? "",
    instructions: agent?.instructions ?? "",
    workspace: agent?.workspace ?? "worktree",
    preset: agent?.policy.preset ?? "safe",
    rules: agent?.policy.rules ?? [],
    maxMinutes: agent?.limits.maxMinutes ? String(agent.limits.maxMinutes) : "",
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function AgentForm({
  open,
  agent,
  onClose,
}: {
  open: boolean;
  /** The agent to edit, or null to create one. */
  agent: AgentProfile | null;
  onClose: () => void;
}) {
  const harnesses = useQf((s) => s.harnesses);
  const ids = useId();
  const defaultHarness =
    harnesses.find((h) => h.found && h.id !== "fake")?.id ?? harnesses[0]?.id ?? "fake";
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent, defaultHarness));
  const [idTouched, setIdTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(toDraft(agent, defaultHarness));
    setIdTouched(Boolean(agent));
    setErrors({});
    setFailure(null);
  }, [open, agent, defaultHarness]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const harness = harnesses.find((h) => h.id === draft.harness);

  async function save() {
    const minutes = Number.parseInt(draft.maxMinutes, 10);
    const input: AgentProfileInput = {
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      harness: draft.harness,
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      instructions: draft.instructions,
      workspace: draft.workspace,
      policy: { preset: draft.preset, rules: draft.rules },
      mcpServers: agent?.mcpServers ?? [],
      limits: Number.isFinite(minutes) && minutes > 0 ? { maxMinutes: minutes } : {},
    };
    const parsed = AgentProfileInput.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(null);
    try {
      if (agent) await api().updateAgent(agent.id, input);
      else await api().createAgent(input);
      onClose();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const error = (key: string) =>
    errors[key] ? (
      <p className="text-xs text-stop" role="alert">
        {errors[key]}
      </p>
    ) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "New agent"}
      description="An agent is a reusable worker: which harness runs it, how it should behave, and what it may do without asking."
      className="w-[min(680px,calc(100vw-32px))]"
    >
      <form
        className="space-y-5 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-name`} className="text-sm font-medium">
              Name
            </label>
            <input
              id={`${ids}-name`}
              value={draft.name}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((d) => ({ ...d, name, id: idTouched ? d.id : slugify(name) }));
              }}
              placeholder="Reviewer"
              className={field}
              required
            />
            {error("name")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-id`} className="text-sm font-medium">
              ID
            </label>
            <input
              id={`${ids}-id`}
              value={draft.id}
              onChange={(event) => {
                setIdTouched(true);
                set("id", event.target.value);
              }}
              disabled={Boolean(agent)}
              placeholder="reviewer"
              className={cx(field, "font-mono")}
              required
            />
            {error("id") ?? (
              <p className="text-xs text-ink-faint">
                {agent
                  ? "IDs can't change once jobs use them."
                  : "Used on the command line, like qf run reviewer."}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${ids}-desc`} className="text-sm font-medium">
            Description <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <input
            id={`${ids}-desc`}
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder="Reads diffs and leaves review notes. Never edits."
            className={field}
          />
          {error("description")}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-harness`} className="text-sm font-medium">
              Harness
            </label>
            <select
              id={`${ids}-harness`}
              value={draft.harness}
              onChange={(event) => set("harness", event.target.value)}
              className={field}
            >
              {harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                  {h.found ? "" : " (not installed)"}
                </option>
              ))}
            </select>
            {harness && !harness.found && <p className="text-xs text-stop">{harness.install}</p>}
            {error("harness")}
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-model`} className="text-sm font-medium">
              Model <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <input
              id={`${ids}-model`}
              value={draft.model}
              onChange={(event) => set("model", event.target.value)}
              placeholder="Harness default"
              className={cx(field, "font-mono")}
            />
            {error("model")}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={`${ids}-instructions`} className="text-sm font-medium">
            Role instructions
          </label>
          <textarea
            id={`${ids}-instructions`}
            value={draft.instructions}
            onChange={(event) => set("instructions", event.target.value)}
            rows={4}
            placeholder="You review code for correctness and security. Point to exact lines. Don't edit files."
            className={cx(field, "resize-y leading-relaxed")}
          />
          <p className="text-xs text-ink-faint">Placed before every job prompt this agent gets.</p>
          {error("instructions")}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Workspace</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(WORKSPACE_TEXT) as WorkspaceMode[]).map((mode) => (
              <label
                key={mode}
                className={cx(
                  "cursor-pointer rounded-md border px-3 py-2 text-sm",
                  draft.workspace === mode
                    ? "border-ink bg-raised"
                    : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-ws`}
                  value={mode}
                  checked={draft.workspace === mode}
                  onChange={() => set("workspace", mode)}
                  className="sr-only"
                />
                <span className="font-medium">{WORKSPACE_TEXT[mode].label}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {WORKSPACE_TEXT[mode].help}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Permissions</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRESETS.map((preset) => (
              <label
                key={preset.id}
                className={cx(
                  "cursor-pointer rounded-md border px-3 py-2 text-sm",
                  draft.preset === preset.id
                    ? "border-ink bg-raised"
                    : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-preset`}
                  value={preset.id}
                  checked={draft.preset === preset.id}
                  onChange={() => set("preset", preset.id)}
                  className="sr-only"
                />
                <span className="font-medium">{preset.label}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {PRESET_DESCRIPTIONS[preset.id]}
                </span>
              </label>
            ))}
          </div>
          <RulesEditor rules={draft.rules} onChange={(rules) => set("rules", rules)} />
          {error("policy")}
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor={`${ids}-minutes`} className="text-sm font-medium">
            Time limit <span className="font-normal text-ink-faint">(minutes, optional)</span>
          </label>
          <input
            id={`${ids}-minutes`}
            type="number"
            min={1}
            max={1440}
            value={draft.maxMinutes}
            onChange={(event) => set("maxMinutes", event.target.value)}
            placeholder="No limit"
            className={cx(field, "w-36")}
          />
          {error("limits")}
        </div>

        {agent && agent.mcpServers.length > 0 && (
          <p className="text-xs text-ink-muted">
            MCP servers ({agent.mcpServers.map((s) => s.name).join(", ")}) are kept as they are.
            Edit them in the agent's YAML file.
          </p>
        )}

        {failure && (
          <p className="text-sm text-stop" role="alert">
            {failure}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const ACTIONS: { id: PolicyAction; label: string }[] = [
  { id: "allow", label: "Allow" },
  { id: "ask", label: "Ask" },
  { id: "deny", label: "Deny" },
];

function RulesEditor({
  rules,
  onChange,
}: {
  rules: PolicyRule[];
  onChange: (rules: PolicyRule[]) => void;
}) {
  const update = (index: number, patch: Partial<PolicyRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Extra rules are checked first, top to bottom. Built-in safety rules, like blocking force
          pushes, always apply.
        </p>
        <Button size="sm" variant="ghost" onClick={() => onChange([...rules, { action: "ask" }])}>
          <Plus className="size-3.5" aria-hidden />
          Add rule
        </Button>
      </div>
      {rules.map((rule, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional; their inputs are fully controlled
          key={`${index}-${rule.action}`}
          className="grid grid-cols-[88px_120px_1fr_auto] items-center gap-2"
        >
          <select
            aria-label="Action"
            value={rule.action}
            onChange={(event) => update(index, { action: event.target.value as PolicyAction })}
            className="h-8 rounded-md border border-line bg-canvas px-2 text-xs"
          >
            {ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Applies to"
            value={rule.kinds?.[0] ?? ""}
            onChange={(event) => {
              const kind = event.target.value as ToolKind | "";
              const { kinds: _drop, ...rest } = rule;
              onChange(
                rules.map((r, i) => (i === index ? (kind ? { ...rest, kinds: [kind] } : rest) : r)),
              );
            }}
            className="h-8 rounded-md border border-line bg-canvas px-2 text-xs"
          >
            <option value="">Any tool</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <input
            aria-label="Pattern"
            value={rule.pattern ?? ""}
            onChange={(event) => {
              const pattern = event.target.value;
              const { pattern: _drop, ...rest } = rule;
              onChange(
                rules.map((r, i) => (i === index ? (pattern ? { ...rest, pattern } : rest) : r)),
              );
            }}
            placeholder="Matching text, as a regular expression"
            className="h-8 min-w-0 rounded-md border border-line bg-canvas px-2 font-mono text-xs placeholder:font-sans placeholder:text-ink-faint"
          />
          <button
            type="button"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
            className="rounded-md p-1.5 text-ink-muted hover:bg-raised hover:text-stop"
            aria-label="Remove rule"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
