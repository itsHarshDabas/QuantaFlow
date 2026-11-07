import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentProfileInput,
  type JobView,
  type PendingApproval,
  QfApiError,
  QfClient,
  type QfEvent,
} from "@quantaflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RunningDaemon, startDaemon } from "../src/index.js";

let root: string;
let daemon: RunningDaemon | undefined;
let client: QfClient;

const FAKE = { fake: { env: { QF_FAKE_DELAY_MS: "0" } } };

async function initGitRepo(dir: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(dir, "README.md"), "# Test project\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

async function boot(options: { git?: boolean; maxConcurrent?: number } = {}): Promise<void> {
  if (options.git !== false) await initGitRepo(root);
  daemon = await startDaemon({
    root,
    port: 0,
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    webDist: false,
    harnesses: FAKE,
    logWarnings: false,
  });
  client = new QfClient({ baseUrl: daemon.url });
}

async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const waitForStatus = (jobId: string, status: JobView["job"]["status"]) =>
  waitFor(async () => {
    const view = await client.job(jobId);
    return view.job.status === status ? view : undefined;
  }, `job ${jobId} to be ${status}`);

const waitForApproval = (jobId: string, kind: PendingApproval["kind"]) =>
  waitFor(
    async () => (await client.approvals()).find((a) => a.jobId === jobId && a.kind === kind),
    `a ${kind} approval`,
  );

const agent = (overrides: Partial<AgentProfileInput> = {}): AgentProfileInput => ({
  id: "builder",
  name: "Builder",
  harness: "fake",
  ...overrides,
});

function rawRequest(
  pathname: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  const url = new URL(pathname, daemon?.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qf-daemon-"));
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("daemon end to end with the demo agent", () => {
  it("runs a job in a worktree, applies policy, waits for approvals and produces a diff", async () => {
    await boot();
    await client.createAgent(agent());
    const job = await client.createJob({
      agentId: "builder",
      prompt: "Write a summary and run the tests",
    });
    expect(job.status).toBe("queued");

    const edit = await waitForApproval(job.id, "edit");
    expect((await client.job(job.id)).job.status).toBe("needs_input");
    await client.decide(edit.id, "allow");

    const run = await waitForApproval(job.id, "execute");
    await client.decide(run.id, "deny");

    const done = await waitForStatus(job.id, "done");
    expect(done.job.branch).toBe(`qf/${job.id}`);
    expect(done.job.workspacePath).toContain(path.join(".quantaflow", "state", "worktrees"));
    expect(done.toolCalls).toBe(3);
    expect(done.usage?.used).toBe(1200);
    expect(done.lastMessage).toContain("All done");

    const { events } = await client.events(job.id);
    const resolved = events.filter((e) => e.type === "permission.resolved");
    expect(resolved.map((e) => [e.by, e.outcome])).toEqual([
      ["policy", "allowed"],
      ["user", "allowed"],
      ["user", "denied"],
    ]);
    const first = events.find((e) => e.type === "message" && e.role === "user");
    expect(first).toMatchObject({ text: "Write a summary and run the tests" });

    const diff = await client.diff(job.id);
    expect(diff.available).toBe(true);
    expect(diff.diff).toContain("QUANTAFLOW_DEMO.md");
  });

  it("takes a follow-up message in the same session", async () => {
    await boot();
    await client.createAgent(agent({ policy: { preset: "trusted", rules: [] } }));
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitForStatus(job.id, "done");
    await client.sendMessage(job.id, "Do another pass");
    await waitFor(async () => {
      const { events } = await client.events(job.id);
      return events.filter((e) => e.type === "turn.ended").length === 2;
    }, "the second turn");
    const view = await waitForStatus(job.id, "done");
    expect(view.usage?.used).toBe(2400);
  });

  it("rejects a follow-up while the agent is busy", async () => {
    await boot();
    await client.createAgent(agent());
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitForApproval(job.id, "edit");
    await expect(client.sendMessage(job.id, "hurry up")).rejects.toMatchObject({ status: 409 });
  });

  it("cancels a job that is waiting for approval", async () => {
    await boot();
    await client.createAgent(agent());
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitForApproval(job.id, "edit");
    await client.cancelJob(job.id);
    const view = await waitForStatus(job.id, "cancelled");
    expect(view.pendingApprovals).toBe(0);
    expect(await client.approvals()).toEqual([]);
  });

  it("fails a job when the agent errors", async () => {
    await boot();
    await client.createAgent(agent({ policy: { preset: "trusted", rules: [] } }));
    const job = await client.createJob({ agentId: "builder", prompt: "please fail" });
    const view = await waitForStatus(job.id, "failed");
    expect(view.job.error).toMatch(/Simulated failure/);
  });

  it("uses a folder when the project is not a git repository", async () => {
    await boot({ git: false });
    await client.createAgent(agent({ policy: { preset: "trusted", rules: [] } }));
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    const view = await waitForStatus(job.id, "done");
    expect(view.job.workspace).toBe("worktree");
    expect(view.job.branch).toBeNull();
    expect(view.job.workspacePath).toContain(path.join(".quantaflow", "state", "workspaces"));
    const { events } = await client.events(job.id);
    expect(events.some((e) => e.type === "notice" && /folder/.test(e.title))).toBe(true);
    expect(await client.diff(job.id)).toMatchObject({ available: false });
  });

  it("starts a job only after its dependencies are done", async () => {
    await boot();
    await client.createAgent(agent());
    const first = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    const second = await client.createJob({
      agentId: "builder",
      prompt: "Write a summary",
      dependsOn: [first.id],
    });
    const approval = await waitForApproval(first.id, "edit");
    expect((await client.job(second.id)).job.status).toBe("queued");
    await client.decide(approval.id, "allow");
    await waitForStatus(first.id, "done");
    await waitForApproval(second.id, "edit");
    await expect(
      client.createJob({ agentId: "builder", prompt: "x", dependsOn: ["job_missing"] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("streams events over the WebSocket", async () => {
    await boot();
    await client.createAgent(agent({ policy: { preset: "trusted", rules: [] } }));
    const socket = new WebSocket(client.streamUrl());
    const received: { type: string; event?: QfEvent }[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve) => socket.once("open", resolve));
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitFor(
      async () => received.some((m) => m.event?.type === "job.state" && m.event.state === "done"),
      "a done event on the stream",
    );
    socket.close();
    expect(received[0]?.type).toBe("hello");
    const seqs = received.flatMap((m) => (m.event ? [m.event.seq] : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(received.every((m) => !m.event || m.event.jobId === job.id)).toBe(true);
  });
});

describe("agents", () => {
  it("validates agents and protects file-defined ones", async () => {
    await mkdir(path.join(root, ".quantaflow", "agents"), { recursive: true });
    await writeFile(
      path.join(root, ".quantaflow", "agents", "researcher.yaml"),
      "name: Researcher\nharness: fake\nworkspace: folder\npolicy:\n  preset: readonly\n",
    );
    await writeFile(path.join(root, ".quantaflow", "agents", "broken.yaml"), "name: 42\n");
    await boot();
    expect(daemon?.warnings.some((w) => w.includes("broken.yaml"))).toBe(true);

    const agents = await client.agents();
    expect(agents).toEqual([
      expect.objectContaining({ id: "researcher", source: "file", workspace: "folder" }),
    ]);
    await expect(client.deleteAgent("researcher")).rejects.toMatchObject({ status: 409 });
    await expect(client.createAgent(agent({ harness: "nope" }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.createAgent(agent({ id: "Bad Id" }))).rejects.toBeInstanceOf(QfApiError);

    await client.createAgent(agent());
    await expect(client.createAgent(agent())).rejects.toMatchObject({ status: 409 });
    const updated = await client.updateAgent("builder", agent({ name: "Builder 2" }));
    expect(updated.name).toBe("Builder 2");
    await client.deleteAgent("builder");
    expect((await client.agents()).map((a) => a.id)).toEqual(["researcher"]);
  });

  it("picks up agent files added while running", async () => {
    await boot();
    expect(await client.agents()).toEqual([]);
    await writeFile(
      path.join(root, ".quantaflow", "agents", "writer.yaml"),
      "name: Writer\nharness: fake\n",
    );
    await waitFor(
      async () => (await client.agents()).some((a) => a.id === "writer" && a.source === "file"),
      "the new agent file to load",
    );
    // An explicit reload reports broken files instead of dropping them silently.
    await writeFile(path.join(root, ".quantaflow", "agents", "broken.yaml"), "harness: [\n");
    expect((await daemon?.reloadAgents())?.some((e) => e.includes("broken.yaml"))).toBe(true);
  });
});

describe("security", () => {
  it("rejects foreign hosts, foreign origins and non-JSON bodies", async () => {
    await boot();
    const port = String(daemon?.port);
    expect(await rawRequest("/api/state", { headers: { host: `evil.example:${port}` } })).toBe(403);
    expect(await rawRequest("/api/state", { headers: { host: `127.0.0.1:${port}` } })).toBe(200);
    expect(
      await rawRequest("/api/agents", {
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
        body: JSON.stringify(agent()),
      }),
    ).toBe(415);
    expect(
      await rawRequest("/api/agents", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(agent()),
      }),
    ).toBe(403);

    const socket = new WebSocket(client.streamUrl(), { origin: "https://evil.example" });
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
      socket.once("error", () => resolve("error"));
    });
    socket.terminate();
    expect(outcome).toBe("403");
  });
});

describe("restart", () => {
  it("keeps history and marks interrupted jobs as failed", async () => {
    await boot();
    await client.createAgent(agent());
    const job = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitForApproval(job.id, "edit");
    await daemon?.close();

    daemon = await startDaemon({
      root,
      port: 0,
      webDist: false,
      harnesses: FAKE,
      logWarnings: false,
    });
    client = new QfClient({ baseUrl: daemon.url });
    const view = await client.job(job.id);
    expect(view.job.status).toBe("failed");
    expect(view.job.error).toMatch(/Interrupted/);
    expect((await client.agents()).map((a) => a.id)).toEqual(["builder"]);
    const state = await client.state();
    expect(state.jobs).toHaveLength(1);
    expect(state.lastSeq).toBeGreaterThan(0);
  });
});

describe("merge and discard", () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  async function finishedJob(prompt: string): Promise<string> {
    const job = await client.createJob({ agentId: "builder", prompt });
    const edit = await waitForApproval(job.id, "edit");
    await client.decide(edit.id, "allow");
    await waitForStatus(job.id, "done");
    return job.id;
  }

  it("commits the agent's work and merges it into the checked-out branch", async () => {
    await boot();
    await client.createAgent(agent());
    const busy = await client.createJob({ agentId: "builder", prompt: "Write a summary" });
    await waitForApproval(busy.id, "edit");
    await expect(client.merge(busy.id)).rejects.toMatchObject({ status: 409 });
    await client.cancelJob(busy.id);

    const id = await finishedJob("Write a summary");
    const events: QfEvent[] = [];
    const socket = new WebSocket(client.streamUrl());
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "event") events.push(message.event);
    });
    await new Promise((r) => socket.once("open", r));

    const result = await client.merge(id);
    expect(result).toMatchObject({ into: "main", strategy: "merge" });
    expect(git("rev-parse", "HEAD")).toBe(result.commit);
    expect(git("log", "-1", "--format=%P").split(" ")).toHaveLength(2); // a real merge commit
    expect(git("show", "HEAD:QUANTAFLOW_DEMO.md")).toContain("QuantaFlow demo");
    expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
    expect((await client.job(id)).job.workspaceState).toBe("merged");
    await waitFor(async () => events.some((e) => e.type === "workspace.merged"), "the event");
    socket.close();

    await expect(client.merge(id)).rejects.toMatchObject({
      status: 409,
      body: { details: { reason: "empty" } },
    });

    await client.discard(id);
    const view = await client.job(id);
    expect(view.job.workspaceState).toBe("discarded");
    expect(existsSync(view.job.workspacePath ?? "")).toBe(false);
    expect(git("branch", "--list", `qf/${id}`)).toBe("");
    await expect(client.sendMessage(id, "more")).rejects.toMatchObject({ status: 409 });
    await expect(client.discard(id)).rejects.toMatchObject({ status: 409 });
  });

  it("squashes, refuses a dirty root and aborts a conflicting merge", async () => {
    await boot();
    await client.createAgent(agent());
    const first = await finishedJob("First summary");
    const second = await finishedJob("Second summary");

    await writeFile(path.join(root, "README.md"), "# Edited by hand\n");
    await expect(client.merge(first)).rejects.toMatchObject({
      status: 409,
      body: { details: { reason: "dirty", files: ["README.md"] } },
    });
    git("checkout", "README.md");

    const squashed = await client.merge(first, { strategy: "squash", message: "Add the summary" });
    expect(git("log", "-1", "--format=%s%n%P")).toBe(
      `Add the summary\n${git("rev-parse", "HEAD~1")}`,
    );
    expect(squashed.commit).toBe(git("rev-parse", "HEAD"));

    // Both jobs wrote QUANTAFLOW_DEMO.md differently, so the second merge conflicts.
    const before = git("rev-parse", "HEAD");
    await expect(client.merge(second)).rejects.toMatchObject({
      status: 409,
      body: { details: { reason: "conflict", conflicts: ["QUANTAFLOW_DEMO.md"] } },
    });
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
    expect((await client.job(second)).job.workspaceState).toBe("active");
  });

  it("only merges worktree jobs, and discards folder jobs", async () => {
    await boot({ git: false });
    await client.createAgent(agent({ workspace: "folder" }));
    const id = await finishedJob("Write a summary");
    await expect(client.merge(id)).rejects.toMatchObject({ status: 400 });
    const folder = (await client.job(id)).job.workspacePath ?? "";
    expect(existsSync(folder)).toBe(true);
    await client.discard(id);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("orchestrator", () => {
  it("gives an orchestrator tools to start workers, even with one concurrency slot", async () => {
    await boot({ maxConcurrent: 1 });
    await client.createAgent(agent());
    const lead = await client.createJob({
      agentId: "builder",
      prompt: "orchestrate a summary, readonly",
      role: "orchestrator",
    });
    expect(lead.runId).toBe(lead.id);
    const done = await waitForStatus(lead.id, "done");
    expect(done.lastMessage).toContain("All done.");

    const workers = (await client.jobs()).filter((v) => v.job.parentJobId === lead.id);
    expect(workers).toHaveLength(2);
    const [survey, writeUp] = workers.sort((a, b) => a.job.createdAt - b.job.createdAt);
    for (const w of workers) {
      expect(w.job).toMatchObject({ role: "worker", runId: lead.id, status: "done" });
    }
    expect(writeUp?.job.dependsOn).toEqual([survey?.job.id]);

    const { events } = await client.events(lead.id);
    const tools = events.flatMap((e) => (e.type === "tool.call" ? [e.title] : []));
    expect(tools[0]).toBe("List worker agents");
    expect(tools).toContain("Wait for the workers");
    const failed = events.filter((e) => e.type === "tool.update" && e.status === "failed");
    expect(failed).toHaveLength(0);
  });

  it("keeps waiting while a worker waits for approval", async () => {
    await boot();
    await client.createAgent(agent());
    const lead = await client.createJob({
      agentId: "builder",
      prompt: "orchestrate a summary",
      role: "orchestrator",
    });
    const writeUp = await waitFor(
      async () => (await client.approvals()).find((a) => a.kind === "edit" && a.jobId !== lead.id),
      "the worker's edit approval",
    );
    await new Promise((r) => setTimeout(r, 300));
    expect((await client.job(lead.id)).job.status).toBe("working");
    await client.decide(writeUp.id, "allow");
    const done = await waitForStatus(lead.id, "done");
    expect(done.lastMessage).toContain("All done.");
    const { events } = await client.events(lead.id);
    const text = events.map((e) => (e.type === "message" ? e.text : "")).join("");
    expect(text).toContain("Both workers finished.");
  });

  it("doesn't give workers the tools", async () => {
    await boot();
    await client.createAgent(agent());
    const job = await client.createJob({ agentId: "builder", prompt: "orchestrate, readonly" });
    const done = await waitForStatus(job.id, "done");
    expect(done.lastMessage).toContain("All done.");
    const { events } = await client.events(job.id);
    const text = events.map((e) => (e.type === "message" ? e.text : "")).join("");
    expect(text).toContain("no QuantaFlow tools were connected");
  });

  it("checks parents, refuses nested orchestrators and caps the workers", async () => {
    await boot();
    await client.createAgent(agent());
    const worker = await client.createJob({ agentId: "builder", prompt: "slow, readonly" });
    await expect(
      client.createJob({ agentId: "builder", prompt: "x", parentJobId: worker.id }),
    ).rejects.toThrow("is not an orchestrator");

    const lead = await client.createJob({
      agentId: "builder",
      prompt: "readonly",
      role: "orchestrator",
      runId: "run_custom",
    });
    await expect(
      client.createJob({
        agentId: "builder",
        prompt: "x",
        parentJobId: lead.id,
        role: "orchestrator",
      }),
    ).rejects.toThrow("can't start another orchestrator");

    const child = await client.createJob({
      agentId: "builder",
      prompt: "readonly",
      parentJobId: lead.id,
      runId: "ignored",
    });
    expect(child.runId).toBe("run_custom");
    for (let i = 1; i < 20; i++) {
      await client.createJob({ agentId: "builder", prompt: "readonly", parentJobId: lead.id });
    }
    const error = await client
      .createJob({ agentId: "builder", prompt: "x", parentJobId: lead.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QfApiError);
    expect((error as QfApiError).status).toBe(409);
    expect((error as QfApiError).message).toContain("at most 20 jobs");
  });
});

describe("web UI", () => {
  it("serves assets added after start, falls back to the app for routes, and 404s missing assets", async () => {
    const web = path.join(root, "web-dist");
    await mkdir(path.join(web, "assets"), { recursive: true });
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>QF</title>");
    daemon = await startDaemon({
      root,
      port: 0,
      webDist: web,
      harnesses: FAKE,
      logWarnings: false,
    });

    // A rebuild writes new hashed assets while the daemon runs.
    await writeFile(path.join(web, "assets", "app-new.js"), "console.log(1)");
    const asset = await fetch(`${daemon.url}/assets/app-new.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);

    const route = await fetch(`${daemon.url}/jobs/job_123`);
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toMatch(/text\/html/);
    expect(route.headers.get("content-security-policy")).toContain("default-src 'self'");

    expect((await fetch(`${daemon.url}/assets/app-old.js`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/api/nope`)).status).toBe(404);
  });
});
