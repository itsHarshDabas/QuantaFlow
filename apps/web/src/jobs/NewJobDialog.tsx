import type { WorkspaceMode } from "@quantaflow/core";
import { useEffect, useId, useMemo, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button, Code } from "../components/ui";
import { api } from "../lib/backend";
import { errorMessage } from "../lib/errors";
import { harnessLabel, useHarnessMap } from "../lib/hooks";
import { navigate, openJob } from "../lib/router";
import { useQf } from "../store/store";
import { useChrome } from "../store/ui";

export const WORKSPACE_TEXT: Record<WorkspaceMode, { label: string; help: string }> = {
  worktree: {
    label: "Own git worktree",
    help: "A separate checkout and branch, so parallel jobs never touch each other's files.",
  },
  folder: { label: "Own empty folder", help: "A fresh folder, for research, writing or ops work." },
  cwd: { label: "Project root", help: "Works directly in the project, with no isolation." },
};

const field =
  "w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-line-strong";

export function NewJobDialog() {
  const { open, agentId: preset } = useChrome((s) => s.newJob);
  const close = useChrome((s) => s.closeNewJob);
  const agents = useQf((s) => s.agents);
  const harnesses = useHarnessMap();
  const ids = useId();

  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceMode | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAgentId(
      (current) =>
        preset ?? (agents.some((a) => a.id === current) ? current : (agents[0]?.id ?? "")),
    );
    setWorkspace("");
    setError(null);
  }, [open, preset, agents]);

  const agent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);
  const harness = agent ? harnesses.get(agent.harness) : undefined;

  async function submit() {
    if (!agent || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await api().createJob({
        agentId: agent.id,
        prompt: prompt.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(workspace ? { workspace } : {}),
      });
      setPrompt("");
      setTitle("");
      close();
      openJob(job.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New job"
      description="Give one agent one piece of work."
    >
      {agents.length === 0 ? (
        <div className="space-y-3 px-5 py-4 text-sm">
          <p>A job needs an agent to run it, and there are none yet.</p>
          <Button
            variant="primary"
            onClick={() => {
              close();
              navigate({ view: "agents", job: null });
            }}
          >
            Create an agent
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-agent`} className="text-sm font-medium">
              Agent
            </label>
            <select
              id={`${ids}-agent`}
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className={field}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({harnessLabel(harnesses, a.harness)})
                </option>
              ))}
            </select>
            {agent?.description && <p className="text-xs text-ink-muted">{agent.description}</p>}
            {harness && !harness.found && (
              <p className="text-xs text-stop">
                {harness.label} isn't installed on this machine, so this job will fail to start.{" "}
                {harness.install}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={`${ids}-prompt`} className="text-sm font-medium">
              What should it do?
            </label>
            <textarea
              id={`${ids}-prompt`}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={6}
              required
              placeholder="Add rate limiting to POST /login: 5 attempts a minute per IP, with tests."
              className={`${field} resize-y leading-relaxed`}
            />
            <p className="text-xs text-ink-faint">
              Say what done looks like. The agent's role instructions are added before this.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-title`} className="text-sm font-medium">
                Title <span className="font-normal text-ink-faint">(optional)</span>
              </label>
              <input
                id={`${ids}-title`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Uses the first line if empty"
                className={field}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-ws`} className="text-sm font-medium">
                Workspace
              </label>
              <select
                id={`${ids}-ws`}
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value as WorkspaceMode | "")}
                className={field}
              >
                <option value="">
                  Agent default
                  {agent ? ` (${WORKSPACE_TEXT[agent.workspace].label.toLowerCase()})` : ""}
                </option>
                {(Object.keys(WORKSPACE_TEXT) as WorkspaceMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {WORKSPACE_TEXT[mode].label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-ink-muted">
            {WORKSPACE_TEXT[workspace || agent?.workspace || "worktree"].help}
          </p>

          {error && (
            <p className="text-sm text-stop" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
            <span className="mr-auto hidden text-xs text-ink-faint sm:inline">
              <Code>Ctrl</Code> + <Code>Enter</Code> to start
            </span>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!agent || !prompt.trim() || busy}>
              {busy ? "Starting…" : "Start job"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
