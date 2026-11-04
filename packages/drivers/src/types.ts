import type { McpServerConfig, PermissionOption, QfEventData, ToolKind } from "@quantaflow/core";

/** How to launch one harness. Every built-in harness speaks ACP over stdio. */
export interface HarnessSpec {
  id: string;
  label: string;
  tier: "acp";
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** How to pass an agent's model to this harness, when it has no ACP model option. */
  model?: {
    /** Environment variable that carries the model id. */
    env?: string;
    /** Extra arguments; `{model}` is replaced with the model id. */
    args?: string[];
  };
  /** Binary that shows the harness is installed. Used for the "found" hint only. */
  detect?: string;
  install: string;
  notes?: string;
}

/** Events a driver can produce. Job lifecycle and approval events belong to the daemon. */
export type DriverEvent = Extract<
  QfEventData,
  { type: "message" | "tool.call" | "tool.update" | "plan" | "usage" | "notice" | "log" }
>;

export interface PermissionAsk {
  toolCallId?: string;
  title: string;
  kind: ToolKind;
  options: PermissionOption[];
  input?: unknown;
}

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface StartSessionOptions {
  spec: HarnessSpec;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  mcpServers?: McpServerConfig[];
  clientVersion?: string;
  onEvent: (event: DriverEvent) => void;
  /** Called for every permission request. `signal` aborts if the turn ends first. */
  onPermission: (ask: PermissionAsk, signal: AbortSignal) => Promise<PermissionDecision>;
  /** Called once if the harness process exits on its own. */
  onExit?: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
}

export interface DriverSession {
  readonly sessionId: string;
  readonly agentName: string | null;
  /** Runs one prompt turn to completion. */
  prompt(text: string): Promise<{ stopReason: string }>;
  /** Asks the agent to stop the current turn. The turn then ends with `cancelled`. */
  cancel(): Promise<void>;
  /** Ends the session and stops the harness process. Safe to call more than once. */
  close(): Promise<void>;
  readonly closed: boolean;
}

export class HarnessError extends Error {
  constructor(
    message: string,
    readonly kind: "not_installed" | "auth_required" | "protocol" | "exited",
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
