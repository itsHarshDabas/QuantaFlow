import { type JobView, QfApiError } from "@quantaflow/core";
import { api } from "./backend";

/** What happened to a job's workspace after the work: still there, merged, or removed. */
export type WorkspaceState = "active" | "merged" | "discarded";

export type MergeStrategy = "merge" | "squash";

export interface MergeResult {
  commit: string;
  into: string;
}

/** The body of a 409 from merge: why it was refused, and the conflicting paths if any. */
export interface MergeRefusal {
  reason: string;
  conflicts?: string[];
}

/** Review calls the daemon added in M3. Optional until every backend implements them. */
export interface ReviewMethods {
  merge(jobId: string, body: { strategy: MergeStrategy; message?: string }): Promise<MergeResult>;
  discard(jobId: string): Promise<{ ok: true }>;
}

export function workspaceState(view: JobView): WorkspaceState {
  const state = (view.job as { workspaceState?: WorkspaceState }).workspaceState;
  return state ?? "active";
}

/** Merge needs a worktree job that has stopped; discard needs any job with its own workspace. */
export function canMerge(view: JobView): boolean {
  return view.job.workspace === "worktree" && workspaceState(view) === "active" && stopped(view);
}

export function canDiscard(view: JobView): boolean {
  return view.job.workspace !== "cwd" && workspaceState(view) !== "discarded" && stopped(view);
}

const STOPPED = new Set(["done", "idle", "failed", "cancelled"]);

export function stopped(view: JobView): boolean {
  return STOPPED.has(view.job.status);
}

export function refusalOf(error: unknown): MergeRefusal | null {
  if (!(error instanceof QfApiError) || error.status !== 409) return null;
  const body = error.body as Partial<MergeRefusal> | undefined;
  return {
    reason: typeof body?.reason === "string" ? body.reason : error.message,
    ...(Array.isArray(body?.conflicts) ? { conflicts: body.conflicts.map(String) } : {}),
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const record = (parsed ?? {}) as { error?: unknown; reason?: unknown };
    const message =
      typeof record.reason === "string"
        ? record.reason
        : typeof record.error === "string"
          ? record.error
          : `Request failed with ${response.status}`;
    throw new QfApiError(response.status, message, parsed);
  }
  return parsed as T;
}

/** Uses the backend's own methods when it has them, else calls the daemon directly. */
export function review(): ReviewMethods {
  const backend = api() as Partial<ReviewMethods>;
  const id = (jobId: string) => encodeURIComponent(jobId);
  return {
    merge: (jobId, body) =>
      backend.merge
        ? backend.merge(jobId, body)
        : post<MergeResult>(`/api/jobs/${id(jobId)}/merge`, body),
    discard: (jobId) =>
      backend.discard ? backend.discard(jobId) : post(`/api/jobs/${id(jobId)}/discard`, {}),
  };
}
