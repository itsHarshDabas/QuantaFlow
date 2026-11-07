import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CreateJobInput,
  type Job,
  type JobView,
  QfApiError,
  type QfClient,
  type QfEvent,
} from "@quantaflow/core";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  createMcpServer,
  latestReply,
  OrchestratorTools,
  toolDefinitions,
} from "../src/index.js";

function job(id: string, patch: Partial<Job> = {}): Job {
  return {
    id,
    title: `Title of ${id}`,
    prompt: "p",
    agentId: "worker",
    harness: "fake",
    workspace: "worktree",
    workspacePath: null,
    branch: `qf/${id}`,
    baseRef: null,
    portBase: null,
    status: "queued",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    runId: "job_lead",
    parentJobId: "job_lead",
    dependsOn: [],
    role: "worker",
    workspaceState: "active",
    ...patch,
  };
}

const view = (j: Job, pendingApprovals = 0): JobView => ({
  job: j,
  lastMessage: "",
  toolCalls: 0,
  pendingApprovals,
  usage: null,
  lastEventAt: 0,
  startedAt: null,
  endedAt: null,
});

let seq = 0;
const message = (jobId: string, role: "user" | "agent", text: string): QfEvent =>
  ({ type: "message", role, text, seq: ++seq, ts: 0, jobId }) as QfEvent;

/** A daemon in memory: enough of QfClient for the tools. */
function fakeDaemon() {
  const jobs = new Map<string, Job>([
    ["job_lead", job("job_lead", { agentId: "lead", role: "orchestrator", parentJobId: null })],
    ["job_other", job("job_other", { parentJobId: null })],
  ]);
  const created: CreateJobInput[] = [];
  const sent: [string, string][] = [];
  const events = new Map<string, QfEvent[]>();
  let n = 0;
  const client = {
    agents: async () => [
      {
        id: "lead",
        name: "Lead",
        description: "",
        harness: "claude-code",
        workspace: "worktree",
        policy: { preset: "safe", rules: [] },
      },
      {
        id: "worker",
        name: "Worker",
        description: "Does things",
        harness: "fake",
        workspace: "worktree",
        policy: { preset: "safe", rules: [] },
      },
    ],
    job: async (id: string) => {
      const j = jobs.get(id);
      if (!j) throw new QfApiError(404, `Job "${id}" not found`);
      return view(j, j.status === "needs_input" ? 1 : 0);
    },
    createJob: async (input: CreateJobInput) => {
      created.push(input);
      const j = job(`job_w${++n}`, { title: input.title ?? "Untitled" });
      jobs.set(j.id, j);
      return j;
    },
    events: async (id: string) => ({ events: events.get(id) ?? [] }),
    diff: async (id: string) =>
      id === "job_w1"
        ? { available: true, diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n" }
        : { available: false, diff: "" },
    sendMessage: async (id: string, text: string) => {
      sent.push([id, text]);
      return { ok: true as const };
    },
    cancelJob: async () => ({ ok: true as const }),
  } as unknown as QfClient;
  return { client, jobs, created, sent, events };
}

describe("OrchestratorTools", () => {
  it("creates jobs as children of the orchestrator, in its run", async () => {
    const d = fakeDaemon();
    const tools = new OrchestratorTools({ client: d.client, parentJobId: "job_lead" });
    const result = await tools.call("create_job", { agentId: "worker", prompt: "Do it" });
    expect(result.isError).toBeUndefined();
    expect(result.data.jobId).toBe("job_w1");
    expect(d.created[0]).toMatchObject({
      agentId: "worker",
      prompt: "Do it",
      parentJobId: "job_lead",
      runId: "job_lead",
      role: "worker",
    });
  });

  it("lists agents and marks the orchestrator's own", async () => {
    const d = fakeDaemon();
    const tools = new OrchestratorTools({ client: d.client, parentJobId: "job_lead" });
    const result = await tools.call("list_agents", {});
    expect(result.text).toContain("worker (Worker, fake, safe policy): Does things");
    expect(result.text).toContain("that's you");
  });

  it("only touches jobs it started, and explains bad input instead of throwing", async () => {
    const d = fakeDaemon();
    const tools = new OrchestratorTools({ client: d.client, parentJobId: "job_lead" });
    const foreign = await tools.call("send_message", { jobId: "job_other", text: "hi" });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("was not started by you");
    expect(d.sent).toHaveLength(0);

    const missing = await tools.call("get_job", { jobId: "job_nope" });
    expect(missing).toMatchObject({ isError: true, text: 'No job "job_nope".' });

    const invalid = await tools.call("create_job", { agentId: "worker" });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("prompt");

    const unknown = await tools.call("frobnicate", {});
    expect(unknown).toMatchObject({ isError: true, text: 'Unknown tool "frobnicate"' });

    const badDep = await tools.call("create_job", {
      agentId: "worker",
      prompt: "x",
      dependsOn: ["job_other"],
    });
    expect(badDep.isError).toBe(true);
    expect(d.created).toHaveLength(0);
  });

  it("waits until jobs settle, and stops early when one needs approval", async () => {
    const d = fakeDaemon();
    const tools = new OrchestratorTools({ client: d.client, parentJobId: "job_lead", pollMs: 5 });
    await tools.call("create_job", { agentId: "worker", prompt: "a" });
    await tools.call("create_job", { agentId: "worker", prompt: "b" });
    d.events.set("job_w1", [
      message("job_w1", "user", "a"),
      message("job_w1", "agent", "Step one."),
      {
        type: "tool.call",
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        status: "completed",
        locations: [],
        seq: ++seq,
        ts: 0,
        jobId: "job_w1",
      } as QfEvent,
      message("job_w1", "agent", "Finished."),
    ]);
    setTimeout(() => {
      d.jobs.set("job_w1", { ...(d.jobs.get("job_w1") as Job), status: "done" });
      d.jobs.set("job_w2", { ...(d.jobs.get("job_w2") as Job), status: "failed", error: "Boom" });
    }, 30);
    const done = await tools.call("wait_for_jobs", { jobIds: ["job_w1", "job_w2"] });
    expect(done.data.timedOut).toBe(false);
    expect(done.text).toContain("All jobs have finished their turn.");
    expect(done.text).toContain("job_w2 · worker · failed (Boom)");
    expect(done.text).toContain("Changed files on qf/job_w1: src/a.ts");
    expect(done.text).toContain("Step one.\n\nFinished.");

    d.jobs.set("job_w2", { ...(d.jobs.get("job_w2") as Job), status: "needs_input" });
    d.jobs.set("job_w1", { ...(d.jobs.get("job_w1") as Job), status: "working" });
    const blocked = await tools.call("wait_for_jobs", { jobIds: ["job_w1", "job_w2"] });
    expect(blocked.data.waitingForApproval).toEqual(["job_w2"]);
    expect(blocked.text).toContain("job_w2 is waiting for a person");

    // The same wait isn't reported twice: the next call waits for it to be decided.
    setTimeout(() => {
      d.jobs.set("job_w1", { ...(d.jobs.get("job_w1") as Job), status: "done" });
      d.jobs.set("job_w2", { ...(d.jobs.get("job_w2") as Job), status: "done" });
    }, 30);
    const after = await tools.call("wait_for_jobs", { jobIds: ["job_w1", "job_w2"] });
    expect(after.text).toContain("All jobs have finished their turn.");

    d.jobs.set("job_w1", { ...(d.jobs.get("job_w1") as Job), status: "working" });
    const timedOut = await tools.call("wait_for_jobs", { jobIds: ["job_w1"], timeoutSeconds: 1 });
    expect(timedOut.data.timedOut).toBe(true);
  });
});

describe("helpers", () => {
  it("reads changed files from a diff and the latest reply from a transcript", () => {
    expect(
      changedFiles("diff --git a/x.md b/x.md\n--- a/x.md\ndiff --git a/old.ts b/new.ts\n"),
    ).toEqual(["x.md", "new.ts"]);
    const at = (role: "user" | "agent", text: string) =>
      ({ kind: "message", key: text, role, text, ts: 0 }) as const;
    expect(latestReply([at("agent", "old"), at("user", "again"), at("agent", "new")])).toBe("new");
    expect(latestReply([])).toBe("");
  });

  it("describes every tool with an object schema", () => {
    const defs = toolDefinitions();
    expect(defs.map((t) => t.name)).toEqual([
      "list_agents",
      "create_job",
      "get_job",
      "wait_for_jobs",
      "send_message",
      "cancel_job",
    ]);
    for (const def of defs) expect(def.inputSchema.type).toBe("object");
    const create = defs.find((t) => t.name === "create_job");
    expect(create?.inputSchema.required).toEqual(["agentId", "prompt"]);
  });
});

describe("MCP server", () => {
  it("serves the tools over MCP", async () => {
    const d = fakeDaemon();
    const server = createMcpServer({ client: d.client, parentJobId: "job_lead" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("wait_for_jobs");
    const result = await client.callTool({
      name: "create_job",
      arguments: { agentId: "worker", prompt: "Hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ jobId: "job_w1" });
    const failed = await client.callTool({ name: "cancel_job", arguments: { jobId: "job_other" } });
    expect(failed.isError).toBe(true);
    await client.close();
  });
});
