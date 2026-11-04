import type { JobView, SessionState } from "@quantaflow/core";

/** The few colors a state can take. Amber is reserved for "waiting on you". */
export type Tone = "amber" | "run" | "ok" | "stop" | "wait";

export const STATE_TONE: Record<SessionState, Tone> = {
  queued: "wait",
  starting: "run",
  working: "run",
  needs_input: "amber",
  idle: "wait",
  done: "ok",
  failed: "stop",
  cancelled: "wait",
};

/** Full class names, so Tailwind can see them. */
export const TONE: Record<Tone, { fill: string; soft: string; text: string; border: string }> = {
  amber: {
    fill: "bg-amber",
    soft: "bg-amber-soft",
    text: "text-amber-text",
    border: "border-amber",
  },
  run: { fill: "bg-run", soft: "bg-run-soft", text: "text-run", border: "border-run" },
  ok: { fill: "bg-ok", soft: "bg-ok-soft", text: "text-ok", border: "border-ok" },
  stop: { fill: "bg-stop", soft: "bg-stop-soft", text: "text-stop", border: "border-stop" },
  wait: { fill: "bg-wait", soft: "bg-wait-soft", text: "text-ink-muted", border: "border-wait" },
};

/** CSS variable for a tone, for SVG fills and inline styles. */
export const TONE_VAR: Record<Tone, string> = {
  amber: "var(--amber)",
  run: "var(--run)",
  ok: "var(--ok)",
  stop: "var(--stop)",
  wait: "var(--wait)",
};

/** Whether a job is waiting on a person: an open approval, or the agent asked for input. */
export function needsYou(view: JobView): boolean {
  return view.job.status === "needs_input" || view.pendingApprovals > 0;
}

/** The tone shown for a job. Pending approvals turn any live job amber. */
export function jobTone(view: JobView): Tone {
  return needsYou(view) ? "amber" : STATE_TONE[view.job.status];
}

/** Lower is more urgent. Used for the default sort everywhere. */
export const URGENCY: Record<SessionState, number> = {
  needs_input: 0,
  working: 1,
  starting: 1,
  queued: 2,
  idle: 3,
  failed: 4,
  done: 5,
  cancelled: 6,
};

export function byUrgency(a: JobView, b: JobView): number {
  const rank = (view: JobView) => (needsYou(view) ? -1 : URGENCY[view.job.status]);
  return rank(a) - rank(b) || b.lastEventAt - a.lastEventAt;
}

export type StateGroup = "all" | "you" | "running" | "idle" | "finished";

export const STATE_GROUPS: { id: StateGroup; label: string }[] = [
  { id: "all", label: "All" },
  { id: "you", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "idle", label: "Idle" },
  { id: "finished", label: "Finished" },
];

export function inGroup(view: JobView, group: StateGroup): boolean {
  const status = view.job.status;
  switch (group) {
    case "all":
      return true;
    case "you":
      return needsYou(view);
    case "running":
      return (
        !needsYou(view) && (status === "queued" || status === "starting" || status === "working")
      );
    case "idle":
      return !needsYou(view) && status === "idle";
    case "finished":
      return status === "done" || status === "failed" || status === "cancelled";
  }
}

export function isLive(status: SessionState): boolean {
  return status !== "done" && status !== "failed" && status !== "cancelled";
}
