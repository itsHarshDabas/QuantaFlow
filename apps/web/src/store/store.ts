import type { QfEvent } from "@quantaflow/core";
import { create } from "zustand";
import { api } from "../lib/backend";
import { errorMessage } from "../lib/errors";
import type { ConnectionStatus, SyncSink } from "../lib/sync";
import { applyEvents, applySnapshot, emptyLiveData, type LiveData, mergeLog } from "./reduce";

/** Job logs kept in memory at once. The oldest closed one is dropped past this. */
const MAX_LOGS = 12;

export interface UiState extends LiveData {
  connection: ConnectionStatus;
  retryAt: number | null;
  everConnected: boolean;
  demo: boolean;
}

export const useQf = create<UiState>()(() => ({
  ...emptyLiveData,
  connection: "connecting",
  retryAt: null,
  everConnected: false,
  demo: false,
}));

const set = useQf.setState;
const get = useQf.getState;

/** Wires the live sync to the store. */
export const storeSink: SyncSink = {
  setConnection(connection, retryAt) {
    set((state) => ({
      connection,
      retryAt,
      everConnected: state.everConnected || connection === "live",
    }));
  },
  snapshot(snapshot) {
    set((state) => applySnapshot(state, snapshot));
  },
  events(events) {
    set((state) => applyEvents(state, events));
  },
  agents(agents) {
    set({ agents });
  },
  resynced() {
    // Fetch anything open logs missed while the stream was down.
    for (const [jobId, log] of Object.entries(get().logs)) {
      const after = log.events.at(-1)?.seq ?? 0;
      void fetchLog(jobId, after);
    }
  },
};

async function fetchLog(jobId: string, after: number): Promise<void> {
  try {
    const { events } = await api().events(jobId, after);
    set((state) => mergeLog(state, jobId, events));
  } catch (error) {
    set((state) => {
      const log = state.logs[jobId];
      return {
        logs: {
          ...state.logs,
          [jobId]: { status: "error", events: log?.events ?? [], error: errorMessage(error) },
        },
      };
    });
  }
}

/**
 * Starts keeping the full event history of a job, for the drawer.
 * Live events for the job are recorded from this moment, so nothing falls between the fetch and
 * the stream.
 */
export function openLog(jobId: string): void {
  const existing = get().logs[jobId];
  if (existing && existing.status !== "error") {
    touchLog(jobId);
    return;
  }
  set((state) => {
    const logs = { ...state.logs, [jobId]: { status: "loading" as const, events: [] } };
    const ids = Object.keys(logs);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_LOGS))) {
      if (id !== jobId) delete logs[id];
    }
    return { logs };
  });
  void fetchLog(jobId, 0);
}

/** Moves a log to the end of the eviction order. */
function touchLog(jobId: string): void {
  set((state) => {
    const log = state.logs[jobId];
    if (!log) return {};
    const { [jobId]: _moved, ...rest } = state.logs;
    return { logs: { ...rest, [jobId]: log } };
  });
}

/** Events for one job, merged from history and the live stream. */
export function useJobEvents(jobId: string | null): {
  status: "idle" | "loading" | "ready" | "error";
  events: QfEvent[];
  error?: string;
} {
  const log = useQf((state) => (jobId ? state.logs[jobId] : undefined));
  if (!jobId || !log) return { status: "idle", events: EMPTY };
  return log;
}

const EMPTY: QfEvent[] = [];
