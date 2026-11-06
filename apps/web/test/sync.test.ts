import type { QfEvent, StateSnapshot, StreamHandlers, StreamMessage } from "@quantaflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/lib/backend";
import { type ConnectionStatus, LiveSync, type SyncSink } from "../src/lib/sync";

class FakeBackend {
  handlers: StreamHandlers | null = null;
  closed = 0;
  snapshot: StateSnapshot = {
    version: "t",
    root: "/r",
    agents: [],
    harnesses: [],
    jobs: [],
    approvals: [],
    lastSeq: 0,
  };
  resolveState: ((s: StateSnapshot) => void) | null = null;
  failState = false;

  subscribe(handlers: StreamHandlers) {
    this.handlers = handlers;
    return {
      close: () => {
        this.closed += 1;
        const h = this.handlers;
        this.handlers = null;
        h?.onClose?.({ code: 1006, reason: "" });
      },
    };
  }

  state(): Promise<StateSnapshot> {
    if (this.failState) return Promise.reject(new Error("down"));
    return new Promise((resolve) => {
      this.resolveState = resolve;
    });
  }

  send(message: StreamMessage) {
    this.handlers?.onMessage(message);
  }
}

const event = (seq: number): QfEvent =>
  ({ type: "job.state", state: "working", seq, ts: seq, jobId: "j1" }) as QfEvent;

function recordingSink() {
  const log: string[] = [];
  const statuses: ConnectionStatus[] = [];
  const sink: SyncSink = {
    setConnection: (status) => statuses.push(status),
    snapshot: (s) => log.push(`snapshot@${s.lastSeq}`),
    events: (events) => log.push(`events:${events.map((e) => e.seq).join(",")}`),
    agents: () => log.push("agents"),
    resynced: () => log.push("resynced"),
  };
  return { sink, log, statuses };
}

describe("LiveSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("buffers stream events until the snapshot lands, then replays them in order", async () => {
    const backend = new FakeBackend();
    const { sink, log, statuses } = recordingSink();
    const sync = new LiveSync(backend as unknown as Backend, sink);
    sync.start();
    backend.handlers?.onOpen?.();
    backend.send({ type: "event", event: event(4) });
    backend.send({ type: "event", event: event(5) });
    expect(log).toEqual([]);

    backend.resolveState?.({ ...backend.snapshot, lastSeq: 4 });
    await vi.runOnlyPendingTimersAsync();
    // The sink skips seq <= lastSeq itself; the sync must deliver both in order after the snapshot.
    expect(log).toEqual(["snapshot@4", "events:4,5", "resynced"]);
    expect(statuses.at(-1)).toBe("live");
    sync.stop();
  });

  it("batches live events after sync", async () => {
    const backend = new FakeBackend();
    const { sink, log } = recordingSink();
    const sync = new LiveSync(backend as unknown as Backend, sink);
    sync.start();
    backend.handlers?.onOpen?.();
    backend.resolveState?.(backend.snapshot);
    await vi.runOnlyPendingTimersAsync();
    log.length = 0;

    backend.send({ type: "event", event: event(1) });
    backend.send({ type: "event", event: event(2) });
    backend.send({ type: "event", event: event(3) });
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(["events:1,2,3"]);
    sync.stop();
  });

  it("goes offline and reconnects with backoff when the stream drops", async () => {
    const backend = new FakeBackend();
    const { sink, statuses } = recordingSink();
    const subscribe = vi.spyOn(backend, "subscribe");
    const sync = new LiveSync(backend as unknown as Backend, sink);
    sync.start();
    backend.handlers?.onClose?.({ code: 1006, reason: "" });
    expect(statuses.at(-1)).toBe("offline");
    expect(subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("connecting");
    sync.stop();
  });

  it("closes and retries when the snapshot request fails", async () => {
    const backend = new FakeBackend();
    backend.failState = true;
    const { sink, statuses } = recordingSink();
    const sync = new LiveSync(backend as unknown as Backend, sink);
    sync.start();
    backend.handlers?.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.closed).toBe(1);
    expect(statuses.at(-1)).toBe("offline");
    sync.stop();
  });

  it("passes agent updates straight through once live", async () => {
    const backend = new FakeBackend();
    const { sink, log } = recordingSink();
    const sync = new LiveSync(backend as unknown as Backend, sink);
    sync.start();
    backend.handlers?.onOpen?.();
    backend.resolveState?.(backend.snapshot);
    await vi.runOnlyPendingTimersAsync();
    backend.send({ type: "agents", agents: [] });
    expect(log.at(-1)).toBe("agents");
    sync.stop();
  });
});
