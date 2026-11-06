import { z } from "zod";

/** Lifecycle of a job's agent session. */
export const SESSION_STATES = [
  "queued",
  "starting",
  "working",
  "needs_input",
  "idle",
  "done",
  "failed",
  "cancelled",
] as const;
export const SessionState = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionState>;

/** States a job never leaves on its own. A follow-up message can reopen `done`. */
export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(["done", "failed", "cancelled"]);

export const ToolKind = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolStatus = z.infer<typeof ToolStatus>;

/**
 * Where a job runs.
 * - `worktree`: its own git worktree and branch (code work).
 * - `folder`: a fresh empty folder (research, writing, ops).
 * - `cwd`: the project root itself, with no isolation.
 */
export const WorkspaceMode = z.enum(["worktree", "folder", "cwd"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

export const PolicyAction = z.enum(["allow", "deny", "ask"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyRule = z.object({
  action: PolicyAction,
  /** Tool kinds this rule applies to. Omit to match every kind. */
  kinds: z.array(ToolKind).optional(),
  /** Case-insensitive regular expression tested against the tool title and its raw input. */
  pattern: z.string().max(500).optional(),
  note: z.string().max(200).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyPreset = z.enum(["readonly", "safe", "trusted"]);
export type PolicyPreset = z.infer<typeof PolicyPreset>;

export const Policy = z.object({
  preset: PolicyPreset.default("safe"),
  rules: z.array(PolicyRule).max(100).default([]),
});
export type Policy = z.infer<typeof Policy>;

export const McpServerConfig = z.object({
  name: z.string().min(1).max(64),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const AgentProfileInput = z.object({
  id: z
    .string()
    .regex(
      AGENT_ID_PATTERN,
      "Use lowercase letters, digits and dashes, starting with a letter or digit",
    ),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  /** Harness id, such as `claude-code`, `codex`, `opencode`, `gemini`, `kilo` or `fake`. */
  harness: z.string().min(1).max(64),
  model: z.string().max(120).optional(),
  /** Role prompt placed before every job prompt. */
  instructions: z.string().max(20_000).default(""),
  workspace: WorkspaceMode.default("worktree"),
  policy: Policy.default({ preset: "safe", rules: [] }),
  mcpServers: z.array(McpServerConfig).max(20).default([]),
  limits: z
    .object({
      maxMinutes: z
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .optional(),
    })
    .default({}),
});
export type AgentProfileInput = z.input<typeof AgentProfileInput>;

export const AgentProfile = AgentProfileInput.extend({
  /** `file` agents come from `.quantaflow/agents/*.yaml` and are read-only in the UI. */
  source: z.enum(["db", "file"]).default("db"),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const WorkspaceState = z.enum(["active", "merged", "discarded"]);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

export const MergeStrategy = z.enum(["merge", "squash"]);
export type MergeStrategy = z.infer<typeof MergeStrategy>;

export const MergeInput = z.object({
  strategy: MergeStrategy.default("merge"),
  /** Commit message. Defaults to one naming the job. */
  message: z.string().min(1).max(5000).optional(),
});
export type MergeInput = z.input<typeof MergeInput>;

export interface MergeResult {
  commit: string;
  /** The branch the job was merged into: the one checked out in the project root. */
  into: string;
  strategy: MergeStrategy;
}

export const Job = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  agentId: z.string(),
  harness: z.string(),
  workspace: WorkspaceMode,
  workspacePath: z.string().nullable(),
  branch: z.string().nullable(),
  /** Commit the worktree started from, so the diff covers committed and uncommitted work. */
  baseRef: z.string().nullable(),
  portBase: z.number().int().nullable(),
  status: SessionState,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Workflow or orchestrator run this job belongs to. */
  runId: z.string().nullable().default(null),
  /** Job that spawned this one, such as an orchestrator. */
  parentJobId: z.string().nullable().default(null),
  /** Jobs that must finish as `done` before this one starts. */
  dependsOn: z.array(z.string()).default([]),
  role: z.enum(["worker", "orchestrator"]).default("worker"),
  /** What happened to the job's workspace: still there, merged into the project, or removed. */
  workspaceState: WorkspaceState.default("active"),
});
export type Job = z.infer<typeof Job>;

export const CreateJobInput = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  title: z.string().max(200).optional(),
  workspace: WorkspaceMode.optional(),
  runId: z.string().max(64).optional(),
  parentJobId: z.string().max(64).optional(),
  dependsOn: z.array(z.string().max(64)).max(50).optional(),
  role: z.enum(["worker", "orchestrator"]).optional(),
});
export type CreateJobInput = z.input<typeof CreateJobInput>;

export const PermissionOptionKind = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>;

export const PermissionOption = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: PermissionOptionKind,
});
export type PermissionOption = z.infer<typeof PermissionOption>;

export const FileDiff = z.object({
  path: z.string(),
  oldText: z.string().nullable().optional(),
  newText: z.string(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const Usage = z.object({
  used: z.number(),
  size: z.number(),
  cost: z.object({ amount: z.number(), currency: z.string() }).nullable().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** Everything that happens to a job is one of these. Stored append-only. */
export const QfEventData = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job.created"), job: Job }),
  z.object({
    type: z.literal("job.updated"),
    patch: Job.pick({
      workspacePath: true,
      branch: true,
      baseRef: true,
      portBase: true,
      error: true,
    }).partial(),
  }),
  z.object({ type: z.literal("job.state"), state: SessionState, reason: z.string().optional() }),
  z.object({
    type: z.literal("message"),
    role: z.enum(["user", "agent", "thought"]),
    text: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.call"),
    toolCallId: z.string(),
    title: z.string(),
    kind: ToolKind,
    status: ToolStatus,
    locations: z.array(z.string()).default([]),
    input: z.unknown().optional(),
    output: z.string().optional(),
    diffs: z.array(FileDiff).optional(),
  }),
  z.object({
    type: z.literal("tool.update"),
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: ToolKind.optional(),
    status: ToolStatus.optional(),
    output: z.string().optional(),
    diffs: z.array(FileDiff).optional(),
  }),
  z.object({
    type: z.literal("plan"),
    entries: z.array(z.object({ content: z.string(), status: z.string(), priority: z.string() })),
  }),
  z.object({
    type: z.literal("permission.requested"),
    approvalId: z.string(),
    toolCallId: z.string().optional(),
    title: z.string(),
    kind: ToolKind,
    options: z.array(PermissionOption),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("permission.resolved"),
    approvalId: z.string(),
    outcome: z.enum(["allowed", "denied", "cancelled"]),
    optionId: z.string().optional(),
    by: z.enum(["user", "policy", "system"]),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("usage"), usage: Usage }),
  z.object({
    type: z.literal("notice"),
    severity: z.enum(["info", "warning", "error"]),
    title: z.string(),
    description: z.string().optional(),
  }),
  z.object({ type: z.literal("log"), stream: z.enum(["stderr", "system"]), text: z.string() }),
  z.object({ type: z.literal("turn.ended"), stopReason: z.string() }),
  z.object({
    type: z.literal("workspace.merged"),
    commit: z.string(),
    into: z.string(),
    strategy: MergeStrategy,
  }),
  z.object({ type: z.literal("workspace.discarded") }),
]);
export type QfEventData = z.infer<typeof QfEventData>;
export type QfEventType = QfEventData["type"];

export type QfEvent = QfEventData & {
  /** Global, strictly increasing sequence number. */
  seq: number;
  /** Unix epoch milliseconds. */
  ts: number;
  jobId: string;
};

export type EventOf<T extends QfEventType> = Extract<QfEvent, { type: T }>;

export interface PendingApproval {
  id: string;
  jobId: string;
  title: string;
  kind: ToolKind;
  options: PermissionOption[];
  input?: unknown;
  createdAt: number;
}

export const ApprovalDecision = z.object({
  decision: z.enum(["allow", "allow_always", "deny"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export interface HarnessInfo {
  id: string;
  label: string;
  tier: "acp";
  command: string;
  args: string[];
  /** Whether the harness's own CLI was found on PATH. Informational only. */
  found: boolean;
  install: string;
  notes?: string;
}
