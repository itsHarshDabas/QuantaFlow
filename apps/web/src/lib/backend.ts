import type { QfClient } from "@quantaflow/core";
import type { ReviewMethods } from "./review";

/**
 * The part of the daemon API the UI uses. `QfClient` from core is the real one; the demo
 * implements the same shape in the browser so the UI runs without a daemon.
 */
export type Backend = Pick<
  QfClient,
  | "state"
  | "createAgent"
  | "updateAgent"
  | "deleteAgent"
  | "createJob"
  | "events"
  | "sendMessage"
  | "cancelJob"
  | "diff"
  | "decide"
  | "subscribe"
> &
  Partial<ReviewMethods>;

let current: Backend | undefined;

export function setBackend(backend: Backend): void {
  current = backend;
}

/** The active backend. Set once at startup in `main.tsx`. */
export function api(): Backend {
  if (!current) throw new Error("The backend is not set yet");
  return current;
}

/** `?demo` in the URL runs the UI against an in-browser simulation instead of the daemon. */
export function demoRequested(search: string): boolean {
  return new URLSearchParams(search).has("demo") || import.meta.env.VITE_QF_DEMO === "1";
}
