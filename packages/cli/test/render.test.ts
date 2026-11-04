import type { QfEvent, QfEventData } from "@quantaflow/core";
import { describe, expect, it } from "vitest";
import { makeStyle, parseAnswer, previewInput, Renderer } from "../src/index.js";

let seq = 0;
const ev = (data: QfEventData): QfEvent =>
  ({ ...data, seq: ++seq, ts: 0, jobId: "job_1" }) as QfEvent;

function render(events: QfEventData[], verbose = false): string {
  let out = "";
  const renderer = new Renderer((t) => (out += t), makeStyle(false), { verbose, echoUser: true });
  for (const e of events) renderer.event(ev(e));
  renderer.finish();
  return out;
}

describe("Renderer", () => {
  it("streams agent text and starts tool lines on a fresh line", () => {
    const out = render([
      { type: "message", role: "agent", text: "Hello " },
      { type: "message", role: "agent", text: "world" },
      {
        type: "tool.call",
        toolCallId: "t1",
        title: "Read a.md",
        kind: "read",
        status: "pending",
        locations: [],
      },
      { type: "message", role: "agent", text: "Done." },
    ]);
    expect(out).toBe("Hello world\n▸ read    Read a.md\nDone.\n");
  });

  it("labels approvals with who decided and hides thoughts unless verbose", () => {
    const events: QfEventData[] = [
      { type: "message", role: "thought", text: "pondering" },
      {
        type: "permission.requested",
        approvalId: "apr_1",
        title: "Run tests",
        kind: "execute",
        toolCallId: "t1",
        options: [],
      },
      { type: "permission.resolved", approvalId: "apr_1", outcome: "denied", by: "user" },
      { type: "tool.update", toolCallId: "t1", status: "failed" },
    ];
    const quiet = render(events);
    expect(quiet).not.toContain("pondering");
    expect(quiet).toContain("✗ denied by you · execute: Run tests");
    expect(render(events, true)).toContain("pondering");
  });

  it("prints a plan only when it changes, and failures with their reason", () => {
    const plan: QfEventData = {
      type: "plan",
      entries: [{ content: "Step one", status: "in_progress", priority: "high" }],
    };
    const out = render([plan, plan, { type: "job.state", state: "failed", reason: "Boom" }]);
    expect(out.match(/Plan/g)).toHaveLength(1);
    expect(out).toContain("✗ Failed: Boom");
  });

  it("shows paths relative to the workspace", () => {
    let out = "";
    const r = new Renderer((t) => (out += t), makeStyle(false), {
      verbose: false,
      echoUser: false,
    });
    r.event(ev({ type: "job.updated", patch: { workspacePath: "/w/job_1", branch: "qf/job_1" } }));
    expect(out).toContain("Workspace: /w/job_1 on branch qf/job_1");
    expect(r.rel("/w/job_1/src/a.ts")).toBe("src/a.ts");
    expect(r.rel("/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
  });
});

describe("previewInput", () => {
  it("shows commands, files and urls compactly", () => {
    expect(previewInput({ command: "pnpm test" })).toBe("$ pnpm test");
    expect(previewInput({ command: ["git", "status"] })).toBe("$ git status");
    expect(previewInput({ file_path: "/w/a.ts" }, 240, (f) => f.replace("/w/", ""))).toBe(
      "file: a.ts",
    );
    expect(previewInput({ url: "https://example.com" })).toBe("url: https://example.com");
    expect(previewInput({ other: 1 })).toBe('{"other":1}');
    expect(previewInput(undefined)).toBeNull();
    expect(previewInput("x".repeat(500), 10)).toHaveLength(10);
  });
});

describe("parseAnswer", () => {
  it("maps typed answers and only offers always when it exists", () => {
    expect(parseAnswer(" Y ", true)).toBe("allow");
    expect(parseAnswer("always", true)).toBe("allow_always");
    expect(parseAnswer("a", false)).toBeNull();
    expect(parseAnswer("no", false)).toBe("deny");
    expect(parseAnswer("s", false)).toBe("skip");
    expect(parseAnswer("", true)).toBeNull();
  });
});
