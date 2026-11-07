/**
 * The demo orchestrator script. It connects to the QuantaFlow MCP server the client passed in
 * session/new, starts two worker jobs (the second waits for the first), waits for them and
 * reports what they did. It shows the orchestrator flow end to end without a model.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface OrchestrateContext {
  mcpServers: acp.McpServer[];
  /** The text the person asked for. */
  task: string;
  readonly: boolean;
  signal: AbortSignal;
  update: (u: acp.SessionUpdate) => Promise<void>;
  say: (text: string) => Promise<void>;
  pause: () => Promise<void>;
}

interface ToolOutput {
  text: string;
  data: Record<string, unknown>;
  isError: boolean;
}

interface AgentRow {
  id: string;
  harness: string;
}

interface JobRow {
  jobId: string;
  status: string;
  reply: string;
  changedFiles: string[];
  waitingForApproval: boolean;
}

const MAX_WAITS = 30;

export async function orchestrate(ctx: OrchestrateContext): Promise<void> {
  const server = ctx.mcpServers.find(
    (s): s is acp.McpServerStdio => "command" in s && s.name === "quantaflow",
  );
  if (!server) {
    await ctx.say(
      "I was asked to orchestrate, but no QuantaFlow tools were connected. Run this job as an orchestrator, for example with `qf run --orchestrate`.",
    );
    return;
  }

  const client = new Client({ name: "quantaflow-fake-agent", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
    stderr: "ignore",
  });
  await client.connect(transport);
  const onAbort = () => void client.close();
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  // Workers are demo agents too, so keep the keywords that steer them out of their prompts.
  const about = ctx.task.replace(/\b(orchestrat\w*|readonly|slow|fail\w*|run|test\w*)\b/gi, "…");
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>, title: string) => {
    const toolCallId = `qf-${++calls}`;
    await ctx.update({
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: "other",
      status: "in_progress",
      rawInput: { tool: `quantaflow.${name}`, ...args },
    });
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const output: ToolOutput = {
      text: (result.content ?? []).map((c) => c.text ?? "").join("\n"),
      data: result.structuredContent ?? {},
      isError: result.isError === true,
    };
    await ctx.update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: output.isError ? "failed" : "completed",
      content: [{ type: "content", content: { type: "text", text: output.text } }],
    });
    return output;
  };

  try {
    const steps = ["Find worker agents", "Start the workers", "Wait for results", "Report back"];
    const plan = (done: number): acp.SessionUpdate => ({
      sessionUpdate: "plan",
      entries: steps.map((content, i) => ({
        content,
        priority: "medium",
        status: i < done ? "completed" : i === done ? "in_progress" : "pending",
      })),
    });

    await ctx.update(plan(0));
    const listed = await call("list_agents", {}, "List worker agents");
    const agents = (listed.data.agents as AgentRow[] | undefined) ?? [];
    const worker = agents.find((a) => a.harness === "fake") ?? agents[0];
    if (!worker) {
      await ctx.say("There are no worker agents to hand the work to, so I stopped here.");
      return;
    }
    await ctx.say(`I'll split this between two ${worker.id} jobs. `);
    await ctx.pause();

    await ctx.update(plan(1));
    const first = await call(
      "create_job",
      {
        agentId: worker.id,
        title: "Survey the workspace",
        prompt: `Look through the workspace and report what is there, readonly. This is part of: ${about}`,
      },
      `Start ${worker.id}: Survey the workspace`,
    );
    const firstId = first.data.jobId as string | undefined;
    if (!firstId) throw new Error(first.text);
    const second = await call(
      "create_job",
      {
        agentId: worker.id,
        title: "Write up the findings",
        prompt: `Write up the findings from the survey${ctx.readonly ? ", readonly" : ""}. This is part of: ${about}`,
        dependsOn: [firstId],
      },
      `Start ${worker.id}: Write up the findings, after ${firstId}`,
    );
    const secondId = second.data.jobId as string | undefined;
    if (!secondId) throw new Error(second.text);
    await ctx.pause();

    await ctx.update(plan(2));
    let jobs: JobRow[] = [];
    for (let i = 0; i < MAX_WAITS; i++) {
      const waited = await call(
        "wait_for_jobs",
        { jobIds: [firstId, secondId], timeoutSeconds: 120 },
        "Wait for the workers",
      );
      jobs = (waited.data.jobs as JobRow[] | undefined) ?? [];
      const waiting = (waited.data.waitingForApproval as string[] | undefined) ?? [];
      if (waiting.length === 0 && waited.data.timedOut !== true) break;
      if (waiting.length && i === 0) {
        await ctx.say(
          `${waiting.join(" and ")} needs your approval before it can go on. I'll wait. `,
        );
      }
    }

    await ctx.update(plan(3));
    const lines = jobs.map((j) => {
      const files = j.changedFiles.length ? ` Changed ${j.changedFiles.join(", ")}.` : "";
      return `- ${j.jobId}: ${j.status}.${files}`;
    });
    const ok = jobs.length > 0 && jobs.every((j) => j.status === "done" || j.status === "idle");
    await ctx.update(plan(4));
    await ctx.say(
      `${ok ? "Both workers finished." : "The workers did not all finish."}\n\n${lines.join("\n")}\n\n`,
    );
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    await client.close().catch(() => {});
  }
}
