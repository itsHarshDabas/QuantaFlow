import {
  type AgentProfile,
  CreateJobInput,
  canTransition,
  evaluatePolicy,
  type Job,
  type McpServerConfig,
  MergeInput,
  type MergeResult,
  newId,
  pickPermissionOption,
  type SessionState,
  TERMINAL_STATES,
} from "@quantaflow/core";
import {
  type DriverEvent,
  type DriverSession,
  type HarnessRegistry,
  type PermissionAsk,
  type PermissionDecision,
  startAcpSession,
} from "@quantaflow/drivers";
import type { AgentDirectory } from "./agents.js";
import type { ApprovalCenter } from "./approvals.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { EventLog } from "./events.js";
import type { Store } from "./store.js";
import type { PreparedWorkspace, WorkspaceManager } from "./workspace.js";

const FLUSH_MS = 50;
/** Most worker jobs one orchestrator may start, so a confused model can't flood the queue. */
export const MAX_CHILD_JOBS = 20;
/** The MCP server name QuantaFlow uses for its own orchestrator tools. */
export const ORCHESTRATOR_MCP_NAME = "quantaflow";
const MAX_BUFFERED_CHARS = 4_000;
const CANCEL_GRACE_MS = 5_000;

interface MessageBuffer {
  role: "agent" | "thought";
  messageId: string | undefined;
  text: string;
}

interface LiveJob {
  jobId: string;
  agent: AgentProfile;
  /** Orchestrators mostly wait on their workers, so they don't take a concurrency slot. */
  orchestrator: boolean;
  session: DriverSession | null;
  busy: boolean;
  cancel: { reason: string; state: SessionState } | null;
  pendingPermissions: number;
  buffer: MessageBuffer | null;
  flushTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  limitTimer: NodeJS.Timeout | undefined;
  closing: Promise<void> | null;
}

export interface SupervisorOptions {
  store: Store;
  log: EventLog;
  agents: AgentDirectory;
  approvals: ApprovalCenter;
  workspaces: WorkspaceManager;
  registry: HarnessRegistry;
  maxConcurrent: number;
  idleMinutes: number;
  version: string;
  /** The MCP server that gives an orchestrator job its tools. Without it, orchestrators get none. */
  orchestratorMcp?: (job: Job) => McpServerConfig | null;
}

function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || "Untitled job";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Context QuantaFlow adds before the job prompt, so the agent knows where it is working. */
export function composePrompt(
  agent: AgentProfile,
  text: string,
  workspace: Pick<PreparedWorkspace, "mode" | "branch" | "portBase">,
  restarted: boolean,
  role: Job["role"] = "worker",
): string {
  const context: string[] = [];
  if (role === "orchestrator") {
    context.push(
      `You are the orchestrator for this run. Use the ${ORCHESTRATOR_MCP_NAME} MCP tools to split the work across worker agents: list_agents, create_job, wait_for_jobs, get_job, send_message and cancel_job. Each worker gets its own workspace and sees only the prompt you give it. Combine their results into one answer. You can start up to ${MAX_CHILD_JOBS} workers.`,
    );
  }
  if (workspace.mode === "worktree" && workspace.branch) {
    context.push(
      `You are working in an isolated git worktree on branch ${workspace.branch}, separate from the main checkout.`,
    );
  } else if (workspace.mode === "folder") {
    context.push(
      "You are working in a fresh folder created for this job. Save the files you produce here.",
    );
  }
  context.push(
    `If you start servers, use ports ${workspace.portBase} to ${workspace.portBase + 9}. PORT and QF_PORT_BASE are set to the first one.`,
  );
  if (restarted) {
    context.push(
      "This continues an earlier job in a new session. The earlier conversation is not available, but its work is in this workspace.",
    );
  }
  const parts = [];
  if (agent.instructions.trim()) parts.push(agent.instructions.trim());
  parts.push(`[QuantaFlow] ${context.join(" ")}`);
  parts.push(text);
  return parts.join("\n\n");
}

/** Runs jobs: queues them, starts harness sessions, routes permissions and tracks state. */
export class Supervisor {
  private readonly live = new Map<string, LiveJob>();
  private readonly queue: string[] = [];
  private stopping = false;

  constructor(private readonly o: SupervisorOptions) {}

  /** Marks jobs a previous daemon left mid-flight, and re-queues jobs that never started. */
  recover(): void {
    for (const job of this.o.store.listJobs(10_000).reverse()) {
      if (job.status === "queued") {
        this.queue.push(job.id);
      } else if (
        job.status === "starting" ||
        job.status === "working" ||
        job.status === "needs_input"
      ) {
        this.setState(job.id, "failed", "Interrupted because the QuantaFlow daemon stopped");
      }
    }
    this.pump();
  }

  createJob(input: unknown): Job {
    const parsed = CreateJobInput.safeParse(input);
    if (!parsed.success) throw badRequest("Invalid job", parsed.error.issues);
    const agent = this.o.agents.get(parsed.data.agentId);
    if (!agent) throw notFound(`Agent "${parsed.data.agentId}"`);
    if (!this.o.registry.get(agent.harness)) {
      throw badRequest(`Agent "${agent.id}" uses unknown harness "${agent.harness}"`);
    }
    const dependsOn = [...new Set(parsed.data.dependsOn ?? [])];
    for (const dep of dependsOn) {
      if (!this.o.store.getJob(dep)) throw badRequest(`Dependency "${dep}" does not exist`);
    }
    const parentJobId = parsed.data.parentJobId ?? null;
    const role = parsed.data.role ?? "worker";
    let runId = parsed.data.runId ?? null;
    if (parentJobId) {
      const parent = this.o.store.getJob(parentJobId);
      if (!parent) throw badRequest(`Parent job "${parentJobId}" does not exist`);
      if (parent.role !== "orchestrator") {
        throw badRequest(`Parent job "${parentJobId}" is not an orchestrator`);
      }
      if (role === "orchestrator") {
        throw badRequest("An orchestrator can't start another orchestrator");
      }
      if (TERMINAL_STATES.has(parent.status) && parent.status !== "done") {
        throw conflict(`Parent job "${parentJobId}" has ${parent.status}`);
      }
      const children = this.o.store
        .listJobs(10_000)
        .filter((j) => j.parentJobId === parentJobId).length;
      if (children >= MAX_CHILD_JOBS) {
        throw conflict(`An orchestrator can start at most ${MAX_CHILD_JOBS} jobs`);
      }
      runId = parent.runId ?? parent.id;
    }
    const id = newId("job");
    if (role === "orchestrator" && !runId) runId = id;
    const now = Date.now();
    const job: Job = {
      id,
      title: parsed.data.title?.trim() || titleFrom(parsed.data.prompt),
      prompt: parsed.data.prompt,
      agentId: agent.id,
      harness: agent.harness,
      workspace: parsed.data.workspace ?? agent.workspace,
      workspacePath: null,
      branch: null,
      baseRef: null,
      portBase: null,
      status: "queued",
      error: null,
      createdAt: now,
      updatedAt: now,
      runId,
      parentJobId,
      dependsOn,
      role,
      workspaceState: "active",
    };
    this.o.store.saveJob(job);
    this.o.log.append(job.id, { type: "job.created", job });
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /** Sends a follow-up. Reuses the live session, or starts a new one in the same workspace. */
  sendMessage(jobId: string, text: string): void {
    const job = this.o.store.getJob(jobId);
    if (!job) throw notFound(`Job "${jobId}"`);
    if (!text.trim()) throw badRequest("Message is empty");
    const live = this.live.get(jobId);
    if (live?.busy || live?.closing || job.status === "queued" || job.status === "starting") {
      throw conflict("The agent is still working. Wait for it to finish, or cancel it first.");
    }
    if (job.workspaceState === "discarded") {
      throw conflict("This job's workspace was discarded, so it can't continue. Start a new job.");
    }
    if (live?.session && !live.session.closed) {
      void this.runTurn(live, text, text);
      return;
    }
    void this.start(jobId, { text, restarted: job.workspacePath !== null });
  }

  /** A job's workspace can be merged or discarded only while nothing runs in it. */
  private stoppedJob(jobId: string, action: string): Job {
    const job = this.o.store.getJob(jobId);
    if (!job) throw notFound(`Job "${jobId}"`);
    const live = this.live.get(jobId);
    const stopped = TERMINAL_STATES.has(job.status) || job.status === "idle";
    if (!stopped || live?.busy) {
      throw conflict(
        `The job is still ${job.status}. Wait for it to finish or cancel it, then ${action}.`,
        {
          reason: "running",
        },
      );
    }
    if (job.workspaceState === "discarded") {
      throw conflict("The job's workspace was already discarded.", { reason: "discarded" });
    }
    return job;
  }

  async merge(jobId: string, input: unknown): Promise<MergeResult> {
    const parsed = MergeInput.safeParse(input ?? {});
    if (!parsed.success) throw badRequest("Invalid merge request", parsed.error.issues);
    const job = this.stoppedJob(jobId, "merge");
    const result = await this.o.workspaces.merge(job, parsed.data.strategy, parsed.data.message);
    const latest = this.o.store.getJob(jobId) ?? job;
    this.o.store.saveJob({ ...latest, workspaceState: "merged", updatedAt: Date.now() });
    this.o.log.append(jobId, { type: "workspace.merged", ...result });
    return result;
  }

  async discard(jobId: string): Promise<void> {
    const job = this.stoppedJob(jobId, "discard it");
    const live = this.live.get(jobId);
    if (live) await this.close(live); // An idle session still has its cwd in the workspace.
    await this.o.workspaces.discard(job);
    const latest = this.o.store.getJob(jobId) ?? job;
    this.o.store.saveJob({ ...latest, workspaceState: "discarded", updatedAt: Date.now() });
    this.o.log.append(jobId, { type: "workspace.discarded" });
  }

  async cancel(jobId: string, reason = "Cancelled by you"): Promise<void> {
    const job = this.o.store.getJob(jobId);
    if (!job) throw notFound(`Job "${jobId}"`);
    const queued = this.queue.indexOf(jobId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.setState(jobId, "cancelled", reason);
      return;
    }
    const live = this.live.get(jobId);
    if (!live) {
      if (!TERMINAL_STATES.has(job.status)) this.setState(jobId, "cancelled", reason);
      return;
    }
    if (!live.busy && job.status === "done") {
      await this.close(live);
      return;
    }
    live.cancel = { reason, state: "cancelled" };
    this.o.approvals.cancelForJob(jobId, reason);
    if (live.busy && live.session) {
      await live.session.cancel();
      const timer = setTimeout(() => {
        if (this.live.get(jobId) === live && live.busy) void this.finish(live, "cancelled", reason);
      }, CANCEL_GRACE_MS);
      timer.unref();
    } else if (live.session) {
      await this.finish(live, "cancelled", reason);
    }
    // Still starting: start() sees live.cancel once the session is up and stops it.
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        if (live.busy) {
          live.cancel = { reason: "The QuantaFlow daemon stopped", state: "failed" };
          this.o.approvals.cancelForJob(live.jobId, "The QuantaFlow daemon stopped");
          this.setState(live.jobId, "failed", "Interrupted because the QuantaFlow daemon stopped");
        }
        await this.close(live);
      }),
    );
  }

  /** The agent's MCP servers, plus QuantaFlow's own for an orchestrator. */
  private mcpServersFor(job: Job, agent: AgentProfile): McpServerConfig[] {
    if (job.role !== "orchestrator") return agent.mcpServers;
    const own = this.o.orchestratorMcp?.(job);
    if (!own) {
      this.o.log.append(job.id, {
        type: "notice",
        severity: "warning",
        title: "Orchestrator tools are unavailable",
        description: "The QuantaFlow MCP server is not built, so this job can't start workers.",
      });
      return agent.mcpServers;
    }
    return [...agent.mcpServers.filter((s) => s.name !== own.name), own];
  }

  private activeCount(): number {
    let count = 0;
    for (const live of this.live.values()) {
      if (!live.orchestrator && (live.busy || !live.session)) count += 1;
    }
    return count;
  }

  /** Starts queued jobs whose dependencies are done, up to the concurrency limit. */
  private pump(): void {
    if (this.stopping) return;
    let i = 0;
    while (i < this.queue.length && this.activeCount() < this.o.maxConcurrent) {
      const jobId = this.queue[i] as string;
      const gate = this.dependencyGate(jobId);
      if (gate === "wait") {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      if (gate === "ready") void this.start(jobId, null);
      else this.setState(jobId, "failed", gate.reason);
    }
  }

  private dependencyGate(jobId: string): "ready" | "wait" | { reason: string } {
    const job = this.o.store.getJob(jobId);
    if (!job) return { reason: "Job record missing" };
    for (const depId of job.dependsOn) {
      const dep = this.o.store.getJob(depId);
      if (!dep) return { reason: `Dependency "${depId}" no longer exists` };
      if (dep.status === "done") continue;
      if (dep.status === "failed" || dep.status === "cancelled") {
        return { reason: `Dependency "${dep.title}" ${dep.status}` };
      }
      return "wait";
    }
    return "ready";
  }

  private setState(jobId: string, state: SessionState, reason?: string): void {
    const job = this.o.store.getJob(jobId);
    if (!job || job.status === state || !canTransition(job.status, state)) return;
    const updated: Job = {
      ...job,
      status: state,
      updatedAt: Date.now(),
      error: state === "failed" ? (reason ?? "Failed") : state === "starting" ? null : job.error,
    };
    this.o.store.saveJob(updated);
    this.o.log.append(jobId, { type: "job.state", state, ...(reason ? { reason } : {}) });
  }

  private patchJob(
    jobId: string,
    patch: Partial<Pick<Job, "workspacePath" | "branch" | "baseRef" | "portBase">>,
  ): void {
    const job = this.o.store.getJob(jobId);
    if (!job) return;
    this.o.store.saveJob({ ...job, ...patch, updatedAt: Date.now() });
    this.o.log.append(jobId, { type: "job.updated", patch });
  }

  private async start(
    jobId: string,
    followUp: { text: string; restarted: boolean } | null,
  ): Promise<void> {
    const job = this.o.store.getJob(jobId);
    if (!job) return;
    const agent = this.o.agents.get(job.agentId);
    if (!agent) {
      this.setState(jobId, "failed", `Agent "${job.agentId}" no longer exists`);
      return;
    }
    const orchestrator = job.role === "orchestrator";
    const live: LiveJob = {
      jobId,
      agent,
      orchestrator,
      session: null,
      busy: false,
      cancel: null,
      pendingPermissions: 0,
      buffer: null,
      flushTimer: undefined,
      idleTimer: undefined,
      limitTimer: undefined,
      closing: null,
    };
    this.live.set(jobId, live);
    this.setState(jobId, "starting");

    try {
      let workspace: PreparedWorkspace;
      if (job.workspacePath) {
        const portBase = this.o.workspaces.allocatePorts();
        workspace = {
          mode: job.workspace,
          path: job.workspacePath,
          branch: job.branch,
          baseRef: job.baseRef,
          portBase,
        };
        this.patchJob(jobId, { portBase });
      } else {
        workspace = await this.o.workspaces.prepare(jobId, job.workspace);
        if (workspace.fallbackReason) {
          this.o.log.append(jobId, {
            type: "notice",
            severity: "info",
            title: "Using a folder instead of a worktree",
            description: workspace.fallbackReason,
          });
        }
        this.patchJob(jobId, {
          workspacePath: workspace.path,
          branch: workspace.branch,
          baseRef: workspace.baseRef,
          portBase: workspace.portBase,
        });
      }

      const spec = this.o.registry.get(job.harness);
      if (!spec) throw new Error(`Unknown harness "${job.harness}"`);
      live.session = await startAcpSession({
        spec,
        cwd: workspace.path,
        env: {
          QF_JOB_ID: jobId,
          QF_AGENT_ID: agent.id,
          QF_PORT_BASE: String(workspace.portBase),
          PORT: String(workspace.portBase),
        },
        ...(agent.model ? { model: agent.model } : {}),
        mcpServers: this.mcpServersFor(job, agent),
        clientVersion: this.o.version,
        onEvent: (event) => this.onDriverEvent(live, event),
        onPermission: (ask, signal) => this.onPermission(live, ask, signal),
        onExit: (info) => this.onExit(live, info.code, info.signal),
      });

      if (live.cancel) {
        await this.finish(live, live.cancel.state, live.cancel.reason);
        return;
      }
      const minutes = agent.limits.maxMinutes;
      if (minutes) {
        live.limitTimer = setTimeout(
          () => void this.cancel(jobId, `Stopped at the ${minutes} minute limit`),
          minutes * 60_000,
        );
        live.limitTimer.unref();
      }
      const text = followUp?.text ?? job.prompt;
      await this.runTurn(
        live,
        composePrompt(agent, text, workspace, followUp?.restarted ?? false, job.role),
        text,
      );
    } catch (error) {
      if (live.cancel) await this.finish(live, live.cancel.state, live.cancel.reason);
      else await this.finish(live, "failed", errorMessage(error));
    }
  }

  private async runTurn(live: LiveJob, prompt: string, shown: string): Promise<void> {
    const session = live.session;
    if (!session) return;
    live.busy = true;
    clearTimeout(live.idleTimer);
    this.o.log.append(live.jobId, { type: "message", role: "user", text: shown });
    this.setState(live.jobId, "working");
    try {
      const { stopReason } = await session.prompt(prompt);
      this.flush(live);
      this.o.log.append(live.jobId, { type: "turn.ended", stopReason });
      live.busy = false;
      if (live.cancel) {
        await this.finish(live, live.cancel.state, live.cancel.reason);
      } else if (stopReason === "cancelled") {
        this.setState(live.jobId, "idle", "The agent stopped the turn");
        this.scheduleIdleClose(live);
      } else if (stopReason === "refusal") {
        await this.finish(live, "failed", "The agent refused this request");
      } else {
        if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
          this.o.log.append(live.jobId, {
            type: "notice",
            severity: "warning",
            title: "The agent hit its limit for one turn",
            description: `Stop reason: ${stopReason}. Send a follow-up to let it continue.`,
          });
        }
        this.setState(live.jobId, "done");
        this.scheduleIdleClose(live);
      }
    } catch (error) {
      this.flush(live);
      live.busy = false;
      if (live.cancel) await this.finish(live, live.cancel.state, live.cancel.reason);
      else await this.finish(live, "failed", errorMessage(error));
    } finally {
      live.busy = false;
      this.pump();
    }
  }

  private scheduleIdleClose(live: LiveJob): void {
    clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => void this.close(live), this.o.idleMinutes * 60_000);
    live.idleTimer.unref();
  }

  private async finish(live: LiveJob, state: SessionState, reason?: string): Promise<void> {
    this.flush(live);
    this.setState(live.jobId, state, reason);
    await this.close(live);
  }

  /** Stops the harness process. The job keeps its state, so a follow-up can start a new session. */
  private close(live: LiveJob): Promise<void> {
    if (live.closing) return live.closing;
    live.closing = (async () => {
      clearTimeout(live.idleTimer);
      clearTimeout(live.limitTimer);
      this.flush(live);
      this.o.approvals.cancelForJob(live.jobId);
      await live.session?.close();
      const job = this.o.store.getJob(live.jobId);
      this.o.workspaces.releasePorts(job?.portBase ?? null);
      if (this.live.get(live.jobId) === live) this.live.delete(live.jobId);
      this.pump();
    })();
    return live.closing;
  }

  private onExit(live: LiveJob, code: number | null, signal: string | null): void {
    if (live.busy || live.closing) return; // The failing prompt or the close path reports it.
    this.o.log.append(live.jobId, {
      type: "log",
      stream: "system",
      text: `The harness exited between turns (${signal ? `signal ${signal}` : `code ${code}`}). A follow-up starts a new session.`,
    });
    void this.close(live);
  }

  private onDriverEvent(live: LiveJob, event: DriverEvent): void {
    if (event.type === "message" && event.role !== "user") {
      const buffer = live.buffer;
      if (buffer && buffer.role === event.role && buffer.messageId === event.messageId) {
        buffer.text += event.text;
      } else {
        this.flush(live);
        live.buffer = { role: event.role, messageId: event.messageId, text: event.text };
      }
      if ((live.buffer?.text.length ?? 0) >= MAX_BUFFERED_CHARS) this.flush(live);
      else if (!live.flushTimer) live.flushTimer = setTimeout(() => this.flush(live), FLUSH_MS);
      return;
    }
    this.flush(live);
    this.o.log.append(live.jobId, event);
  }

  private flush(live: LiveJob): void {
    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    const buffer = live.buffer;
    live.buffer = null;
    if (!buffer?.text) return;
    this.o.log.append(live.jobId, {
      type: "message",
      role: buffer.role,
      text: buffer.text,
      ...(buffer.messageId ? { messageId: buffer.messageId } : {}),
    });
  }

  private async onPermission(
    live: LiveJob,
    ask: PermissionAsk,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    this.flush(live);
    const verdict = evaluatePolicy(live.agent.policy, ask);
    if (verdict.action !== "ask") {
      const approvalId = newId("apr");
      const option = pickPermissionOption(
        ask.options,
        verdict.action === "allow" ? "allow" : "deny",
      );
      this.o.log.append(live.jobId, {
        type: "permission.requested",
        approvalId,
        title: ask.title,
        kind: ask.kind,
        options: ask.options,
        ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}),
        ...(ask.input !== undefined ? { input: ask.input } : {}),
      });
      this.o.log.append(live.jobId, {
        type: "permission.resolved",
        approvalId,
        outcome: option ? (verdict.action === "allow" ? "allowed" : "denied") : "cancelled",
        ...(option ? { optionId: option.optionId } : {}),
        by: "policy",
        reason: verdict.reason,
      });
      return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
    }

    live.pendingPermissions += 1;
    this.setState(live.jobId, "needs_input");
    try {
      return await this.o.approvals.request(live.jobId, ask, signal);
    } finally {
      live.pendingPermissions -= 1;
      if (live.pendingPermissions === 0 && live.busy && !live.cancel) {
        this.setState(live.jobId, "working");
      }
    }
  }
}
