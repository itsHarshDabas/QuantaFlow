import type { AgentProfile, QfEvent, StateSnapshot, StreamMessage } from "@quantaflow/core";
import type { Backend } from "./backend";

export type ConnectionStatus = "connecting" | "live" | "offline";

export interface SyncSink {
  setConnection(status: ConnectionStatus, retryAt: number | null): void;
  snapshot(snapshot: StateSnapshot): void;
  events(events: QfEvent[]): void;
  agents(agents: AgentProfile[]): void;
  /** Called after each fresh snapshot, so open job logs can fetch what they missed. */
  resynced(): void;
}

const FLUSH_MS = 40;
const MAX_BACKOFF_MS = 10_000;

/**
 * Keeps the UI in step with the daemon without gaps:
 * open the stream, buffer what it sends, fetch the snapshot, then replay the buffer.
 * Live events are batched so a fast-streaming agent doesn't re-render per word.
 */
export class LiveSync {
  private socket: { close: () => void } | null = null;
  private buffer: StreamMessage[] | null = null;
  private pending: QfEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(
    private readonly backend: Backend,
    private readonly sink: SyncSink,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** Skips the backoff wait and reconnects now. */
  retryNow(): void {
    if (this.stopped || this.socket) return;
    this.clearTimers();
    this.connect();
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.retryTimer = null;
    this.flushTimer = null;
  }

  private connect(): void {
    this.retryTimer = null;
    this.buffer = [];
    this.pending = [];
    this.sink.setConnection("connecting", null);
    const socket = this.backend.subscribe({
      onOpen: () => void this.resync(socket),
      onMessage: (message) => {
        if (this.socket === socket) this.receive(message);
      },
      onClose: () => this.closed(socket),
    });
    this.socket = socket;
  }

  private async resync(socket: { close: () => void }): Promise<void> {
    try {
      const snapshot = await this.backend.state();
      if (this.socket !== socket) return;
      const buffered = this.buffer ?? [];
      this.buffer = null;
      this.sink.snapshot(snapshot);
      for (const message of buffered) this.receive(message);
      this.flush();
      this.attempts = 0;
      this.sink.setConnection("live", null);
      this.sink.resynced();
    } catch {
      // Closing triggers the normal reconnect path.
      if (this.socket === socket) socket.close();
    }
  }

  private receive(message: StreamMessage): void {
    if (this.buffer) {
      this.buffer.push(message);
      return;
    }
    if (message.type === "event") {
      this.pending.push(message.event);
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
    } else if (message.type === "agents") {
      this.sink.agents(message.agents);
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.sink.events(batch);
  }

  private closed(socket: { close: () => void }): void {
    if (this.socket !== socket) return;
    this.flush();
    this.socket = null;
    this.buffer = null;
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts) + Math.random() * 250;
    this.attempts += 1;
    this.sink.setConnection("offline", Date.now() + delay);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
