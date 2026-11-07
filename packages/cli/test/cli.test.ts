import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { QfClient } from "@quantaflow/core";
import { type RunningDaemon, startDaemon } from "@quantaflow/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, main, PromptAborted, probe } from "../src/index.js";

// The demo agent inherits the daemon's environment; run it without artificial delays.
process.env.QF_FAKE_DELAY_MS = "0";

let root: string;
let daemon: RunningDaemon | undefined;

async function initGitRepo(dir: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(path.join(dir, "README.md"), "# Test project\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** An in-memory terminal. `answers` are typed, in order, at each approval prompt. */
function terminal(options: { interactive?: boolean; answers?: string[]; stdin?: string } = {}) {
  let out = "";
  let err = "";
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const io: Io = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdoutIsTty: false,
    interactive: options.interactive ?? false,
    ask: async (question, signal) => {
      if (signal.aborted) throw new PromptAborted("aborted");
      asked.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Error(`No answer scripted for: ${question}`);
      return next;
    },
    onInterrupt: () => () => {},
    readStdin: async () => options.stdin ?? "",
    env: {},
    cwd: root,
  };
  return { io, out: () => out, err: () => err, asked };
}

async function waitFor<T>(probeFn: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await probeFn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qf-cli-"));
  await initGitRepo(root);
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("qf against a running daemon", () => {
  let url: string;
  const qf = (args: string[], t = terminal()) => main(["--url", url, ...args], t.io);

  beforeEach(async () => {
    daemon = await startDaemon({ root, port: 0, webDist: false, logWarnings: false });
    url = daemon.url;
  });

  it("runs a job with inline approvals, then lists, shows, diffs and continues it", async () => {
    const add = terminal();
    expect(await qf(["agent", "add", "builder", "--harness", "fake"], add)).toBe(0);
    expect(add.out()).toContain("Added agent builder");

    const run = terminal({ interactive: true, answers: ["maybe", "y", "n"] });
    expect(await qf(["run", "builder", "Write a summary and run the tests"], run)).toBe(0);
    const out = run.out();
    expect(out).toContain("allowed by policy · read");
    expect(out).toContain("⏸ Approve edit? Write QUANTAFLOW_DEMO.md");
    expect(out).toContain("file: QUANTAFLOW_DEMO.md");
    expect(out).toContain("Type y, a, n or s.");
    expect(out).toContain("allowed by you · edit");
    expect(out).toContain("⏸ Approve execute?");
    expect(out).toContain("$ echo ok");
    expect(out).toContain("denied by you · execute");
    expect(out).not.toContain("✗ Run"); // The denial already said it; no second failure line.
    expect(out).toContain("✓ Done");
    expect(out).toMatch(/qf diff job_/);
    expect(run.asked).toHaveLength(3);

    const jobs = terminal();
    expect(await qf(["jobs"], jobs)).toBe(0);
    expect(jobs.out()).toMatch(/job_\w+\s+builder\s+Done/);

    const show = terminal();
    expect(await qf(["show", "last"], show)).toBe(0);
    expect(show.out()).toContain("› Write a summary and run the tests");
    expect(show.out()).toContain("All done.");

    const diff = terminal();
    expect(await qf(["diff", "last"], diff)).toBe(0);
    expect(diff.out()).toContain("+++ b/QUANTAFLOW_DEMO.md");

    const [view] = await new QfClient({ baseUrl: url }).jobs();
    const prefix = view?.job.id.slice(4, 9) ?? "";
    const say = terminal({ interactive: true, answers: ["y"] });
    expect(await qf(["say", prefix, "One more pass"], say)).toBe(0);
    expect(say.out()).toContain("allowed by you · edit");
    expect(say.out()).toContain("✓ Done");
  });

  it("waits for approvals decided elsewhere when it can't ask", async () => {
    await qf(["agent", "add", "builder", "--harness", "fake"]);
    const run = terminal({ interactive: false });
    const finished = qf(["run", "builder", "Write a summary"], run);

    const client = new QfClient({ baseUrl: url });
    const approval = await waitFor(
      async () => (await client.approvals()).find((a) => a.kind === "edit"),
      "the edit approval",
    );
    const approve = terminal();
    expect(await qf(["approve", approval.id.slice(0, 8)], approve)).toBe(0);
    expect(approve.out()).toContain(`Allowed ${approval.id}`);

    expect(await finished).toBe(0);
    expect(run.out()).toContain("⏸ Waiting for your approval · edit");
    expect(run.out()).toContain(`qf approve ${approval.id}`);
    expect(run.out()).toContain("allowed by you · edit");
  });

  it("detaches, lists approvals, cancels and attaches", async () => {
    await qf(["agent", "add", "builder", "--harness", "fake"]);
    const detached = terminal();
    expect(await qf(["run", "builder", "Write a summary", "--detach"], detached)).toBe(0);
    const jobId = detached.out().trim();
    expect(jobId).toMatch(/^job_\w+$/);

    const client = new QfClient({ baseUrl: url });
    await waitFor(
      async () => (await client.approvals()).find((a) => a.jobId === jobId),
      "an approval",
    );
    const approvals = terminal();
    expect(await qf(["approvals"], approvals)).toBe(0);
    expect(approvals.out()).toContain(jobId);
    expect(approvals.out()).toContain("Write QUANTAFLOW_DEMO.md");

    const cancel = terminal();
    expect(await qf(["cancel", jobId], cancel)).toBe(0);
    expect(cancel.out()).toContain(`Cancelled ${jobId}.`);
    expect((await client.job(jobId)).job.status).toBe("cancelled");

    const attach = terminal();
    expect(await qf(["attach", jobId], attach)).toBe(1);
    expect(attach.out()).toContain("– Cancelled");
  });

  it("merges a finished job, explains conflicts, and discards", async () => {
    await qf(["agent", "add", "builder", "--harness", "fake"]);
    const first = terminal({ interactive: true, answers: ["y"] });
    expect(await qf(["run", "builder", "First summary"], first)).toBe(0);
    expect(first.out()).toMatch(/then `qf merge job_\w+`/);
    const second = terminal({ interactive: true, answers: ["y"] });
    expect(await qf(["run", "builder", "Second summary"], second)).toBe(0);

    const jobs = (await new QfClient({ baseUrl: url }).jobs()).sort(
      (a, b) => a.job.createdAt - b.job.createdAt,
    );
    const [a, b] = jobs.map((v) => v.job.id);

    const merge = terminal();
    expect(await qf(["merge", a ?? "", "--squash", "-m", "Add the summary"], merge)).toBe(0);
    expect(merge.out()).toMatch(/✓ Squashed qf\/job_\w+ into main as [0-9a-f]{10}\./);
    expect(
      execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf8" }).trim(),
    ).toBe("Add the summary");

    const clash = terminal();
    expect(await qf(["merge", b ?? ""], clash)).toBe(1);
    expect(clash.err()).toContain("conflicts in 1 file(s)");
    expect(clash.err()).toContain("  QUANTAFLOW_DEMO.md");

    const discard = terminal();
    expect(await qf(["discard", b ?? ""], discard)).toBe(0);
    expect(discard.out()).toContain(`Discarded the worktree and branch qf/${b}`);
    const show = terminal();
    await qf(["show", b ?? ""], show);
    expect(show.out()).toContain("– Workspace discarded");
  });

  it("follows an orchestrator's workers and asks their approvals here", async () => {
    await qf(["agent", "add", "builder", "--harness", "fake"]);
    const run = terminal({ interactive: true, answers: ["y"] });
    expect(await qf(["run", "builder", "--orchestrate", "orchestrate a summary"], run)).toBe(0);
    const out = run.out();
    expect(out).toContain("· orchestrator");
    expect(out).toMatch(/↳ \[job_\w+\] builder · Survey the workspace/);
    expect(out).toMatch(/⏸ Approve edit\? \[job_\w+\] Write QUANTAFLOW_DEMO.md/);
    expect(out).toMatch(/✓ \[job_\w+\] allowed by you · edit/);
    expect(out).toContain("Both workers finished.");
    expect(out).toContain("Changed QUANTAFLOW_DEMO.md");
    expect(run.asked).toHaveLength(1);

    const jobs = terminal();
    await qf(["jobs"], jobs);
    expect(jobs.out()).toContain("◆ orchestrate a summary");
    expect(jobs.out()).toContain("↳ Write up the findings");
  });

  it("explains mistakes instead of failing obscurely", async () => {
    const unknown = terminal();
    expect(await qf(["frobnicate"], unknown)).toBe(2);
    expect(unknown.err()).toContain('Unknown command "frobnicate"');

    const badId = terminal();
    expect(await qf(["agent", "add", "Bad Id", "--harness", "fake"], badId)).toBe(1);
    expect(badId.err()).toContain("Invalid agent");
    expect(badId.err()).toContain("id: Use lowercase letters");

    const noAgent = terminal();
    expect(await qf(["run", "ghost", "hello", "--detach"], noAgent)).toBe(1);
    expect(noAgent.err()).toMatch(/ghost/);

    const badMode = terminal();
    expect(await qf(["run", "ghost", "hello", "--workspace", "moon"], badMode)).toBe(2);
    expect(badMode.err()).toContain("--workspace must be one of worktree, folder, cwd");

    const badFlag = terminal();
    expect(await qf(["jobs", "--frob"], badFlag)).toBe(2);

    const noJob = terminal();
    expect(await qf(["show", "zzzz"], noJob)).toBe(1);
    expect(noJob.err()).toContain('No job matches "zzzz"');

    const nobody = terminal();
    const port = await freePort();
    expect(await main(["--url", `http://127.0.0.1:${port}`, "jobs"], nobody.io)).toBe(1);
    expect(nobody.err()).toContain("No QuantaFlow daemon is running");
  });
});

describe("qf without a daemon", () => {
  it("creates a project with init, then run starts and stops a temporary daemon", async () => {
    const init = terminal();
    expect(await main(["init"], init.io)).toBe(0);
    expect(init.out()).toContain("created .quantaflow/agents/demo.yaml");
    expect(existsSync(path.join(root, ".quantaflow", "agents", "assistant.yaml"))).toBe(true);
    expect(existsSync(path.join(root, ".quantaflow", "agents", "lead.yaml"))).toBe(true);

    const url = `http://127.0.0.1:${await freePort()}`;
    const run = terminal({ interactive: true });
    expect(await main(["--url", url, "run", "demo", "Say hello, readonly"], run.io)).toBe(0);
    expect(run.err()).toContain("Started a temporary daemon");
    expect(run.out()).toContain("✓ Done");
    expect(await probe(url)).toEqual({ state: "down" });

    const again = terminal();
    expect(await main(["init"], again.io)).toBe(0);
    expect(again.out()).toContain("exists  .quantaflow/agents/demo.yaml");
  });

  it("reads the prompt from stdin with -", async () => {
    await main(["init"], terminal().io);
    const url = `http://127.0.0.1:${await freePort()}`;
    const run = terminal({ stdin: "Summarize from stdin, readonly\n" });
    expect(await main(["--url", url, "run", "demo", "-"], run.io)).toBe(0);
    expect(run.out()).toContain('for: "Summarize from stdin, readonly"');
  });
});
