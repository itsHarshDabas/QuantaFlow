import { type JobView, QfApiError, type WorkspaceState } from "@quantaflow/core";

export type { MergeResult, MergeStrategy, WorkspaceState } from "@quantaflow/core";

/** Why a merge or discard was refused (a 409), with the files involved when there are any. */
export interface MergeRefusal {
  message: string;
  reason?: "running" | "dirty" | "conflict" | "empty" | "discarded";
  /** Files that conflict (`conflict`) or are uncommitted in the project (`dirty`). */
  files?: string[];
}

export function workspaceState(view: JobView): WorkspaceState {
  return view.job.workspaceState ?? "active";
}

const STOPPED = new Set(["done", "idle", "failed", "cancelled"]);

export function stopped(view: JobView): boolean {
  return STOPPED.has(view.job.status);
}

/** Merge needs a worktree job that has stopped and is still active. */
export function canMerge(view: JobView): boolean {
  return view.job.workspace === "worktree" && workspaceState(view) === "active" && stopped(view);
}

/** Discard needs a stopped job with its own worktree or folder, merged or not. */
export function canDiscard(view: JobView): boolean {
  return view.job.workspace !== "cwd" && workspaceState(view) !== "discarded" && stopped(view);
}

/** Reads the daemon's 409 body: `{ error, details: { reason, conflicts?, files? } }`. */
export function refusalOf(error: unknown): MergeRefusal | null {
  if (!(error instanceof QfApiError) || error.status !== 409) return null;
  const details = (error.body as { details?: Record<string, unknown> } | undefined)?.details;
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : undefined);
  const files = list(details?.conflicts) ?? list(details?.files);
  const reason = typeof details?.reason === "string" ? details.reason : undefined;
  return {
    message: error.message,
    ...(reason ? { reason: reason as MergeRefusal["reason"] } : {}),
    ...(files && files.length > 0 ? { files } : {}),
  };
}
