import {
  type AgentProfile,
  applyEvent,
  createJobView,
  type HarnessInfo,
  type JobView,
  type PendingApproval,
  type QfEvent,
  type StateSnapshot,
  TERMINAL_STATES,
  type ToolKind,
} from "@quantaflow/core";

/** A permission request that has been answered, kept so people can see what policy decided. */
export interface Decision {
  approvalId: string;
  jobId: string;
  title: string;
  kind: ToolKind;
  outcome: "allowed" | "denied" | "cancelled";
  by: "user" | "policy" | "system";
  reason?: string;
  ts: number;
}

/** Full event history for a job open in the drawer. */
export interface JobLog {
  status: "loading" | "ready" | "error";
  events: QfEvent[];
  error?: string;
}

/** How a job's branch was merged, from its `workspace.merged` event. */
export interface MergeInfo {
  commit: string;
  into: string;
  strategy: string;
  ts: number;
}

/** Workspace events from M3. Typed here until core's event union includes them. */
type WorkspaceEvent =
  | { type: "workspace.merged"; commit: string; into: string; strategy: string }
  | { type: "workspace.discarded" };

/** Everything the UI knows about the daemon, folded from the snapshot and the live stream. */
export interface LiveData {
  version: string;
  root: string;
  agents: AgentProfile[];
  harnesses: HarnessInfo[];
  jobs: Record<string, JobView>;
  approvals: Record<string, PendingApproval>;
  decisions: Decision[];
  lastSeq: number;
  /** The previous event of each job, so streamed message chunks join up. */
  lastEvent: Record<string, QfEvent>;
  logs: Record<string, JobLog>;
  /** Merge details seen on the stream since the page loaded, by job. */
  merges: Record<string, MergeInfo>;
}

export const MAX_DECISIONS = 40;

export const emptyLiveData: LiveData = {
  version: "",
  root: "",
  agents: [],
  harnesses: [],
  jobs: {},
  approvals: {},
  decisions: [],
  lastSeq: 0,
  lastEvent: {},
  logs: {},
  merges: {},
};

/** Replaces the daemon state with a fresh snapshot. Decisions and open logs survive a reconnect. */
export function applySnapshot(data: LiveData, snapshot: StateSnapshot): LiveData {
  const jobs: Record<string, JobView> = {};
  for (const view of snapshot.jobs) jobs[view.job.id] = view;
  const approvals: Record<string, PendingApproval> = {};
  for (const approval of snapshot.approvals) approvals[approval.id] = approval;
  return {
    ...data,
    version: snapshot.version,
    root: snapshot.root,
    agents: snapshot.agents,
    harnesses: snapshot.harnesses,
    jobs,
    approvals,
    lastSeq: snapshot.lastSeq,
    lastEvent: {},
  };
}

/** Merges two event lists by sequence number, dropping duplicates. */
export function mergeEvents(a: readonly QfEvent[], b: readonly QfEvent[]): QfEvent[] {
  const bySeq = new Map<number, QfEvent>();
  for (const event of a) bySeq.set(event.seq, event);
  for (const event of b) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

function appendToLog(log: JobLog, event: QfEvent): JobLog {
  const last = log.events.at(-1);
  if (!last || event.seq > last.seq) return { ...log, events: [...log.events, event] };
  if (log.events.some((existing) => existing.seq === event.seq)) return log;
  return { ...log, events: mergeEvents(log.events, [event]) };
}

/**
 * Applies a batch of live events. Events at or below `lastSeq` were already in the snapshot and
 * are skipped, which makes replaying a buffer after reconnecting safe.
 */
export function applyEvents(data: LiveData, events: readonly QfEvent[]): LiveData {
  const fresh = events.filter((event) => event.seq > data.lastSeq);
  if (fresh.length === 0) return data;

  const jobs = { ...data.jobs };
  const approvals = { ...data.approvals };
  const lastEvent = { ...data.lastEvent };
  const logs = { ...data.logs };
  let merges = data.merges;
  const decided: Decision[] = [];
  let lastSeq = data.lastSeq;

  for (const event of fresh) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;

    const current = jobs[event.jobId];
    if (event.type === "job.created") {
      jobs[event.jobId] = applyEvent(current ?? createJobView(event.job), event);
    } else if (current) {
      jobs[event.jobId] = applyEvent(current, event, lastEvent[event.jobId]);
    }
    lastEvent[event.jobId] = event;

    const workspace = event as unknown as WorkspaceEvent;
    if (workspace.type === "workspace.merged" || workspace.type === "workspace.discarded") {
      const view = jobs[event.jobId];
      const state = workspace.type === "workspace.merged" ? "merged" : "discarded";
      if (view) {
        jobs[event.jobId] = {
          ...view,
          job: { ...view.job, workspaceState: state, updatedAt: event.ts } as typeof view.job,
        };
      }
      if (workspace.type === "workspace.merged") {
        merges = {
          ...merges,
          [event.jobId]: {
            commit: workspace.commit,
            into: workspace.into,
            strategy: workspace.strategy,
            ts: event.ts,
          },
        };
      }
    }

    const log = logs[event.jobId];
    if (log) logs[event.jobId] = appendToLog(log, event);

    if (event.type === "permission.requested") {
      approvals[event.approvalId] = {
        id: event.approvalId,
        jobId: event.jobId,
        title: event.title,
        kind: event.kind,
        options: event.options,
        input: event.input,
        createdAt: event.ts,
      };
    } else if (event.type === "permission.resolved") {
      const pending = approvals[event.approvalId];
      delete approvals[event.approvalId];
      decided.push({
        approvalId: event.approvalId,
        jobId: event.jobId,
        title: pending?.title ?? "Permission request",
        kind: pending?.kind ?? "other",
        outcome: event.outcome,
        by: event.by,
        ...(event.reason ? { reason: event.reason } : {}),
        ts: event.ts,
      });
    } else if (event.type === "job.state" && TERMINAL_STATES.has(event.state)) {
      // A finished job can't act on an answer, so anything still pending for it is moot.
      for (const [id, approval] of Object.entries(approvals)) {
        if (approval.jobId === event.jobId) delete approvals[id];
      }
    }
  }

  const decisions =
    decided.length > 0
      ? [...decided.reverse(), ...data.decisions].slice(0, MAX_DECISIONS)
      : data.decisions;

  return { ...data, jobs, approvals, lastEvent, logs, decisions, merges, lastSeq };
}

/** Adds fetched history to a job's log, keeping any live events that arrived meanwhile. */
export function mergeLog(data: LiveData, jobId: string, events: readonly QfEvent[]): LiveData {
  const existing = data.logs[jobId];
  const merged = mergeEvents(existing?.events ?? [], events);
  return { ...data, logs: { ...data.logs, [jobId]: { status: "ready", events: merged } } };
}

/** Pending approvals, oldest first: the order a person should work through them. */
export function approvalQueue(approvals: Record<string, PendingApproval>): PendingApproval[] {
  return Object.values(approvals).sort((a, b) => a.createdAt - b.createdAt);
}
