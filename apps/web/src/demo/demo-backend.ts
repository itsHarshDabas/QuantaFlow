import {
  type AgentProfile,
  AgentProfileInput,
  type ApprovalDecision,
  type CreateJobInput,
  type DiffResult,
  foldJob,
  type Job,
  type PendingApproval,
  QfApiError,
  type QfEvent,
  type QfEventData,
  type SessionState,
  type StateSnapshot,
  type StreamHandlers,
  type StreamMessage,
  TERMINAL_STATES,
} from "@quantaflow/core";
import type { Backend } from "../lib/backend";
import { parseUnifiedDiff } from "../lib/diff";
import type { MergeResult, MergeStrategy, WorkspaceState } from "../lib/review";
import {
  DEMO_AGENTS,
  DEMO_HARNESSES,
  genericScript,
  RATE_LIMIT_DIFF,
  type Step,
  TEST_DIFF,
} from "./scripts";

const ROOT = "/home/you/code/acme-api";
const TICK_MS = 260;
const WORDS_PER_TICK = 3;

interface Sim {
  job: Job;
  status: SessionState;
  events: QfEvent[];
  steps: Step[];
  at: number;
  words: string[] | null;
  wordAt: number;
  messageId: string;
  waiting: string | null;
  /** The worktree diff so far, and what it becomes once the agent's edits are allowed. */
  diff: string | null;
  finalDiff: string | null;
  workspaceState: WorkspaceState;
  startAfter: number;
  /** Extra ticks to wait before the next step, so turns don't feel mechanical. */
  rest: number;
}

let counter = 0;
const demoId = (prefix: string) => `${prefix}_demo${(++counter).toString(36).padStart(4, "0")}`;

/**
 * An in-browser stand-in for the daemon. It runs scripted agents on a timer and speaks the same
 * API and stream messages, so every view can be developed and tried without installing anything.
 */
export class DemoBackend implements Backend {
  private seq = 0;
  /** Files already merged into the demo project, so a second job touching them conflicts. */
  private mergedPaths = new Set<string>();
  private clock: number | null = null;
  private readonly listeners = new Set<StreamHandlers>();
  private agentList: AgentProfile[] = structuredClone(DEMO_AGENTS);
  private readonly sims = new Map<string, Sim>();
  private readonly pending = new Map<string, PendingApproval>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.seed();
  }

  // ---- API ---------------------------------------------------------------------------------

  async state(): Promise<StateSnapshot> {
    return {
      version: "0.1.0-demo",
      root: ROOT,
      agents: structuredClone(this.agentList),
      harnesses: structuredClone(DEMO_HARNESSES),
      jobs: [...this.sims.values()].map((sim) => {
        const view = foldJob(sim.job, sim.events);
        return { ...view, job: { ...view.job, workspaceState: sim.workspaceState } };
      }),
      approvals: [...this.pending.values()],
      lastSeq: this.seq,
    };
  }

  async createAgent(input: AgentProfileInput): Promise<AgentProfile> {
    const parsed = AgentProfileInput.parse(input);
    if (this.agentList.some((agent) => agent.id === parsed.id)) {
      throw new QfApiError(409, `An agent with id "${parsed.id}" already exists`);
    }
    const agent: AgentProfile = { ...parsed, source: "db" };
    this.agentList = [...this.agentList, agent];
    this.broadcast({ type: "agents", agents: structuredClone(this.agentList) });
    return agent;
  }

  async updateAgent(id: string, input: AgentProfileInput): Promise<AgentProfile> {
    const existing = this.agentList.find((agent) => agent.id === id);
    if (!existing) throw new QfApiError(404, `No agent with id "${id}"`);
    if (existing.source === "file") {
      throw new QfApiError(409, "This agent is defined in a file. Edit the YAML file instead.");
    }
    const agent: AgentProfile = { ...AgentProfileInput.parse({ ...input, id }), source: "db" };
    this.agentList = this.agentList.map((a) => (a.id === id ? agent : a));
    this.broadcast({ type: "agents", agents: structuredClone(this.agentList) });
    return agent;
  }

  async deleteAgent(id: string): Promise<{ ok: true }> {
    const existing = this.agentList.find((agent) => agent.id === id);
    if (!existing) throw new QfApiError(404, `No agent with id "${id}"`);
    if (existing.source === "file") {
      throw new QfApiError(409, "This agent is defined in a file. Delete the YAML file instead.");
    }
    this.agentList = this.agentList.filter((agent) => agent.id !== id);
    this.broadcast({ type: "agents", agents: structuredClone(this.agentList) });
    return { ok: true };
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    const agent = this.agentList.find((a) => a.id === input.agentId);
    if (!agent) throw new QfApiError(404, `No agent with id "${input.agentId}"`);
    const sim = this.addJob({
      agent,
      title: input.title?.trim() || firstLine(input.prompt),
      prompt: input.prompt,
      workspace: input.workspace ?? agent.workspace,
      steps: genericScript(input.prompt, false),
      dependsOn: input.dependsOn ?? [],
      parentJobId: input.parentJobId ?? null,
      runId: input.runId ?? null,
      role: input.role ?? "worker",
    });
    sim.startAfter = Date.now() + 700;
    this.ensureTicking();
    return structuredClone(sim.job);
  }

  async events(jobId: string, after = 0): Promise<{ events: QfEvent[] }> {
    const sim = this.sims.get(jobId);
    if (!sim) throw new QfApiError(404, `No job with id "${jobId}"`);
    return { events: sim.events.filter((event) => event.seq > after) };
  }

  async sendMessage(jobId: string, text: string): Promise<{ ok: true }> {
    const sim = this.require(jobId);
    if (sim.status === "working" || sim.status === "starting" || sim.status === "needs_input") {
      throw new QfApiError(
        409,
        "The agent is in the middle of a turn. Send this when it finishes.",
      );
    }
    if (sim.status === "failed" || sim.status === "cancelled" || sim.status === "queued") {
      throw new QfApiError(409, "This job can't take messages in its current state.");
    }
    this.emit(sim, { type: "message", role: "user", text });
    this.setState(sim, "working");
    sim.steps = [...sim.steps.slice(0, sim.at), ...genericScript(text, true)];
    this.ensureTicking();
    return { ok: true };
  }

  async cancelJob(jobId: string): Promise<{ ok: true }> {
    const sim = this.require(jobId);
    if (TERMINAL_STATES.has(sim.status)) return { ok: true };
    for (const approval of [...this.pending.values()]) {
      if (approval.jobId !== jobId) continue;
      this.pending.delete(approval.id);
      this.emit(sim, {
        type: "permission.resolved",
        approvalId: approval.id,
        outcome: "cancelled",
        by: "system",
        reason: "The job was cancelled",
      });
    }
    sim.waiting = null;
    this.setState(sim, "cancelled", "Cancelled by you");
    return { ok: true };
  }

  async merge(jobId: string, body: { strategy: MergeStrategy }): Promise<MergeResult> {
    const sim = this.require(jobId);
    if (sim.job.workspace !== "worktree") {
      throw new QfApiError(400, "Only jobs with their own git worktree can be merged.");
    }
    const refuse = (reason: string, conflicts?: string[]) => {
      throw new QfApiError(409, reason, { reason, ...(conflicts ? { conflicts } : {}) });
    };
    if (sim.workspaceState !== "active")
      refuse(`This job's workspace was already ${sim.workspaceState}.`);
    if (!STOPPABLE.has(sim.status))
      refuse("The job is still running. Wait for it to stop, or cancel it.");
    const paths = parseUnifiedDiff(sim.diff ?? "").map((file) => file.path);
    if (paths.length === 0) refuse("The job's branch has no changes to merge.");
    const conflicts = paths.filter((path) => this.mergedPaths.has(path));
    if (conflicts.length > 0) {
      refuse("The merge has conflicts with work already merged into main.", conflicts);
    }
    for (const path of paths) this.mergedPaths.add(path);
    const commit = Array.from({ length: 40 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
    sim.workspaceState = "merged";
    this.emit(sim, {
      type: "workspace.merged",
      commit,
      into: "main",
      strategy: body.strategy,
    } as unknown as QfEventData);
    return { commit, into: "main" };
  }

  async discard(jobId: string): Promise<{ ok: true }> {
    const sim = this.require(jobId);
    if (sim.job.workspace === "cwd") {
      throw new QfApiError(
        400,
        "This job works in the project root, so there is nothing to discard.",
      );
    }
    if (!STOPPABLE.has(sim.status)) {
      throw new QfApiError(409, "The job is still running. Cancel it first.");
    }
    sim.workspaceState = "discarded";
    sim.diff = null;
    this.emit(sim, { type: "workspace.discarded" } as unknown as QfEventData);
    return { ok: true };
  }

  async diff(jobId: string): Promise<DiffResult> {
    const sim = this.require(jobId);
    if (sim.job.workspace !== "worktree") {
      return {
        available: false,
        diff: "",
        reason: "This job runs in a plain folder, not a git worktree, so there is no diff.",
      };
    }
    if (sim.status === "queued") {
      return {
        available: false,
        diff: "",
        reason: "The job hasn't started, so nothing changed yet.",
      };
    }
    return { available: true, diff: sim.diff ?? "" };
  }

  async decide(approvalId: string, decision: ApprovalDecision["decision"]): Promise<{ ok: true }> {
    const approval = this.pending.get(approvalId);
    if (!approval) throw new QfApiError(404, "That request was already answered or withdrawn.");
    const sim = this.require(approval.jobId);
    this.pending.delete(approvalId);
    const allowed = decision !== "deny";
    const option = approval.options.find((o) =>
      decision === "allow_always"
        ? o.kind === "allow_always"
        : decision === "allow"
          ? o.kind === "allow_once"
          : o.kind === "reject_once",
    );
    this.emit(sim, {
      type: "permission.resolved",
      approvalId,
      outcome: allowed ? "allowed" : "denied",
      ...(option ? { optionId: option.optionId } : {}),
      by: "user",
    });
    const step = sim.steps[sim.at];
    if (step?.t === "tool") {
      this.emit(sim, {
        type: "tool.update",
        toolCallId: `${sim.job.id}-${step.id}`,
        status: allowed ? "completed" : "failed",
        ...(allowed && step.output ? { output: step.output } : {}),
        ...(allowed ? {} : { output: "Denied by you" }),
      });
      if (allowed && sim.job.workspace === "worktree" && !sim.diff) {
        if (sim.finalDiff) sim.diff = sim.finalDiff;
        else if (step.diffs) sim.diff = notesDiff(step.diffs[0]?.newText ?? "");
      }
    }
    sim.waiting = null;
    sim.at += 1;
    if (!allowed) {
      sim.steps.splice(sim.at, 0, {
        t: "say",
        text: "Understood, I'll skip that step and carry on without it.\n\n",
      });
    }
    this.setState(sim, "working");
    sim.rest = 2;
    this.ensureTicking();
    return { ok: true };
  }

  subscribe(handlers: StreamHandlers): { close: () => void } {
    let open = true;
    setTimeout(() => {
      if (!open) return;
      this.listeners.add(handlers);
      handlers.onOpen?.();
      handlers.onMessage({ type: "hello", lastSeq: this.seq, version: "0.1.0-demo" });
      this.ensureTicking();
    }, 60);
    return {
      close: () => {
        if (!open) return;
        open = false;
        this.listeners.delete(handlers);
        setTimeout(() => handlers.onClose?.({ code: 1000, reason: "closed" }), 0);
      },
    };
  }

  // ---- Engine ------------------------------------------------------------------------------

  private require(jobId: string): Sim {
    const sim = this.sims.get(jobId);
    if (!sim) throw new QfApiError(404, `No job with id "${jobId}"`);
    return sim;
  }

  private now(): number {
    return this.clock ?? Date.now();
  }

  private broadcast(message: StreamMessage): void {
    for (const listener of this.listeners) listener.onMessage(message);
  }

  private emit(sim: Sim, data: QfEventData): void {
    const event = { ...data, seq: ++this.seq, ts: this.now(), jobId: sim.job.id } as QfEvent;
    sim.events.push(event);
    this.broadcast({ type: "event", event });
  }

  private setState(sim: Sim, state: SessionState, reason?: string): void {
    if (sim.status === state) return;
    sim.status = state;
    this.emit(sim, { type: "job.state", state, ...(reason ? { reason } : {}) });
  }

  private addJob(spec: {
    agent: AgentProfile;
    title: string;
    prompt: string;
    workspace: Job["workspace"];
    steps: Step[];
    dependsOn?: string[];
    parentJobId?: string | null;
    runId?: string | null;
    role?: Job["role"];
    diff?: string;
  }): Sim {
    const id = demoId("job");
    const ts = this.now();
    const job: Job = {
      id,
      title: spec.title,
      prompt: spec.prompt,
      agentId: spec.agent.id,
      harness: spec.agent.harness,
      workspace: spec.workspace,
      workspacePath: null,
      branch: null,
      baseRef: null,
      portBase: null,
      status: "queued",
      error: null,
      createdAt: ts,
      updatedAt: ts,
      runId: spec.runId ?? null,
      parentJobId: spec.parentJobId ?? null,
      dependsOn: spec.dependsOn ?? [],
      role: spec.role ?? "worker",
      workspaceState: "active",
    };
    const sim: Sim = {
      job,
      status: "queued",
      events: [],
      steps: spec.steps,
      at: 0,
      words: null,
      wordAt: 0,
      messageId: "",
      waiting: null,
      diff: null,
      finalDiff: spec.diff ?? null,
      workspaceState: "active",
      startAfter: 0,
      rest: 0,
    };
    this.sims.set(id, sim);
    this.emit(sim, { type: "job.created", job });
    return sim;
  }

  private start(sim: Sim): void {
    this.setState(sim, "starting");
    const { job } = sim;
    const patch: Extract<QfEventData, { type: "job.updated" }>["patch"] =
      job.workspace === "worktree"
        ? {
            workspacePath: `${ROOT}/.quantaflow/state/worktrees/${job.id}`,
            branch: `qf/${job.id}`,
            baseRef: "9c41e2a",
            portBase: 41000 + (Number.parseInt(job.id.slice(-2), 36) % 40) * 10,
          }
        : job.workspace === "folder"
          ? { workspacePath: `${ROOT}/.quantaflow/state/workspaces/${job.id}` }
          : { workspacePath: ROOT };
    this.emit(sim, { type: "job.updated", patch });
    this.emit(sim, { type: "message", role: "user", text: job.prompt });
    this.setState(sim, "working");
  }

  private ensureTicking(): void {
    if (this.timer || this.clock !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    let active = false;
    for (const sim of this.sims.values()) {
      if (sim.status === "queued") {
        const deps = sim.job.dependsOn.map((id) => this.sims.get(id)?.status);
        if (deps.some((s) => s === "failed" || s === "cancelled")) {
          this.setState(sim, "failed", "A job it depends on did not finish");
          continue;
        }
        if (deps.every((s) => s === "done") && Date.now() >= sim.startAfter) this.start(sim);
        active = true;
        continue;
      }
      if (sim.status !== "working" || sim.waiting) continue;
      if (sim.at >= sim.steps.length) continue;
      active = true;
      if (sim.rest > 0) {
        sim.rest -= 1;
        continue;
      }
      this.advance(sim);
    }
    if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one beat of a sim's script. */
  private advance(sim: Sim, instant = false): void {
    const step = sim.steps[sim.at];
    if (!step) return;
    switch (step.t) {
      case "say": {
        if (!sim.words) {
          sim.words = step.text.split(/(?<=\s)/);
          sim.wordAt = 0;
          sim.messageId = demoId("msg");
        }
        const size = instant ? sim.words.length : WORDS_PER_TICK;
        const text = sim.words.slice(sim.wordAt, sim.wordAt + size).join("");
        sim.wordAt += size;
        this.emit(sim, { type: "message", role: "agent", text, messageId: sim.messageId });
        if (sim.wordAt >= sim.words.length) {
          sim.words = null;
          sim.at += 1;
          sim.rest = 1;
        }
        return;
      }
      case "think":
        this.emit(sim, { type: "message", role: "thought", text: step.text });
        break;
      case "plan":
        this.emit(sim, {
          type: "plan",
          entries: step.entries.map((content, i) => ({
            content,
            priority: "medium",
            status: i < step.done ? "completed" : i === step.done ? "in_progress" : "pending",
          })),
        });
        break;
      case "tool": {
        const toolCallId = `${sim.job.id}-${step.id}`;
        this.emit(sim, {
          type: "tool.call",
          toolCallId,
          title: step.title,
          kind: step.kind,
          status: "pending",
          locations: step.locations ?? [],
          ...(step.input !== undefined ? { input: step.input } : {}),
        });
        if (step.approval) {
          const approvalId = demoId("ap");
          const options = [
            { optionId: "allow", name: "Allow", kind: "allow_once" as const },
            { optionId: "always", name: "Always allow", kind: "allow_always" as const },
            { optionId: "reject", name: "Reject", kind: "reject_once" as const },
          ];
          this.emit(sim, {
            type: "permission.requested",
            approvalId,
            toolCallId,
            title: step.title,
            kind: step.kind,
            options,
            ...(step.input !== undefined ? { input: step.input } : {}),
          });
          if (step.approval === "ask") {
            this.pending.set(approvalId, {
              id: approvalId,
              jobId: sim.job.id,
              title: step.title,
              kind: step.kind,
              options,
              input: step.input,
              createdAt: this.now(),
            });
            sim.waiting = approvalId;
            this.setState(sim, "needs_input");
            return;
          }
          this.emit(sim, {
            type: "permission.resolved",
            approvalId,
            outcome: "allowed",
            optionId: "allow",
            by: "policy",
            reason: step.policyReason ?? "Allowed by policy",
          });
        }
        this.emit(sim, {
          type: "tool.update",
          toolCallId,
          status: "completed",
          ...(step.output ? { output: step.output } : {}),
          ...(step.diffs ? { diffs: step.diffs } : {}),
        });
        break;
      }
      case "usage":
        this.emit(sim, {
          type: "usage",
          usage: {
            used: step.used,
            size: step.size,
            cost: step.cost === undefined ? null : { amount: step.cost, currency: "USD" },
          },
        });
        break;
      case "log":
        this.emit(sim, { type: "log", stream: "stderr", text: step.text });
        break;
      case "notice":
        this.emit(sim, {
          type: "notice",
          severity: step.severity,
          title: step.title,
          ...(step.description ? { description: step.description } : {}),
        });
        break;
      case "end":
        if (sim.finalDiff && !sim.diff) sim.diff = sim.finalDiff;
        if (step.state !== "failed") this.emit(sim, { type: "turn.ended", stopReason: "end_turn" });
        this.setState(sim, step.state, step.reason);
        break;
    }
    sim.at += 1;
  }

  /** Plays a sim forward instantly from `from` minutes ago, a few seconds per beat. */
  private replay(sim: Sim, minutesAgo: number, untilStep = Number.POSITIVE_INFINITY): void {
    let ts = Date.now() - minutesAgo * 60_000;
    this.clock = ts;
    if (sim.status === "queued") this.start(sim);
    while (sim.at < sim.steps.length && sim.at < untilStep && !sim.waiting) {
      if (TERMINAL_STATES.has(sim.status)) break;
      ts += 4000 + ((sim.at * 2731) % 9000);
      this.clock = ts;
      this.advance(sim, true);
    }
    this.clock = null;
  }

  private seed(): void {
    const agent = (id: string) => this.agentList.find((a) => a.id === id) as AgentProfile;
    const runId = "run_demo_ship";

    // An orchestrated run: Lead split "rate limiting" into three jobs with dependencies.
    this.clock = Date.now() - 26 * 60_000;
    const lead = this.addJob({
      agent: agent("lead"),
      title: "Ship rate limiting on the login route",
      prompt: "Add rate limiting to POST /login with tests and a review before merge.",
      workspace: "cwd",
      runId,
      role: "orchestrator",
      steps: [
        {
          t: "say",
          text: "I'll split this into three jobs: the middleware, its tests, then a review.\n\n",
        },
        {
          t: "plan",
          entries: ["Build the middleware", "Write tests", "Review", "Merge"],
          done: 0,
        },
        {
          t: "tool",
          id: "spawn1",
          title: "Start job: Add rate limiting middleware",
          kind: "other",
        },
        { t: "tool", id: "spawn2", title: "Start job: Write tests for the limit", kind: "other" },
        { t: "tool", id: "spawn3", title: "Start job: Review the change", kind: "other" },
        { t: "usage", used: 41_200, size: 200_000, cost: 0.21 },
        { t: "say", text: "All three are queued. I'll check back as each one finishes." },
      ],
    });
    const build = this.addJob({
      agent: agent("builder"),
      title: "Add rate limiting middleware to POST /login",
      prompt: "Add a fixed-window rate limit to POST /login: 5 attempts a minute per IP.",
      workspace: "worktree",
      runId,
      parentJobId: lead.job.id,
      diff: RATE_LIMIT_DIFF,
      steps: [
        { t: "say", text: "Looking at how the login route is wired before adding anything.\n\n" },
        { t: "plan", entries: ["Read the route", "Add middleware", "Run the tests"], done: 0 },
        {
          t: "tool",
          id: "read",
          title: "Read src/routes/login.ts",
          kind: "read",
          locations: ["src/routes/login.ts"],
          input: { file_path: "src/routes/login.ts" },
          approval: "policy",
          policyReason: "Reads run freely under the safe preset",
        },
        {
          t: "tool",
          id: "grep",
          title: "Search for existing limiter code",
          kind: "search",
          input: { pattern: "rateLimit|limiter", path: "src" },
          output: "No matches",
          approval: "policy",
          policyReason: "Searches run freely under the safe preset",
        },
        {
          t: "think",
          text: "No limiter yet. A small in-memory fixed window is enough for one process.",
        },
        { t: "usage", used: 22_800, size: 200_000, cost: 0.06 },
        {
          t: "tool",
          id: "edit",
          title: "Edit src/routes/login.ts and add src/middleware/rate-limit.ts",
          kind: "edit",
          locations: ["src/routes/login.ts", "src/middleware/rate-limit.ts"],
          input: {
            file_path: "src/middleware/rate-limit.ts",
            content:
              "export function rateLimit({ windowMs, max, key }: Options) {\n  const hits = new Map();\n  ...",
          },
          output: "Edited 2 files",
          approval: "ask",
        },
        { t: "plan", entries: ["Read the route", "Add middleware", "Run the tests"], done: 2 },
        {
          t: "tool",
          id: "test",
          title: "Run pnpm test",
          kind: "execute",
          input: { command: "pnpm test -- --run test/login" },
          output:
            " ✓ test/login.test.ts (4 tests) 63ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)",
          approval: "ask",
        },
        { t: "usage", used: 31_500, size: 200_000, cost: 0.11 },
        {
          t: "say",
          text: "The limit is in place: five attempts a minute per IP, then a 429 with a Retry-After header. Tests pass.",
        },
        { t: "end", state: "done" },
      ],
    });
    const tests = this.addJob({
      agent: agent("builder"),
      title: "Write tests for the login rate limit",
      prompt: "Write tests proving POST /login allows 5 attempts a minute and blocks the 6th.",
      workspace: "worktree",
      runId,
      parentJobId: lead.job.id,
      dependsOn: [build.job.id],
      diff: TEST_DIFF,
      steps: genericScript("Write tests for the login rate limit and run them", false),
    });
    this.addJob({
      agent: agent("reviewer"),
      title: "Review the rate limiting change",
      prompt: "Review the middleware and tests. Flag anything unsafe before merge.",
      workspace: "worktree",
      runId,
      parentJobId: lead.job.id,
      dependsOn: [build.job.id, tests.job.id],
      steps: genericScript("Review the rate limiting change readonly", false),
    });

    this.replay(lead, 25);
    this.replay(build, 21);

    // Independent jobs, in assorted states.
    this.clock = Date.now() - 18 * 60_000;
    const research = this.addJob({
      agent: agent("researcher"),
      title: "Compare the ACP adapters for Claude Code and Codex",
      prompt: "Compare the Claude Code and Codex ACP adapters: features, gaps, release cadence.",
      workspace: "folder",
      steps: [
        { t: "say", text: "Starting with each adapter's README and recent releases.\n\n" },
        {
          t: "plan",
          entries: ["Read both READMEs", "Check releases", "Write the comparison"],
          done: 0,
        },
        {
          t: "tool",
          id: "fetch",
          title: "Fetch github.com/agentclientprotocol/claude-agent-acp/releases",
          kind: "fetch",
          input: { url: "https://github.com/agentclientprotocol/claude-agent-acp/releases" },
          output: "12 releases since June",
          approval: "ask",
        },
        { t: "usage", used: 64_000, size: 1_000_000 },
        {
          t: "say",
          text: "Both adapters cover prompts, tool calls and permission requests. Codex's adapter lags on plan updates. I put the full table in comparison.md.",
        },
        { t: "end", state: "idle" },
      ],
    });
    this.replay(research, 17);

    this.clock = Date.now() - 95 * 60_000;
    const notes = this.addJob({
      agent: agent("writer"),
      title: "Draft the v0.2 release notes",
      prompt: "Draft release notes for v0.2 from the merged PRs since v0.1.",
      workspace: "folder",
      steps: [
        { t: "say", text: "Reading the merged PRs since v0.1.\n\n" },
        {
          t: "tool",
          id: "read",
          title: "Read CHANGELOG.md",
          kind: "read",
          input: { file_path: "CHANGELOG.md" },
          approval: "policy",
          policyReason: "Reads run freely under the safe preset",
        },
        {
          t: "tool",
          id: "write",
          title: "Write release-notes-v0.2.md",
          kind: "edit",
          input: {
            file_path: "release-notes-v0.2.md",
            content: "# v0.2\n\n- Login rate limiting\n...",
          },
          output: "Wrote 1 file",
        },
        { t: "usage", used: 12_300, size: 200_000, cost: 0.03 },
        {
          t: "say",
          text: "Draft is in release-notes-v0.2.md: four features, two fixes, one breaking change.",
        },
        { t: "end", state: "done" },
      ],
    });
    this.replay(notes, 94);

    this.clock = Date.now() - 52 * 60_000;
    const ops = this.addJob({
      agent: agent("ops"),
      title: "Rotate the staging TLS certificate",
      prompt: "Rotate the staging TLS certificate and restart the edge proxy.",
      workspace: "cwd",
      steps: [
        {
          t: "notice",
          severity: "error",
          title: "Kilo Code is not installed",
          description: "Install it with `npm i -g @kilocode/cli`, then retry the job.",
        },
        { t: "log", text: "spawn kilo ENOENT" },
        { t: "end", state: "failed", reason: "kilo was not found on PATH" },
      ],
    });
    this.replay(ops, 51);

    this.clock = Date.now() - 40 * 60_000;
    const settings = this.addJob({
      agent: agent("builder"),
      title: "Move the settings page to the new form library",
      prompt: "Migrate src/pages/settings to the new form library. Keep the validation rules.",
      workspace: "worktree",
      diff: RATE_LIMIT_DIFF.split("diff --git a/src/middleware")[0] ?? "",
      steps: [
        { t: "say", text: "I migrated the profile and notification sections.\n\n" },
        { t: "usage", used: 88_000, size: 200_000, cost: 0.34 },
        {
          t: "say",
          text: "The billing section uses a custom date input the new library doesn't support. Should I wrap it, or leave billing on the old forms for now?",
        },
        { t: "end", state: "idle" },
      ],
    });
    this.replay(settings, 39);

    this.clock = Date.now() - 140 * 60_000;
    const flaky = this.addJob({
      agent: agent("builder"),
      title: "Fix the flaky websocket reconnect test",
      prompt: "test/ws-reconnect.test.ts fails about one run in ten. Find out why and fix it.",
      workspace: "worktree",
      steps: [{ t: "say", text: "Running it in a loop to reproduce.\n\n" }],
    });
    this.replay(flaky, 139);
    this.clock = Date.now() - 131 * 60_000;
    this.setState(flaky, "cancelled", "Cancelled by you");
    this.clock = null;
  }
}

const STOPPABLE = new Set<SessionState>(["done", "idle", "failed", "cancelled"]);

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || "Untitled job";
}

function notesDiff(content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    "diff --git a/NOTES.md b/NOTES.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/NOTES.md",
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}
