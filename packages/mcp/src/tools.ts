import {
  buildTranscript,
  type JobView,
  QfApiError,
  type QfClient,
  type SessionState,
  type TranscriptItem,
} from "@quantaflow/core";
import { z } from "zod";

/** Who is calling: the orchestrator job these tools act for. */
export interface OrchestratorContext {
  client: QfClient;
  /** The orchestrator's own job id. Every job it creates is its child. */
  parentJobId: string;
  /** Groups the orchestrator and its workers. Defaults to the parent job id. */
  runId?: string;
  /** How often `wait_for_jobs` checks, in milliseconds. */
  pollMs?: number;
}

export interface ToolResult {
  /** The text the model reads. */
  text: string;
  /** The same result as data, for clients that read structured content. */
  data: Record<string, unknown>;
  isError?: boolean;
}

/** A mistake the model can fix, such as a job id it doesn't own. Returned, never thrown. */
export class ToolError extends Error {}

/** A job stops needing attention in these states: its turn is over. */
const SETTLED: ReadonlySet<SessionState> = new Set(["done", "idle", "failed", "cancelled"]);
const MAX_REPLY_CHARS = 8_000;
const MAX_DIFF_CHARS = 20_000;
const MAX_WAIT_SECONDS = 600;

const JobId = z.string().min(1).max(64).describe("A job id from create_job, such as job_ab12cd34");

const inputs = {
  list_agents: z.object({}),
  create_job: z.object({
    agentId: z.string().min(1).max(64).describe("The worker agent's id, from list_agents"),
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The full task. The worker sees only this, so include all the context it needs"),
    title: z.string().max(120).optional().describe("A short title shown in the job list"),
    dependsOn: z
      .array(JobId)
      .max(20)
      .optional()
      .describe("Jobs that must finish successfully first. The job waits in the queue until then"),
  }),
  get_job: z.object({
    jobId: JobId,
    includeDiff: z
      .boolean()
      .optional()
      .describe("Also return the job's full diff against its starting point"),
  }),
  wait_for_jobs: z.object({
    jobIds: z.array(JobId).min(1).max(20),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe("Give up after this long and report where each job is. Default 300"),
  }),
  send_message: z.object({
    jobId: JobId,
    text: z.string().min(1).max(50_000).describe("A follow-up instruction for the worker"),
  }),
  cancel_job: z.object({ jobId: JobId }),
} as const;

export type ToolName = keyof typeof inputs;

const descriptions: Record<ToolName, string> = {
  list_agents:
    "List the worker agents you can give jobs to, with what each is for and which harness runs it.",
  create_job:
    "Start a worker job: one agent working on one task in its own workspace. Returns the job id right away; the job runs in the background. Use wait_for_jobs to wait for it.",
  get_job:
    "Get a job's status, its latest reply, the files it changed and whether it is waiting on a person's approval.",
  wait_for_jobs:
    "Wait until every listed job has finished its turn (done, failed or cancelled), or until one starts waiting on a person's approval, or until the timeout. Calling it again keeps waiting through approvals already reported. Returns each job's status and latest reply.",
  send_message:
    "Send a follow-up to a worker job, for example to ask for a fix. It reopens a finished job in the same workspace.",
  cancel_job: "Stop a worker job.",
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(inputs) as ToolName[]).map((name) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(inputs[name]) as Record<
      string,
      unknown
    >;
    return {
      name,
      description: descriptions[name],
      inputSchema: { ...schema, type: "object" },
    };
  });
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
    : text;
}

/** Keeps the end, where an agent usually sums up. */
function clipStart(text: string, max: number): string {
  return text.length > max
    ? `… (${text.length - max} earlier characters)\n${text.slice(-max)}`
    : text;
}

/** Everything the agent said since the last user message: its answer to the latest turn. */
export function latestReply(items: readonly TranscriptItem[]): string {
  const parts: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "message") continue;
    if (item.role === "user") break;
    if (item.role === "agent" && item.text.trim()) parts.unshift(item.text.trim());
  }
  return parts.join("\n\n");
}

/** Files named in a unified diff, in order. */
export function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files];
}

interface JobSummary {
  jobId: string;
  title: string;
  agentId: string;
  status: SessionState;
  error: string | null;
  waitingForApproval: boolean;
  reply: string;
  changedFiles: string[];
  branch: string | null;
}

/** Runs the orchestrator tools against the daemon, limited to the jobs this orchestrator made. */
export class OrchestratorTools {
  private readonly runId: string;
  private readonly pollMs: number;
  /** Jobs whose wait for approval wait_for_jobs already reported. */
  private readonly reportedWaiting = new Set<string>();

  constructor(private readonly ctx: OrchestratorContext) {
    this.runId = ctx.runId || ctx.parentJobId;
    this.pollMs = ctx.pollMs ?? 1_000;
  }

  async call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      if (!(name in inputs)) throw new ToolError(`Unknown tool "${name}"`);
      const schema = inputs[name as ToolName];
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(
          `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
        );
      }
      switch (name as ToolName) {
        case "list_agents":
          return await this.listAgents();
        case "create_job":
          return await this.createJob(parsed.data as z.infer<typeof inputs.create_job>);
        case "get_job":
          return await this.getJob(parsed.data as z.infer<typeof inputs.get_job>);
        case "wait_for_jobs":
          return await this.waitForJobs(
            parsed.data as z.infer<typeof inputs.wait_for_jobs>,
            signal,
          );
        case "send_message":
          return await this.sendMessage(parsed.data as z.infer<typeof inputs.send_message>);
        case "cancel_job":
          return await this.cancelJob(parsed.data as z.infer<typeof inputs.cancel_job>);
      }
    } catch (error) {
      if (error instanceof ToolError || error instanceof QfApiError) {
        return { text: error.message, data: { error: error.message }, isError: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: `Could not reach the QuantaFlow daemon: ${message}`,
        data: { error: message },
        isError: true,
      };
    }
    throw new ToolError(`Unknown tool "${name}"`);
  }

  private async listAgents(): Promise<ToolResult> {
    const parent = await this.ctx.client.job(this.ctx.parentJobId).catch(() => null);
    const agents = (await this.ctx.client.agents()).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      harness: a.harness,
      workspace: a.workspace,
      policy: a.policy.preset,
      /** The agent this orchestrator runs as. It can still take worker jobs. */
      self: a.id === parent?.job.agentId,
    }));
    const text = agents.length
      ? agents
          .map(
            (a) =>
              `- ${a.id} (${a.name}, ${a.harness}, ${a.policy} policy${a.self ? ", that's you" : ""})${a.description ? `: ${a.description}` : ""}`,
          )
          .join("\n")
      : "No agents are defined. Ask the person to add one under .quantaflow/agents/.";
    return { text, data: { agents } };
  }

  private async createJob(input: z.infer<typeof inputs.create_job>): Promise<ToolResult> {
    for (const dep of input.dependsOn ?? []) await this.ownJob(dep);
    const job = await this.ctx.client.createJob({
      agentId: input.agentId,
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      parentJobId: this.ctx.parentJobId,
      runId: this.runId,
      role: "worker",
    });
    return {
      text: `Started ${job.id} (${job.agentId}): ${job.title}. It runs in the background; use wait_for_jobs to wait for it.`,
      data: { jobId: job.id, title: job.title, agentId: job.agentId, status: job.status },
    };
  }

  private async getJob(input: z.infer<typeof inputs.get_job>): Promise<ToolResult> {
    const view = await this.ownJob(input.jobId);
    const { summary, diff } = await this.summarize(view);
    let text = describe(summary);
    const data: Record<string, unknown> = { ...summary };
    if (input.includeDiff) {
      const clipped = diff ? clip(diff, MAX_DIFF_CHARS) : "";
      text += clipped ? `\n\nDiff:\n${clipped}` : "\n\nNo changes.";
      data.diff = clipped;
    }
    return { text, data };
  }

  private async waitForJobs(
    input: z.infer<typeof inputs.wait_for_jobs>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const ids = [...new Set(input.jobIds)];
    for (const id of ids) await this.ownJob(id);
    const deadline = Date.now() + (input.timeoutSeconds ?? 300) * 1_000;
    let views: JobView[] = [];
    let timedOut = false;
    for (;;) {
      views = await Promise.all(ids.map((id) => this.ctx.client.job(id)));
      const settled = views.every((v) => SETTLED.has(v.job.status));
      for (const v of views) {
        if (v.job.status !== "needs_input") this.reportedWaiting.delete(v.job.id);
      }
      // Return once when a job starts waiting on a person, not on every call while it waits,
      // so calling again really waits instead of returning at once.
      const newlyBlocked = views.filter(
        (v) => v.job.status === "needs_input" && !this.reportedWaiting.has(v.job.id),
      );
      for (const v of newlyBlocked) this.reportedWaiting.add(v.job.id);
      if (settled || newlyBlocked.length) break;
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())), signal);
    }
    const summaries = await Promise.all(views.map(async (v) => (await this.summarize(v)).summary));
    const waiting = summaries.filter((s) => s.waitingForApproval).map((s) => s.jobId);
    const head = timedOut
      ? "Timed out. Some jobs are still running; call wait_for_jobs again to keep waiting."
      : waiting.length
        ? `${waiting.join(", ")} ${waiting.length === 1 ? "is" : "are"} waiting for a person to approve a step. Call wait_for_jobs again to wait until it is decided and the jobs finish.`
        : "All jobs have finished their turn.";
    return {
      text: [head, ...summaries.map(describe)].join("\n\n"),
      data: { timedOut, waitingForApproval: waiting, jobs: summaries },
    };
  }

  private async sendMessage(input: z.infer<typeof inputs.send_message>): Promise<ToolResult> {
    await this.ownJob(input.jobId);
    await this.ctx.client.sendMessage(input.jobId, input.text);
    return {
      text: `Sent. ${input.jobId} is working on it; use wait_for_jobs to wait for its reply.`,
      data: { jobId: input.jobId, ok: true },
    };
  }

  private async cancelJob(input: z.infer<typeof inputs.cancel_job>): Promise<ToolResult> {
    await this.ownJob(input.jobId);
    await this.ctx.client.cancelJob(input.jobId);
    return { text: `Cancelling ${input.jobId}.`, data: { jobId: input.jobId, ok: true } };
  }

  /** The job, if this orchestrator created it. Other jobs belong to the person. */
  private async ownJob(jobId: string): Promise<JobView> {
    let view: JobView;
    try {
      view = await this.ctx.client.job(jobId);
    } catch (error) {
      if (error instanceof QfApiError && error.status === 404) {
        throw new ToolError(`No job "${jobId}".`);
      }
      throw error;
    }
    if (view.job.parentJobId !== this.ctx.parentJobId) {
      throw new ToolError(`${jobId} was not started by you, so you can't use it here.`);
    }
    return view;
  }

  private async summarize(view: JobView): Promise<{ summary: JobSummary; diff: string }> {
    const { job } = view;
    const [{ events }, diff] = await Promise.all([
      this.ctx.client.events(job.id, 0),
      this.ctx.client.diff(job.id).catch(() => ({ available: false, diff: "" })),
    ]);
    const reply = latestReply(buildTranscript(events));
    return {
      summary: {
        jobId: job.id,
        title: job.title,
        agentId: job.agentId,
        status: job.status,
        error: job.error,
        waitingForApproval: job.status === "needs_input" || view.pendingApprovals > 0,
        reply: clipStart(reply, MAX_REPLY_CHARS),
        changedFiles: diff.available ? changedFiles(diff.diff) : [],
        branch: job.branch,
      },
      diff: diff.available ? diff.diff : "",
    };
  }
}

function describe(s: JobSummary): string {
  const lines = [`${s.jobId} · ${s.agentId} · ${s.status}${s.error ? ` (${s.error})` : ""}`];
  lines.push(`Title: ${s.title}`);
  if (s.waitingForApproval) lines.push("Waiting for a person to approve a step.");
  if (s.changedFiles.length) {
    lines.push(
      `Changed files${s.branch ? ` on ${s.branch}` : ""}: ${s.changedFiles.slice(0, 30).join(", ")}${s.changedFiles.length > 30 ? " …" : ""}`,
    );
  }
  lines.push(s.reply ? `Latest reply:\n${s.reply}` : "No reply yet.");
  return lines.join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
