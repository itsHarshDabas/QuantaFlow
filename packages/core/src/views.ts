import type {
  FileDiff,
  Job,
  QfEvent,
  SessionState,
  ToolKind,
  ToolStatus,
  Usage,
} from "./schemas.js";

/** A compact, always-current summary of one job, built by folding its events. */
export interface JobView {
  job: Job;
  lastMessage: string;
  toolCalls: number;
  pendingApprovals: number;
  usage: Usage | null;
  lastEventAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

const LAST_MESSAGE_CHARS = 240;

export function createJobView(job: Job): JobView {
  return {
    job,
    lastMessage: "",
    toolCalls: 0,
    pendingApprovals: 0,
    usage: null,
    lastEventAt: job.createdAt,
    startedAt: null,
    endedAt: null,
  };
}

function tail(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trimStart();
  return clean.length <= max ? clean : `…${clean.slice(clean.length - max + 1)}`;
}

/**
 * Pure reducer: returns a new view with the event applied.
 * Agent messages arrive in chunks, so a chunk that continues the previous
 * agent message is appended to `lastMessage` instead of replacing it.
 */
export function applyEvent(view: JobView, event: QfEvent, previous?: QfEvent): JobView {
  const next: JobView = { ...view, lastEventAt: event.ts };
  switch (event.type) {
    case "job.created":
      return { ...next, job: event.job };
    case "job.updated":
      return { ...next, job: { ...view.job, ...event.patch, updatedAt: event.ts } };
    case "job.state": {
      const job: Job = {
        ...view.job,
        status: event.state,
        updatedAt: event.ts,
        error: event.state === "failed" ? (event.reason ?? view.job.error) : view.job.error,
      };
      const isEnd =
        event.state === "done" || event.state === "failed" || event.state === "cancelled";
      return {
        ...next,
        job,
        startedAt: view.startedAt ?? (event.state === "starting" ? event.ts : null),
        endedAt: isEnd ? event.ts : null,
        pendingApprovals: isEnd ? 0 : view.pendingApprovals,
      };
    }
    case "message": {
      if (event.role !== "agent") return next;
      const continues =
        previous?.type === "message" &&
        previous.role === "agent" &&
        previous.messageId === event.messageId;
      const text = continues ? `${view.lastMessage}${event.text}` : event.text;
      return { ...next, lastMessage: tail(text, LAST_MESSAGE_CHARS) };
    }
    case "tool.call":
      return { ...next, toolCalls: view.toolCalls + 1 };
    case "permission.requested":
      return { ...next, pendingApprovals: view.pendingApprovals + 1 };
    case "permission.resolved":
      return { ...next, pendingApprovals: Math.max(0, view.pendingApprovals - 1) };
    case "usage":
      return { ...next, usage: event.usage };
    case "workspace.merged":
      return { ...next, job: { ...view.job, workspaceState: "merged", updatedAt: event.ts } };
    case "workspace.discarded":
      return { ...next, job: { ...view.job, workspaceState: "discarded", updatedAt: event.ts } };
    default:
      return next;
  }
}

/** Folds a job's full event list into its view. */
export function foldJob(job: Job, events: readonly QfEvent[]): JobView {
  let view = createJobView(job);
  let previous: QfEvent | undefined;
  for (const event of events) {
    view = applyEvent(view, event, previous);
    previous = event;
  }
  return view;
}

export type TranscriptItem =
  | { kind: "message"; key: string; role: "user" | "agent" | "thought"; text: string; ts: number }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolStatus;
      locations: string[];
      output?: string;
      diffs?: FileDiff[];
      ts: number;
    }
  | {
      kind: "permission";
      key: string;
      approvalId: string;
      title: string;
      toolKind: ToolKind;
      status: "pending" | "allowed" | "denied" | "cancelled";
      by?: "user" | "policy" | "system";
      reason?: string;
      ts: number;
    }
  | {
      kind: "plan";
      key: string;
      entries: { content: string; status: string; priority: string }[];
      ts: number;
    }
  | {
      kind: "notice";
      key: string;
      severity: "info" | "warning" | "error";
      title: string;
      description?: string;
      ts: number;
    }
  | { kind: "state"; key: string; state: SessionState; reason?: string; ts: number }
  | { kind: "turn"; key: string; stopReason: string; ts: number };

const SHOWN_STATES: ReadonlySet<SessionState> = new Set(["failed", "cancelled", "done"]);

/** Turns a job's events into a readable conversation: merged messages, live tool cards, approvals. */
export function buildTranscript(events: readonly QfEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, number>();
  const approvals = new Map<string, number>();
  let plan: number | undefined;

  for (const event of events) {
    const last = items.at(-1);
    switch (event.type) {
      case "message": {
        if (last?.kind === "message" && last.role === event.role && event.role !== "user") {
          items[items.length - 1] = { ...last, text: last.text + event.text };
        } else {
          items.push({
            kind: "message",
            key: `m${event.seq}`,
            role: event.role,
            text: event.text,
            ts: event.ts,
          });
        }
        break;
      }
      case "tool.call": {
        tools.set(event.toolCallId, items.length);
        items.push({
          kind: "tool",
          key: `t${event.seq}`,
          toolCallId: event.toolCallId,
          title: event.title,
          toolKind: event.kind,
          status: event.status,
          locations: event.locations,
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.diffs !== undefined ? { diffs: event.diffs } : {}),
          ts: event.ts,
        });
        break;
      }
      case "tool.update": {
        const index = tools.get(event.toolCallId);
        const item = index === undefined ? undefined : items[index];
        if (index !== undefined && item?.kind === "tool") {
          items[index] = {
            ...item,
            ...(event.title ? { title: event.title } : {}),
            ...(event.kind ? { toolKind: event.kind } : {}),
            ...(event.status ? { status: event.status } : {}),
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.diffs !== undefined ? { diffs: event.diffs } : {}),
          };
        }
        break;
      }
      case "permission.requested": {
        approvals.set(event.approvalId, items.length);
        items.push({
          kind: "permission",
          key: `p${event.seq}`,
          approvalId: event.approvalId,
          title: event.title,
          toolKind: event.kind,
          status: "pending",
          ts: event.ts,
        });
        break;
      }
      case "permission.resolved": {
        const index = approvals.get(event.approvalId);
        const item = index === undefined ? undefined : items[index];
        if (index !== undefined && item?.kind === "permission") {
          items[index] = {
            ...item,
            status: event.outcome,
            by: event.by,
            ...(event.reason ? { reason: event.reason } : {}),
          };
        }
        break;
      }
      case "plan": {
        const entry: TranscriptItem = {
          kind: "plan",
          key: plan === undefined ? `plan${event.seq}` : (items[plan]?.key ?? `plan${event.seq}`),
          entries: event.entries,
          ts: event.ts,
        };
        if (plan === undefined) {
          plan = items.length;
          items.push(entry);
        } else {
          items[plan] = entry;
        }
        break;
      }
      case "notice":
        items.push({
          kind: "notice",
          key: `n${event.seq}`,
          severity: event.severity,
          title: event.title,
          ...(event.description ? { description: event.description } : {}),
          ts: event.ts,
        });
        break;
      case "workspace.merged":
        items.push({
          kind: "notice",
          key: `w${event.seq}`,
          severity: "info",
          title: `Merged into ${event.into}`,
          description: `${event.strategy === "squash" ? "Squashed as" : "Merge commit"} ${event.commit.slice(0, 10)}`,
          ts: event.ts,
        });
        break;
      case "workspace.discarded":
        items.push({
          kind: "notice",
          key: `w${event.seq}`,
          severity: "info",
          title: "Workspace discarded",
          ts: event.ts,
        });
        break;
      case "job.state":
        if (SHOWN_STATES.has(event.state)) {
          items.push({
            kind: "state",
            key: `s${event.seq}`,
            state: event.state,
            ...(event.reason ? { reason: event.reason } : {}),
            ts: event.ts,
          });
        }
        break;
      default:
        break;
    }
  }
  return items;
}

export type StateCounts = Record<SessionState, number>;

export function countStates(views: Iterable<JobView>): StateCounts {
  const counts: StateCounts = {
    queued: 0,
    starting: 0,
    working: 0,
    needs_input: 0,
    idle: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const view of views) counts[view.job.status] += 1;
  return counts;
}
