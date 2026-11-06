import { type AgentProfile, PRESET_DESCRIPTIONS } from "@quantaflow/core";
import { FileCode2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Code, Empty, inlineCode, Lamp } from "../../components/ui";
import { WORKSPACE_TEXT } from "../../jobs/NewJobDialog";
import { api } from "../../lib/backend";
import { errorMessage } from "../../lib/errors";
import { harnessLabel, useHarnessMap } from "../../lib/hooks";
import { isLive } from "../../lib/states";
import { useQf } from "../../store/store";
import { useChrome } from "../../store/ui";
import { AgentForm } from "./AgentForm";

const PRESET_LABEL = { readonly: "Read only", safe: "Ask first", trusted: "Trusted" } as const;

function DeleteButton({ agent }: { agent: AgentProfile }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${agent.name}`}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {error && <span className="text-xs text-stop">{error}</span>}
      <Button
        size="sm"
        variant="danger"
        onClick={async () => {
          try {
            await api().deleteAgent(agent.id);
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        Delete {agent.name}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

export function AgentsView() {
  const agents = useQf((s) => s.agents);
  const jobs = useQf((s) => s.jobs);
  const harnessList = useQf((s) => s.harnesses);
  const harnesses = useHarnessMap();
  const openNewJob = useChrome((s) => s.openNewJob);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const running = useMemo(() => {
    const counts = new Map<string, number>();
    for (const view of Object.values(jobs)) {
      if (isLive(view.job.status))
        counts.set(view.job.agentId, (counts.get(view.job.agentId) ?? 0) + 1);
    }
    return counts;
  }, [jobs]);

  const edit = (agent: AgentProfile | null) => {
    setEditing(agent);
    setFormOpen(true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              Each agent pairs a harness with a role and a permission policy. Agents from{" "}
              <Code>.quantaflow/agents/*.yaml</Code> are read-only here; edit the file and they
              reload.
            </p>
          </div>
          <Button variant="primary" onClick={() => edit(null)}>
            <Plus className="size-4" aria-hidden />
            New agent
          </Button>
        </div>

        {agents.length === 0 ? (
          <Empty
            title="No agents yet"
            className="mt-6 rounded-md border border-dashed border-line px-5"
          >
            Create one here, or add a YAML file under <Code>.quantaflow/agents/</Code>. The demo
            harness needs no installs or keys, which makes it a good first agent.
          </Empty>
        ) : (
          <ul className="mt-6 divide-y divide-line border-y border-line">
            {agents.map((agent) => {
              const harness = harnesses.get(agent.harness);
              const live = running.get(agent.id) ?? 0;
              return (
                <li
                  key={agent.id}
                  className="grid gap-x-6 gap-y-3 py-4 md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <h2 className="font-semibold">{agent.name}</h2>
                      <span className="font-mono text-xs text-ink-faint">{agent.id}</span>
                      {agent.source === "file" && (
                        <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                          <FileCode2 className="size-3" aria-hidden />
                          from YAML
                        </span>
                      )}
                    </div>
                    {agent.description && (
                      <p className="mt-0.5 text-sm text-ink-muted">{agent.description}</p>
                    )}
                    <dl className="mt-2 grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
                      <dt className="text-ink-faint">Harness</dt>
                      <dd className="flex items-center gap-1.5">
                        <Lamp tone={harness?.found === false ? "stop" : "ok"} size={6} />
                        {harnessLabel(harnesses, agent.harness)}
                        {agent.model && (
                          <span className="font-mono text-ink-muted">{agent.model}</span>
                        )}
                      </dd>
                      <dt className="text-ink-faint">Workspace</dt>
                      <dd>{WORKSPACE_TEXT[agent.workspace].label}</dd>
                      <dt className="text-ink-faint">Permissions</dt>
                      <dd title={PRESET_DESCRIPTIONS[agent.policy.preset]}>
                        {PRESET_LABEL[agent.policy.preset]}
                        {agent.policy.rules.length > 0 &&
                          ` plus ${agent.policy.rules.length} ${agent.policy.rules.length === 1 ? "rule" : "rules"}`}
                      </dd>
                      <dt className="text-ink-faint">Limit</dt>
                      <dd>
                        {agent.limits.maxMinutes
                          ? `${agent.limits.maxMinutes} min per job`
                          : "None"}
                      </dd>
                      <dt className="text-ink-faint">Jobs</dt>
                      <dd className="tabular">
                        {live > 0 ? `${live} running now` : "None running"}
                      </dd>
                    </dl>
                    {harness?.found === false && (
                      <p className="mt-2 text-xs text-stop">
                        Not installed. {inlineCode(harness.install)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-start gap-1.5 md:justify-end">
                    <Button size="sm" onClick={() => openNewJob(agent.id)}>
                      <Play className="size-3.5" aria-hidden />
                      Start job
                    </Button>
                    {agent.source === "db" && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => edit(agent)}
                          aria-label={`Edit ${agent.name}`}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <DeleteButton agent={agent} />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <section className="mt-10" aria-labelledby="harness-heading">
          <h2 id="harness-heading" className="text-base font-semibold">
            Harnesses on this machine
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            QuantaFlow drives each CLI with its own login. It never sees or stores your credentials.
          </p>
          <ul className="mt-3 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
            {harnessList.map((harness) => (
              <li key={harness.id} className="bg-surface px-4 py-3 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <Lamp tone={harness.found ? "ok" : "stop"} size={7} />
                  {harness.label}
                  <span className="font-mono text-xs font-normal text-ink-faint">{harness.id}</span>
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {inlineCode(
                    harness.found ? (harness.notes ?? "Found on PATH.") : harness.install,
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <AgentForm open={formOpen} agent={editing} onClose={() => setFormOpen(false)} />
    </div>
  );
}
