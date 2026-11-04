import { describe, expect, it } from "vitest";
import type { Job, QfEvent, QfEventData } from "../src/schemas.js";
import { canTransition } from "../src/state.js";
import { buildTranscript, countStates, foldJob } from "../src/views.js";

const job: Job = {
  id: "job_1",
  title: "Demo",
  prompt: "Do the thing",
  agentId: "builder",
  harness: "fake",
  workspace: "folder",
  workspacePath: null,
  branch: null,
  baseRef: null,
  portBase: null,
  status: "queued",
  error: null,
  createdAt: 1000,
  updatedAt: 1000,
  runId: null,
  parentJobId: null,
  dependsOn: [],
  role: "worker",
};

function events(...data: QfEventData[]): QfEvent[] {
  return data.map((d, i) => ({ ...d, seq: i + 1, ts: 1000 + i, jobId: job.id }) as QfEvent);
}

describe("foldJob", () => {
  it("tracks state, the latest agent message, tools, approvals and usage", () => {
    const view = foldJob(
      job,
      events(
        { type: "job.created", job },
        { type: "job.state", state: "starting" },
        { type: "job.state", state: "working" },
        { type: "message", role: "agent", text: "Hello ", messageId: "m1" },
        { type: "message", role: "agent", text: "world", messageId: "m1" },
        {
          type: "tool.call",
          toolCallId: "t1",
          title: "Read",
          kind: "read",
          status: "completed",
          locations: [],
        },
        {
          type: "permission.requested",
          approvalId: "a1",
          title: "Edit",
          kind: "edit",
          options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
        },
        { type: "usage", usage: { used: 10, size: 100 } },
      ),
    );
    expect(view.job.status).toBe("working");
    expect(view.lastMessage).toBe("Hello world");
    expect(view.toolCalls).toBe(1);
    expect(view.pendingApprovals).toBe(1);
    expect(view.usage).toEqual({ used: 10, size: 100 });
    expect(view.startedAt).toBe(1001);
  });

  it("clears pending approvals and records the error when a job fails", () => {
    const view = foldJob(
      job,
      events(
        {
          type: "permission.requested",
          approvalId: "a1",
          title: "Edit",
          kind: "edit",
          options: [],
        },
        { type: "job.state", state: "failed", reason: "harness crashed" },
      ),
    );
    expect(view.pendingApprovals).toBe(0);
    expect(view.job.error).toBe("harness crashed");
    expect(view.endedAt).toBe(1001);
  });
});

describe("buildTranscript", () => {
  it("merges message chunks and updates tool and approval cards in place", () => {
    const items = buildTranscript(
      events(
        { type: "message", role: "user", text: "Fix it" },
        { type: "message", role: "agent", text: "On " },
        { type: "message", role: "agent", text: "it." },
        {
          type: "tool.call",
          toolCallId: "t1",
          title: "Edit a.ts",
          kind: "edit",
          status: "pending",
          locations: ["a.ts"],
        },
        {
          type: "permission.requested",
          approvalId: "a1",
          title: "Edit a.ts",
          kind: "edit",
          options: [],
        },
        { type: "permission.resolved", approvalId: "a1", outcome: "allowed", by: "user" },
        { type: "tool.update", toolCallId: "t1", status: "completed", output: "ok" },
        { type: "job.state", state: "done" },
      ),
    );
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "tool", "permission", "state"]);
    expect(items[1]).toMatchObject({ role: "agent", text: "On it." });
    expect(items[2]).toMatchObject({ status: "completed", output: "ok" });
    expect(items[3]).toMatchObject({ status: "allowed", by: "user" });
  });
});

describe("state machine", () => {
  it("allows follow-ups after done but not resurrecting a failed job without a restart", () => {
    expect(canTransition("done", "working")).toBe(true);
    expect(canTransition("failed", "working")).toBe(false);
    expect(canTransition("failed", "starting")).toBe(true);
    expect(canTransition("queued", "done")).toBe(false);
  });

  it("counts jobs by state", () => {
    const counts = countStates([foldJob(job, []), foldJob({ ...job, status: "done" }, [])]);
    expect(counts.queued).toBe(1);
    expect(counts.done).toBe(1);
  });
});
