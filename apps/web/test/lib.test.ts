import type { Job, JobView } from "@quantaflow/core";
import { describe, expect, it } from "vitest";
import { diffLines, foldContext, parseUnifiedDiff } from "../src/lib/diff";
import { formatDuration, relativePath, shortPath } from "../src/lib/format";
import { clip, previewInput } from "../src/lib/preview";
import { parseRoute } from "../src/lib/route";
import { byUrgency, inGroup } from "../src/lib/states";
import { layoutOrbit, ringOf } from "../src/views/orbit/layout";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+two!
+three
 four
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+
`;

describe("parseUnifiedDiff", () => {
  it("parses files, statuses, counts and line numbers", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["new.md", "added", 2, 0],
    ]);
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("diffLines and foldContext", () => {
  it("finds the changed lines", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "context:a",
      "del:b",
      "add:B",
      "context:c",
      "add:d",
    ]);
  });

  it("treats a missing old text as a new file", () => {
    expect(diffLines(null, "x\ny").every((l) => l.type === "add")).toBe(true);
  });

  it("folds long unchanged runs but keeps context around changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const folded = foldContext(diffLines(before, after), 2);
    const kinds = folded.map((l) => l.type);
    expect(kinds.filter((k) => k === "fold")).toHaveLength(2);
    expect(folded.filter((l) => l.type === "context")).toHaveLength(4);
  });
});

describe("previewInput", () => {
  it("shows commands, unwrapping Codex-style shell arrays", () => {
    expect(previewInput({ command: "pnpm test" })).toEqual({
      kind: "command",
      command: "pnpm test",
    });
    expect(previewInput({ command: ["bash", "-lc", "git status"], cwd: "/r" })).toEqual({
      kind: "command",
      command: "git status",
      cwd: "/r",
    });
    expect(previewInput({ command: ["git", "commit", "-m", "a b"] })).toMatchObject({
      command: "git commit -m 'a b'",
    });
  });

  it("shows file paths with the new content", () => {
    expect(previewInput({ file_path: "src/a.ts", new_string: "x" })).toEqual({
      kind: "file",
      path: "src/a.ts",
      detail: "x",
    });
  });

  it("shows URLs and falls back to JSON", () => {
    expect(previewInput({ url: "https://x.dev" })).toEqual({ kind: "url", url: "https://x.dev" });
    expect(previewInput({ query: "q" })).toEqual({ kind: "json", text: '{\n  "query": "q"\n}' });
    expect(previewInput(undefined)).toEqual({ kind: "none" });
    expect(previewInput({})).toEqual({ kind: "none" });
  });

  it("clips long previews", () => {
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const { text, clipped } = clip(long, 5);
    expect(clipped).toBe(true);
    expect(text.split("\n")).toHaveLength(5);
  });
});

describe("format", () => {
  it("formats durations compactly", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(15 * 60_000)).toBe("15m");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
  });

  it("shows paths inside a workspace relative to it", () => {
    expect(relativePath("/w/job_1/src/a.ts", "/w/job_1")).toBe("src/a.ts");
    expect(relativePath("/w/job_1/src/a.ts", "/w/job_1/")).toBe("src/a.ts");
    expect(relativePath("/w/job_10/a.ts", "/w/job_1")).toBe("/w/job_10/a.ts");
    expect(relativePath("src/a.ts", null)).toBe("src/a.ts");
  });

  it("shortens paths", () => {
    expect(shortPath("/home/me/code/app")).toBe("~/code/app");
    expect(shortPath("/home/me/code/app/.quantaflow/state/worktrees/job_1", 2)).toBe(
      "…/worktrees/job_1",
    );
  });
});

describe("parseRoute", () => {
  it("reads the view and the open job", () => {
    expect(parseRoute("/orbit", "?job=job_1")).toEqual({ view: "orbit", job: "job_1" });
    expect(parseRoute("/", "")).toEqual({ view: "table", job: null });
    expect(parseRoute("/nope", "?demo")).toEqual({ view: "table", job: null });
  });
});

const view = (
  id: string,
  status: Job["status"],
  extra: Partial<JobView> = {},
  agentId = "a",
): JobView => ({
  job: {
    id,
    title: id,
    prompt: "",
    agentId,
    harness: "fake",
    workspace: "folder",
    workspacePath: null,
    branch: null,
    baseRef: null,
    portBase: null,
    status,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    runId: null,
    parentJobId: null,
    dependsOn: [],
    role: "worker",
    workspaceState: "active",
  },
  lastMessage: "",
  toolCalls: 0,
  pendingApprovals: 0,
  usage: null,
  lastEventAt: 0,
  startedAt: null,
  endedAt: null,
  ...extra,
});

describe("states", () => {
  it("puts jobs waiting on you first", () => {
    const jobs = [
      view("done", "done"),
      view("work", "working"),
      view("ask", "working", { pendingApprovals: 1 }),
    ];
    expect(jobs.sort(byUrgency).map((v) => v.job.id)).toEqual(["ask", "work", "done"]);
  });

  it("groups a working job with an open approval under needs you, not running", () => {
    const asking = view("ask", "working", { pendingApprovals: 1 });
    expect(inGroup(asking, "you")).toBe(true);
    expect(inGroup(asking, "running")).toBe(false);
  });
});

describe("layoutOrbit", () => {
  const radii = [100, 200, 300, 400] as const;

  it("puts jobs on rings by urgency", () => {
    expect(ringOf(view("a", "needs_input"))).toBe(0);
    expect(ringOf(view("b", "working"))).toBe(1);
    expect(ringOf(view("c", "idle"))).toBe(2);
    expect(ringOf(view("d", "failed"))).toBe(3);
  });

  it("gives each agent its own sector and places nodes on their ring radius", () => {
    const layout = layoutOrbit(
      [
        view("1", "working", {}, "x"),
        view("2", "queued", {}, "y"),
        view("3", "needs_input", {}, "x"),
      ],
      ["x", "y"],
      { radii, maxFinished: 10, gap: 0 },
    );
    expect(layout.sectors.map((s) => [s.agentId, s.count])).toEqual([
      ["x", 2],
      ["y", 1],
    ]);
    for (const node of layout.nodes) {
      expect(Math.hypot(node.x, node.y)).toBeCloseTo(radii[node.ring]);
      const sector = layout.sectors.find((s) => s.agentId === node.view.job.agentId);
      expect(node.angle).toBeGreaterThanOrEqual(sector?.start ?? 0);
      expect(node.angle).toBeLessThanOrEqual(sector?.end ?? 0);
    }
    expect(layout.ringCounts).toEqual([1, 1, 1, 0]);
  });

  it("caps finished jobs and counts the rest", () => {
    const views = Array.from({ length: 5 }, (_, i) => view(`d${i}`, "done", { lastEventAt: i }));
    const layout = layoutOrbit(views, [], { radii, maxFinished: 2, gap: 0 });
    expect(layout.nodes).toHaveLength(2);
    expect(layout.hiddenFinished).toBe(3);
    expect(layout.nodes.map((n) => n.view.job.id).sort()).toEqual(["d3", "d4"]);
  });
});
