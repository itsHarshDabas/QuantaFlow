import { storeSink } from "../store/store";
import type { Backend } from "./backend";
import { LiveSync } from "./sync";

let live: LiveSync | null = null;

export function startLive(backend: Backend): void {
  live?.stop();
  live = new LiveSync(backend, storeSink);
  live.start();
}

/** Reconnects now instead of waiting out the backoff. */
export function retryNow(): void {
  live?.retryNow();
}
