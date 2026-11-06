import type { Job, QfEvent, QfEventData, StateSnapshot } from "@quantaflow/core";
import { describe, expect, it } from "vitest";
import {
  applyEvents,
  applySnapshot,
  approvalQueue,
  emptyLiveData,
  type LiveData,
  MAX_DECISIONS,
  mergeLog,
} from "../src/store/reduce";

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  title: `Job ${id}`,
  prompt: "do it",
  agentId: "builder",
  harness: "fake",
  workspace: "folder",
  workspacePath: null,
  branch: null,
  baseRef: null,
  portBase: null,
  status: "queued",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  runId: null,
  parentJobId: null,
  dependsOn: [],
  role: "worker",
  ...extra,
});

let seq = 0;
const ev = (jobId: string, data: QfEventData, ts = 100): QfEvent =>
  ({ ...data, seq: ++seq, ts, jobId }) as QfEvent;

const snapshot = (overrides: Partial<StateSnapshot> = {}): StateSnapshot => ({
  version: "test",
  root: "/repo",
  agents: [],
  harnesses: [],
  jobs: [],
  approvals: [],
  lastSeq: 0,
  ...overrides,
});

describe("applyEvents", () => {
  it("creates a job view from job.created and folds later events", () => {
    seq = 0;
    const events = [
      ev("j1", { type: "job.created", job: job("j1") }),
      ev("j1", { type: "job.state", state: "starting" }),
      ev("j1", { type: "job.state", state: "working" }),
      ev("j1", { type: "message", role: "agent", text: "Hello ", messageId: "m1" }),
      ev("j1", { type: "message", role: "agent", text: "there", messageId: "m1" }),
    ];
    const data = applyEvents(emptyLiveData, events);
    expect(data.jobs.j1?.job.status).toBe("working");
    expect(data.jobs.j1?.lastMessage).toBe("Hello there");
    expect(data.lastSeq).toBe(5);
  });

  it("joins message chunks across batches", () => {
    seq = 0;
    let data = applyEvents(emptyLiveData, [
      ev("j1", { type: "job.created", job: job("j1") }),
      ev("j1", { type: "message", role: "agent", text: "Hello ", messageId: "m1" }),
    ]);
    data = applyEvents(data, [
      ev("j1", { type: "message", role: "agent", text: "again", messageId: "m1" }),
    ]);
    expect(data.jobs.j1?.lastMessage).toBe("Hello again");
  });

  it("skips events already covered by the snapshot", () => {
    seq = 0;
    const created = ev("j1", { type: "job.created", job: job("j1") });
    const working = ev("j1", { type: "job.state", state: "working" });
    const base = applySnapshot(emptyLiveData, snapshot({ lastSeq: working.seq, jobs: [] }));
    const data = applyEvents(base, [created, working]);
    expect(data).toBe(base);
  });

  it("tracks approvals from requested to resolved and records the decision", () => {
    seq = 0;
    let data = applyEvents(emptyLiveData, [
      ev("j1", { type: "job.created", job: job("j1") }),
      ev(
        "j1",
        {
          type: "permission.requested",
          approvalId: "a1",
          title: "Run pnpm test",
          kind: "execute",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          input: { command: "pnpm test" },
        },
        200,
      ),
    ]);
    expect(Object.keys(data.approvals)).toEqual(["a1"]);
    expect(data.approvals.a1).toMatchObject({
      jobId: "j1",
      title: "Run pnpm test",
      createdAt: 200,
    });
    expect(data.jobs.j1?.pendingApprovals).toBe(1);

    data = applyEvents(data, [
      ev("j1", { type: "permission.resolved", approvalId: "a1", outcome: "allowed", by: "user" }),
    ]);
    expect(data.approvals).toEqual({});
    expect(data.jobs.j1?.pendingApprovals).toBe(0);
    expect(data.decisions[0]).toMatchObject({
      approvalId: "a1",
      title: "Run pnpm test",
      by: "user",
    });
  });

  it("keeps policy decisions made in the same batch as the request", () => {
    seq = 0;
    const data = applyEvents(emptyLiveData, [
      ev("j1", {
        type: "permission.requested",
        approvalId: "a1",
        title: "Read README.md",
        kind: "read",
        options: [],
      }),
      ev("j1", {
        type: "permission.resolved",
        approvalId: "a1",
        outcome: "allowed",
        by: "policy",
        reason: "Reads run freely",
      }),
    ]);
    expect(data.approvals).toEqual({});
    expect(data.decisions).toHaveLength(1);
    expect(data.decisions[0]).toMatchObject({
      title: "Read README.md",
      by: "policy",
      reason: "Reads run freely",
    });
  });

  it("drops a finished job's pending approvals", () => {
    seq = 0;
    const data = applyEvents(emptyLiveData, [
      ev("j1", { type: "job.created", job: job("j1") }),
      ev("j1", {
        type: "permission.requested",
        approvalId: "a1",
        title: "Edit",
        kind: "edit",
        options: [],
      }),
      ev("j1", { type: "job.state", state: "cancelled" }),
    ]);
    expect(data.approvals).toEqual({});
  });

  it("caps the decision history", () => {
    seq = 0;
    const events: QfEvent[] = [];
    for (let i = 0; i < MAX_DECISIONS + 5; i++) {
      events.push(
        ev("j1", {
          type: "permission.resolved",
          approvalId: `a${i}`,
          outcome: "denied",
          by: "policy",
        }),
      );
    }
    const data = applyEvents(emptyLiveData, events);
    expect(data.decisions).toHaveLength(MAX_DECISIONS);
    expect(data.decisions[0]?.approvalId).toBe(`a${MAX_DECISIONS + 4}`);
  });

  it("appends live events to open logs without duplicates", () => {
    seq = 0;
    const first = ev("j1", { type: "job.created", job: job("j1") });
    const second = ev("j1", { type: "job.state", state: "starting" });
    let data: LiveData = { ...emptyLiveData, logs: { j1: { status: "loading", events: [] } } };
    data = applyEvents(data, [first]);
    data = mergeLog(data, "j1", [first, second]);
    data = applyEvents(data, [second]);
    expect(data.logs.j1?.events.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    expect(data.logs.j1?.status).toBe("ready");
  });
});

describe("applySnapshot", () => {
  it("replaces live state but keeps decisions and logs", () => {
    seq = 0;
    const withDecision = applyEvents(emptyLiveData, [
      ev("j1", { type: "permission.resolved", approvalId: "a1", outcome: "denied", by: "user" }),
    ]);
    const withLog = { ...withDecision, logs: { j1: { status: "ready" as const, events: [] } } };
    const data = applySnapshot(
      withLog,
      snapshot({
        lastSeq: 42,
        approvals: [{ id: "a2", jobId: "j2", title: "x", kind: "edit", options: [], createdAt: 5 }],
      }),
    );
    expect(data.lastSeq).toBe(42);
    expect(Object.keys(data.approvals)).toEqual(["a2"]);
    expect(data.decisions).toHaveLength(1);
    expect(data.logs.j1).toBeDefined();
  });
});

describe("approvalQueue", () => {
  it("orders oldest first", () => {
    const queue = approvalQueue({
      b: { id: "b", jobId: "j", title: "b", kind: "edit", options: [], createdAt: 20 },
      a: { id: "a", jobId: "j", title: "a", kind: "edit", options: [], createdAt: 10 },
    });
    expect(queue.map((a) => a.id)).toEqual(["a", "b"]);
  });
});
