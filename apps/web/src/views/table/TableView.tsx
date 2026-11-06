import type { JobView } from "@quantaflow/core";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  FolderGit2,
  FolderRoot,
  GitMerge,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button, cx, Empty, StateTag } from "../../components/ui";
import { api } from "../../lib/backend";
import { errorMessage } from "../../lib/errors";
import { formatAgo, formatCost, formatDuration, plural } from "../../lib/format";
import { harnessLabel, useAgentMap, useHarnessMap, useNow } from "../../lib/hooks";
import { workspaceState } from "../../lib/review";
import { openJob } from "../../lib/router";
import {
  byUrgency,
  inGroup,
  isLive,
  jobTone,
  needsYou,
  STATE_GROUPS,
  type StateGroup,
  TONE_VAR,
} from "../../lib/states";
import { useQf } from "../../store/store";
import { useChrome } from "../../store/ui";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    className?: string;
    _phantom?: [TData, TValue];
  }
}

function WorkspaceCell({ view }: { view: JobView }) {
  const { job } = view;
  const state = workspaceState(view);
  if (state !== "active") {
    const Icon = state === "merged" ? GitMerge : Trash2;
    return (
      <span
        className={cx(
          "flex items-center gap-1.5 text-xs",
          state === "merged" ? "text-ok" : "text-ink-faint",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {state === "merged" ? "Merged" : "Discarded"}
      </span>
    );
  }
  if (job.workspace === "worktree") {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-ink-muted"
        title={job.workspacePath ?? undefined}
      >
        <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
        {job.branch ? (
          <span className="truncate font-mono text-xs">{job.branch}</span>
        ) : (
          <span className="text-xs">New worktree</span>
        )}
      </span>
    );
  }
  const Icon = job.workspace === "folder" ? Folder : FolderRoot;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-ink-muted"
      title={job.workspacePath ?? undefined}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {job.workspace === "folder" ? "Own folder" : "Project root"}
    </span>
  );
}

function ContextCell({ view }: { view: JobView }) {
  const usage = view.usage;
  if (!usage || usage.size <= 0) return <span className="text-ink-faint">–</span>;
  const share = Math.min(1, usage.used / usage.size);
  return (
    <span
      className="flex flex-col gap-1"
      title={`${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens`}
    >
      <span className="flex items-baseline justify-between gap-2 text-xs tabular">
        <span>{Math.round(share * 100)}%</span>
        {usage.cost && (
          <span className="text-ink-faint">
            {formatCost(usage.cost.amount, usage.cost.currency)}
          </span>
        )}
      </span>
      <span className="h-[3px] w-full overflow-hidden rounded-full bg-sunken">
        <span
          className={cx("block h-full", share > 0.85 ? "bg-stop" : "bg-ink-faint")}
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </span>
  );
}

function DurationCell({ view }: { view: JobView }) {
  const now = useNow(1000);
  if (!view.startedAt) return <span className="text-ink-faint">–</span>;
  const end = view.endedAt ?? (isLive(view.job.status) ? now : view.lastEventAt);
  return <span className="tabular">{formatDuration(end - view.startedAt)}</span>;
}

function AgoCell({ ts }: { ts: number }) {
  const now = useNow(15_000);
  return <span className="tabular text-ink-muted">{formatAgo(ts, now)}</span>;
}

export function TableView({ selectedJob }: { selectedJob: string | null }) {
  const jobsById = useQf((s) => s.jobs);
  const agents = useAgentMap();
  const harnesses = useHarnessMap();
  const openNewJob = useChrome((s) => s.openNewJob);
  const [group, setGroup] = useState<StateGroup>("all");
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [bulkError, setBulkError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => Object.values(jobsById).sort(byUrgency), [jobsById]);

  const counts = useMemo(() => {
    const result: Record<StateGroup, number> = { all: 0, you: 0, running: 0, idle: 0, finished: 0 };
    for (const view of all) {
      for (const g of STATE_GROUPS) if (inGroup(view, g.id)) result[g.id] += 1;
    }
    return result;
  }, [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((view) => {
      if (!inGroup(view, group)) return false;
      if (agentFilter && view.job.agentId !== agentFilter) return false;
      if (!needle) return true;
      const agent = agents.get(view.job.agentId)?.name ?? "";
      return [view.job.title, view.job.prompt, view.job.branch ?? "", agent, view.job.harness]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [all, group, agentFilter, query, agents]);

  const agentOptions = useMemo(() => {
    const used = new Set(all.map((v) => v.job.agentId));
    return [...used].map((id) => ({ id, name: agents.get(id)?.name ?? id }));
  }, [all, agents]);

  const columns = useMemo<ColumnDef<JobView>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        meta: { className: "w-9 pl-4" },
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all jobs"
            className="accent-ink"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.job.title}`}
            className="accent-ink"
            checked={row.getIsSelected()}
            onClick={(event) => event.stopPropagation()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      },
      {
        id: "job",
        header: "Job",
        accessorFn: (view) => view.job.title.toLowerCase(),
        meta: { className: "@4xl:w-[40%]" },
        cell: ({ row }) => {
          const view = row.original;
          return (
            <div className="min-w-0 py-0.5">
              <button
                type="button"
                className="block max-w-full truncate text-left font-semibold text-ink hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  openJob(view.job.id);
                }}
              >
                {view.job.title}
              </button>
              <p className="mt-0.5 truncate text-xs text-ink-muted">
                {view.job.status === "failed" && view.job.error
                  ? view.job.error
                  : view.lastMessage ||
                    (view.job.status === "queued" ? waitingFor(view, jobsById) : "")}
              </p>
            </div>
          );
        },
      },
      {
        id: "state",
        header: "State",
        sortingFn: (a, b) => byUrgency(a.original, b.original),
        accessorFn: (view) => view.job.status,
        meta: { className: "w-[108px] @md:w-[120px]" },
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-0.5">
            <StateTag view={row.original} />
            {row.original.pendingApprovals > 1 && (
              <span className="text-xs text-amber-text tabular">
                {row.original.pendingApprovals} requests
              </span>
            )}
          </div>
        ),
      },
      {
        id: "agent",
        header: "Agent",
        accessorFn: (view) => agents.get(view.job.agentId)?.name ?? view.job.agentId,
        meta: { className: "hidden w-[150px] @xl:table-cell" },
        cell: ({ row, getValue }) => (
          <div className="min-w-0">
            <p className="truncate">
              {String(getValue())}
              {row.original.job.role === "orchestrator" && (
                <span className="ml-1.5 text-xs text-ink-faint">orchestrator</span>
              )}
            </p>
            <p className="truncate text-xs text-ink-muted">
              {harnessLabel(harnesses, row.original.job.harness)}
            </p>
          </div>
        ),
      },
      {
        id: "workspace",
        header: "Workspace",
        enableSorting: false,
        meta: { className: "hidden w-[170px] @4xl:table-cell" },
        cell: ({ row }) => <WorkspaceCell view={row.original} />,
      },
      {
        id: "tools",
        header: "Tool calls",
        accessorFn: (view) => view.toolCalls,
        meta: { className: "hidden w-[84px] text-right @3xl:table-cell" },
        cell: ({ getValue }) => <span className="tabular">{String(getValue())}</span>,
      },
      {
        id: "context",
        header: "Context",
        accessorFn: (view) => (view.usage ? view.usage.used / Math.max(1, view.usage.size) : -1),
        meta: { className: "hidden w-[96px] @5xl:table-cell" },
        cell: ({ row }) => <ContextCell view={row.original} />,
      },
      {
        id: "time",
        header: "Run time",
        accessorFn: (view) => (view.startedAt ? (view.endedAt ?? Date.now()) - view.startedAt : -1),
        meta: { className: "hidden w-[90px] @2xl:table-cell" },
        cell: ({ row }) => <DurationCell view={row.original} />,
      },
      {
        id: "updated",
        header: "Updated",
        accessorFn: (view) => view.lastEventAt,
        sortDescFirst: true,
        meta: { className: "w-[84px] whitespace-nowrap pr-3 @md:w-[92px] @md:pr-4" },
        cell: ({ row }) => <AgoCell ts={row.original.lastEventAt} />,
      },
    ],
    [agents, harnesses, jobsById],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection: selection },
    getRowId: (view) => view.job.id,
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
  });

  const selected = table.getSelectedRowModel().rows.map((r) => r.original);
  const cancellable = selected.filter((view) => isLive(view.job.status));

  async function cancelSelected() {
    setBulkError(null);
    const results = await Promise.allSettled(cancellable.map((v) => api().cancelJob(v.job.id)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      const first = failed[0] as PromiseRejectedResult;
      setBulkError(
        `${plural(failed.length, "job")} could not be cancelled: ${errorMessage(first.reason)}`,
      );
    }
    setSelection({});
  }

  if (all.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          title="No jobs yet"
          action={
            <Button variant="primary" onClick={() => openNewJob()}>
              Start a job
            </Button>
          }
        >
          A job is one piece of work for one agent, like "add rate limiting to the login route" or
          "summarize this week's changelogs". Start one and it shows up here as it runs.
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <fieldset className="flex items-center gap-1" aria-label="Filter by state">
          {STATE_GROUPS.map((g) => {
            const active = group === g.id;
            const urgent = g.id === "you" && counts.you > 0;
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={active}
                onClick={() => setGroup(g.id)}
                className={cx(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
                  active
                    ? "bg-ink font-semibold text-surface"
                    : "text-ink-muted hover:bg-raised hover:text-ink",
                )}
              >
                {g.label}
                <span
                  className={cx(
                    "tabular",
                    active
                      ? "opacity-70"
                      : urgent
                        ? "font-semibold text-amber-text"
                        : "text-ink-faint",
                  )}
                >
                  {counts[g.id]}
                </span>
              </button>
            );
          })}
        </fieldset>

        <div className="ml-auto flex items-center gap-2">
          {agentOptions.length > 1 && (
            <select
              aria-label="Filter by agent"
              value={agentFilter}
              onChange={(event) => setAgentFilter(event.target.value)}
              className="h-7 rounded-md border border-line bg-surface px-2 text-xs text-ink"
            >
              <option value="">All agents</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <label className="relative flex items-center">
            <span className="sr-only">Search jobs</span>
            <Search
              className="pointer-events-none absolute left-2 size-3.5 text-ink-faint"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  searchRef.current?.blur();
                }
              }}
              placeholder="Search jobs"
              className="h-7 w-40 rounded-md border border-line bg-surface pr-2 pl-7 text-xs placeholder:text-ink-faint focus:w-56 sm:w-48"
            />
          </label>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-raised px-4 py-2 text-sm">
          <span className="font-medium tabular">{plural(selected.length, "job")} selected</span>
          <Button
            size="sm"
            variant="danger"
            disabled={cancellable.length === 0}
            onClick={() => void cancelSelected()}
          >
            {cancellable.length === selected.length
              ? `Cancel ${plural(cancellable.length, "job")}`
              : `Cancel ${cancellable.length} still running`}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelection({})}>
            <X className="size-3.5" aria-hidden />
            Clear
          </Button>
          {bulkError && <span className="text-xs text-stop">{bulkError}</span>}
        </div>
      )}

      <div className="@container min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <Empty
            title="Nothing matches"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setGroup("all");
                  setQuery("");
                  setAgentFilter("");
                }}
              >
                Clear filters
              </Button>
            }
          >
            No job fits these filters right now.
          </Empty>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-canvas">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const canSort = header.column.getCanSort();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : undefined
                        }
                        className={cx(
                          "border-b border-line px-3 py-2 text-xs font-medium text-ink-muted",
                          header.column.columnDef.meta?.className?.includes("text-right")
                            ? ""
                            : "text-left",
                          header.column.columnDef.meta?.className,
                        )}
                      >
                        {canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 hover:text-ink"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" && <ArrowUp className="size-3" aria-hidden />}
                            {sorted === "desc" && <ArrowDown className="size-3" aria-hidden />}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const view = row.original;
                const open = view.job.id === selectedJob;
                const tone = jobTone(view);
                return (
                  <tr
                    key={row.id}
                    onClick={() => openJob(view.job.id)}
                    className={cx(
                      "group cursor-pointer",
                      open
                        ? "bg-raised"
                        : needsYou(view)
                          ? "bg-amber-soft/45 hover:bg-amber-soft/70"
                          : "hover:bg-raised/70",
                      !isLive(view.job.status) && !open && "text-ink-muted",
                    )}
                  >
                    {row.getVisibleCells().map((cell, index) => (
                      <td
                        key={cell.id}
                        className={cx(
                          "border-b border-line px-3 py-2 align-middle",
                          cell.column.columnDef.meta?.className,
                        )}
                        style={
                          index === 0 ? { boxShadow: `inset 3px 0 0 ${TONE_VAR[tone]}` } : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function waitingFor(view: JobView, jobs: Record<string, JobView>): string {
  const blockers = view.job.dependsOn.filter((id) => jobs[id]?.job.status !== "done");
  if (blockers.length === 0) return "Waiting to start";
  const names = blockers.map((id) => jobs[id]?.job.title ?? id);
  return `Waiting for ${names.length === 1 ? names[0] : plural(names.length, "job")}`;
}
