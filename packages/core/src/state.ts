import type { SessionState } from "./schemas.js";

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["working", "failed", "cancelled"],
  working: ["needs_input", "idle", "done", "failed", "cancelled"],
  needs_input: ["working", "idle", "done", "failed", "cancelled"],
  idle: ["working", "starting", "done", "failed", "cancelled"],
  done: ["working", "starting", "failed", "cancelled"],
  failed: ["starting"],
  cancelled: ["starting"],
};

/** Whether a job may move from one state to another. Same-state moves are no-ops, not errors. */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export const STATE_LABELS: Record<SessionState, string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  needs_input: "Needs input",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
