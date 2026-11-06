import { Folder, FolderGit2, FolderRoot, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cx, StateTag } from "../components/ui";
import { api } from "../lib/backend";
import { errorMessage } from "../lib/errors";
import { formatDuration, shortPath } from "../lib/format";
import { harnessLabel, useAgentMap, useHarnessMap, useMinWidth, useNow } from "../lib/hooks";
import { openJob } from "../lib/router";
import { isLive } from "../lib/states";
import { openLog, useJobEvents, useQf } from "../store/store";
import { ChatTab } from "./ChatTab";
import { DiffTab } from "./DiffTab";
import { EventsTab } from "./EventsTab";
import { LogsTab } from "./LogsTab";

type Tab = "chat" | "diff" | "events" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "diff", label: "Diff" },
  { id: "events", label: "Events" },
  { id: "logs", label: "Logs" },
];

function RunTime({
  startedAt,
  endedAt,
  live,
}: {
  startedAt: number | null;
  endedAt: number | null;
  live: boolean;
}) {
  const now = useNow(1000);
  if (!startedAt) return null;
  return (
    <span className="tabular">
      {formatDuration((endedAt ?? (live ? now : startedAt)) - startedAt)}
    </span>
  );
}

export function JobDrawer({ jobId }: { jobId: string }) {
  const view = useQf((s) => s.jobs[jobId]);
  const jobs = useQf((s) => s.jobs);
  const log = useJobEvents(jobId);
  const agents = useAgentMap();
  const harnesses = useHarnessMap();
  const docked = useMinWidth(1280);
  const [tab, setTab] = useState<Tab>("chat");
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    openLog(jobId);
    setCancelError(null);
  }, [jobId]);

  const close = () => openJob(null);

  const shell = cx(
    "flex flex-col border-l border-line bg-surface",
    docked
      ? "w-[min(560px,42vw)] shrink-0"
      : "fixed inset-y-0 right-0 z-30 w-full max-w-[640px] shadow-[0_0_48px_-12px_rgb(0_0_0/0.35)]",
  );

  if (!view) {
    return (
      <aside className={shell} aria-label="Job">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-sm text-ink-muted">This job isn't in this project.</p>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1 text-ink-muted hover:bg-raised"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </aside>
    );
  }

  const { job } = view;
  const agent = agents.get(job.agentId);
  const parent = job.parentJobId ? jobs[job.parentJobId] : undefined;
  const WorkspaceIcon =
    job.workspace === "worktree" ? FolderGit2 : job.workspace === "folder" ? Folder : FolderRoot;

  async function cancel() {
    setCancelError(null);
    try {
      await api().cancelJob(job.id);
    } catch (err) {
      setCancelError(errorMessage(err));
    }
  }

  return (
    <>
      {!docked && (
        <button
          type="button"
          aria-label="Close the job"
          onClick={close}
          className="fixed inset-0 z-20 cursor-default bg-[rgb(10_16_22/0.35)]"
        />
      )}
      <aside className={shell} aria-label={`Job: ${job.title}`}>
        <header className="shrink-0 border-b border-line px-4 pt-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base leading-snug font-semibold break-words">{job.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <StateTag view={view} />
                <span>
                  {agent?.name ?? job.agentId} on {harnessLabel(harnesses, job.harness)}
                </span>
                <RunTime
                  startedAt={view.startedAt}
                  endedAt={view.endedAt}
                  live={isLive(job.status)}
                />
              </div>
            </div>
            {isLive(job.status) && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void cancel()}
                title="Stop the agent and end this job"
              >
                <Square className="size-3" aria-hidden />
                Cancel
              </Button>
            )}
            <button
              type="button"
              onClick={close}
              className="-mr-1 rounded-md p-1 text-ink-muted hover:bg-raised hover:text-ink"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-faint">Workspace</dt>
            <dd className="flex min-w-0 items-center gap-1.5 text-ink-muted">
              <WorkspaceIcon className="size-3.5 shrink-0" aria-hidden />
              {job.branch && <span className="font-mono text-ink">{job.branch}</span>}
              {job.workspacePath ? (
                <span className="truncate font-mono" title={job.workspacePath}>
                  {shortPath(job.workspacePath, 3)}
                </span>
              ) : (
                <span>Created when the job starts</span>
              )}
            </dd>
            {parent && (
              <>
                <dt className="text-ink-faint">Started by</dt>
                <dd className="min-w-0 truncate">
                  <button
                    type="button"
                    className="text-ink-muted hover:text-ink hover:underline"
                    onClick={() => openJob(parent.job.id)}
                  >
                    {parent.job.title}
                  </button>
                </dd>
              </>
            )}
            {job.dependsOn.length > 0 && (
              <>
                <dt className="text-ink-faint">Waits for</dt>
                <dd className="flex min-w-0 flex-wrap gap-x-2">
                  {job.dependsOn.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="max-w-full truncate text-ink-muted hover:text-ink hover:underline"
                      onClick={() => openJob(id)}
                    >
                      {jobs[id]?.job.title ?? id}
                    </button>
                  ))}
                </dd>
              </>
            )}
            {job.error && job.status === "failed" && (
              <>
                <dt className="text-ink-faint">Error</dt>
                <dd className="text-stop">{job.error}</dd>
              </>
            )}
          </dl>
          {cancelError && (
            <p className="mt-2 text-xs text-stop" role="alert">
              {cancelError}
            </p>
          )}

          <div role="tablist" aria-label="Job details" className="mt-3 -mb-px flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cx(
                  "border-b-2 px-2.5 py-1.5 text-sm",
                  tab === t.id
                    ? "border-ink font-semibold text-ink"
                    : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {log.status === "error" && (
            <p
              className="border-b border-line bg-stop-soft px-4 py-2 text-xs text-stop"
              role="alert"
            >
              Couldn't load this job's history: {log.error}
            </p>
          )}
          {tab === "chat" && <ChatTab view={view} events={log.events} status={log.status} />}
          {tab === "diff" && <DiffTab view={view} />}
          {tab === "events" && <EventsTab events={log.events} />}
          {tab === "logs" && <LogsTab events={log.events} />}
        </div>
      </aside>
    </>
  );
}
