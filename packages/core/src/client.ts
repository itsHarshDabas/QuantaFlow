import type {
  AgentProfile,
  AgentProfileInput,
  ApprovalDecision,
  CreateJobInput,
  HarnessInfo,
  Job,
  PendingApproval,
  QfEvent,
} from "./schemas.js";
import type { JobView } from "./views.js";

export const DEFAULT_PORT = 4747;

export interface StateSnapshot {
  version: string;
  root: string;
  agents: AgentProfile[];
  harnesses: HarnessInfo[];
  jobs: JobView[];
  approvals: PendingApproval[];
  lastSeq: number;
}

export interface DiffResult {
  available: boolean;
  diff: string;
  reason?: string;
}

/** Messages the daemon pushes over `/api/stream`. */
export type StreamMessage =
  | { type: "hello"; lastSeq: number; version: string }
  | { type: "event"; event: QfEvent }
  | { type: "agents"; agents: AgentProfile[] };

export class QfApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "QfApiError";
  }
}

export interface QfClientOptions {
  /** Daemon origin such as `http://127.0.0.1:4747`. Empty means same origin (the web UI). */
  baseUrl?: string;
}

export interface StreamHandlers {
  onMessage: (message: StreamMessage) => void;
  onOpen?: () => void;
  onClose?: (event: { code: number; reason: string }) => void;
}

/** Typed HTTP and WebSocket client for the QuantaFlow daemon. Works in Node 22+ and browsers. */
export class QfClient {
  readonly baseUrl: string;

  constructor(options: QfClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: {} };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const message =
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof parsed.error === "string"
          ? parsed.error
          : `${method} ${path} failed with ${response.status}`;
      throw new QfApiError(response.status, message, parsed);
    }
    return parsed as T;
  }

  state(): Promise<StateSnapshot> {
    return this.request("GET", "/api/state");
  }

  harnesses(): Promise<HarnessInfo[]> {
    return this.request("GET", "/api/harnesses");
  }

  agents(): Promise<AgentProfile[]> {
    return this.request("GET", "/api/agents");
  }

  createAgent(input: AgentProfileInput): Promise<AgentProfile> {
    return this.request("POST", "/api/agents", input);
  }

  updateAgent(id: string, input: AgentProfileInput): Promise<AgentProfile> {
    return this.request("PUT", `/api/agents/${encodeURIComponent(id)}`, input);
  }

  deleteAgent(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  jobs(): Promise<JobView[]> {
    return this.request("GET", "/api/jobs");
  }

  job(id: string): Promise<JobView> {
    return this.request("GET", `/api/jobs/${encodeURIComponent(id)}`);
  }

  createJob(input: CreateJobInput): Promise<Job> {
    return this.request("POST", "/api/jobs", input);
  }

  events(jobId: string, after = 0): Promise<{ events: QfEvent[] }> {
    return this.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
  }

  sendMessage(jobId: string, text: string): Promise<{ ok: true }> {
    return this.request("POST", `/api/jobs/${encodeURIComponent(jobId)}/messages`, { text });
  }

  cancelJob(jobId: string): Promise<{ ok: true }> {
    return this.request("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  diff(jobId: string): Promise<DiffResult> {
    return this.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/diff`);
  }

  approvals(): Promise<PendingApproval[]> {
    return this.request("GET", "/api/approvals");
  }

  decide(approvalId: string, decision: ApprovalDecision["decision"]): Promise<{ ok: true }> {
    return this.request("POST", `/api/approvals/${encodeURIComponent(approvalId)}`, { decision });
  }

  streamUrl(): string {
    if (this.baseUrl) return `${this.baseUrl.replace(/^http/, "ws")}/api/stream`;
    const { protocol, host } = globalThis.location;
    return `${protocol === "https:" ? "wss" : "ws"}://${host}/api/stream`;
  }

  /** Opens the live event stream. Reconnecting is left to the caller. */
  subscribe(handlers: StreamHandlers): { close: () => void } {
    const socket = new WebSocket(this.streamUrl());
    socket.addEventListener("open", () => handlers.onOpen?.());
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        handlers.onMessage(JSON.parse(event.data) as StreamMessage);
      } catch {
        // Ignore malformed frames; the daemon only sends JSON.
      }
    });
    socket.addEventListener("close", (event) =>
      handlers.onClose?.({ code: event.code, reason: event.reason }),
    );
    return { close: () => socket.close() };
  }
}
