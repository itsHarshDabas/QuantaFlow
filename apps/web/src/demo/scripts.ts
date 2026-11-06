import type { AgentProfile, FileDiff, HarnessInfo, ToolKind } from "@quantaflow/core";

/** One beat of a scripted agent turn. */
export type Step =
  | { t: "say"; text: string }
  | { t: "think"; text: string }
  | { t: "plan"; entries: string[]; done: number }
  | {
      t: "tool";
      id: string;
      title: string;
      kind: ToolKind;
      locations?: string[];
      input?: unknown;
      output?: string;
      diffs?: FileDiff[];
      /** `ask` waits for a person, `policy` is auto-allowed by the agent's policy. */
      approval?: "ask" | "policy";
      policyReason?: string;
    }
  | { t: "usage"; used: number; size: number; cost?: number }
  | { t: "log"; text: string }
  | { t: "notice"; severity: "info" | "warning" | "error"; title: string; description?: string }
  | { t: "end"; state: "idle" | "done" | "failed"; reason?: string };

const install = (tool: string) => `Install ${tool} and sign in once.`;

export const DEMO_HARNESSES: HarnessInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    tier: "acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    found: true,
    install: install("Claude Code"),
    notes: "Runs through the official ACP adapter.",
  },
  {
    id: "codex",
    label: "Codex",
    tier: "acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    found: true,
    install: "Install the Codex CLI and run `codex login` once.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    tier: "acp",
    command: "opencode",
    args: ["acp"],
    found: true,
    install: "Install OpenCode with `npm i -g opencode-ai`.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    tier: "acp",
    command: "gemini",
    args: ["--acp"],
    found: true,
    install: "Install Gemini CLI with `npm i -g @google/gemini-cli`.",
  },
  {
    id: "kilo",
    label: "Kilo Code",
    tier: "acp",
    command: "kilo",
    args: ["acp"],
    found: false,
    install: "Install Kilo Code with `npm i -g @kilocode/cli` and sign in once by running `kilo`.",
  },
  {
    id: "fake",
    label: "Demo agent (no model)",
    tier: "acp",
    command: "node",
    args: ["fake-agent"],
    found: true,
    install: "Built in. Needs nothing else.",
  },
];

const profile = (
  p: Partial<AgentProfile> & Pick<AgentProfile, "id" | "name" | "harness">,
): AgentProfile => ({
  description: "",
  instructions: "",
  workspace: "worktree",
  policy: { preset: "safe", rules: [] },
  mcpServers: [],
  limits: {},
  source: "db",
  ...p,
});

export const DEMO_AGENTS: AgentProfile[] = [
  profile({
    id: "lead",
    name: "Lead",
    harness: "claude-code",
    description: "Breaks a goal into jobs, hands them out and reports back.",
    instructions: "You coordinate other agents. Plan by file ownership so jobs don't collide.",
    workspace: "cwd",
  }),
  profile({
    id: "builder",
    name: "Builder",
    harness: "claude-code",
    description: "Writes and changes code in its own worktree.",
    instructions: "Keep changes small. Run the tests before you say you're done.",
  }),
  profile({
    id: "reviewer",
    name: "Reviewer",
    harness: "codex",
    description: "Reads diffs and leaves review notes. Never edits.",
    policy: { preset: "readonly", rules: [] },
    limits: { maxMinutes: 30 },
  }),
  profile({
    id: "researcher",
    name: "Researcher",
    harness: "gemini",
    description: "Reads docs and the web, writes a sourced summary.",
    workspace: "folder",
  }),
  profile({
    id: "writer",
    name: "Writer",
    harness: "opencode",
    description: "Drafts release notes, docs and announcements.",
    workspace: "folder",
  }),
  profile({
    id: "ops",
    name: "Ops",
    harness: "kilo",
    description: "Runs maintenance tasks against staging.",
    workspace: "cwd",
    policy: {
      preset: "safe",
      rules: [{ action: "deny", kinds: ["execute"], pattern: "prod", note: "Never touch prod" }],
    },
    source: "file",
  }),
];

export const RATE_LIMIT_DIFF = `diff --git a/src/routes/login.ts b/src/routes/login.ts
index 3f2c1a4..9b7e0d2 100644
--- a/src/routes/login.ts
+++ b/src/routes/login.ts
@@ -1,14 +1,19 @@
 import { Router } from "express";
 import { verifyPassword } from "../auth/password";
 import { createSession } from "../auth/session";
+import { rateLimit } from "../middleware/rate-limit";

 export const login = Router();

-login.post("/login", async (req, res) => {
+const limiter = rateLimit({ windowMs: 60_000, max: 5, key: (req) => req.ip ?? "unknown" });
+
+login.post("/login", limiter, async (req, res) => {
   const { email, password } = req.body ?? {};
   const user = await verifyPassword(email, password);
   if (!user) {
-    return res.status(401).json({ error: "Invalid email or password" });
+    res.status(401).json({ error: "Invalid email or password" });
+    return;
   }
   const session = await createSession(user.id);
   res.json({ token: session.token });
 });
diff --git a/src/middleware/rate-limit.ts b/src/middleware/rate-limit.ts
new file mode 100644
index 0000000..c41d2e7
--- /dev/null
+++ b/src/middleware/rate-limit.ts
@@ -0,0 +1,24 @@
+import type { NextFunction, Request, Response } from "express";
+
+interface Options {
+  windowMs: number;
+  max: number;
+  key: (req: Request) => string;
+}
+
+/** Fixed-window limiter kept in memory. Good enough for one process. */
+export function rateLimit({ windowMs, max, key }: Options) {
+  const hits = new Map<string, { count: number; resetAt: number }>();
+  return (req: Request, res: Response, next: NextFunction) => {
+    const id = key(req);
+    const now = Date.now();
+    const entry = hits.get(id);
+    if (!entry || entry.resetAt <= now) {
+      hits.set(id, { count: 1, resetAt: now + windowMs });
+      return next();
+    }
+    entry.count += 1;
+    if (entry.count <= max) return next();
+    res.setHeader("retry-after", Math.ceil((entry.resetAt - now) / 1000));
+    res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
+  };
+}
`;

export const TEST_DIFF = `diff --git a/test/login.test.ts b/test/login.test.ts
new file mode 100644
index 0000000..5e1f0aa
--- /dev/null
+++ b/test/login.test.ts
@@ -0,0 +1,18 @@
+import request from "supertest";
+import { describe, expect, it } from "vitest";
+import { app } from "../src/app";
+
+describe("POST /login rate limit", () => {
+  it("allows five attempts a minute", async () => {
+    for (let i = 0; i < 5; i++) {
+      const res = await request(app).post("/login").send({ email: "a@b.c", password: "x" });
+      expect(res.status).toBe(401);
+    }
+  });
+
+  it("blocks the sixth with a 429", async () => {
+    const res = await request(app).post("/login").send({ email: "a@b.c", password: "x" });
+    expect(res.status).toBe(429);
+    expect(res.headers["retry-after"]).toBeDefined();
+  });
+});
`;

/** A generic turn for jobs created in the demo, shaped by keywords like the real demo agent. */
export function genericScript(prompt: string, followUp: boolean): Step[] {
  const lower = prompt.toLowerCase();
  const short = prompt.length > 70 ? `${prompt.slice(0, 67)}...` : prompt;
  const steps: Step[] = [
    {
      t: "say",
      text: followUp
        ? `Following up on "${short}".\n\n`
        : `On it. This is the in-browser demo, so I'll walk through what a real agent would do for "${short}".\n\n`,
    },
    { t: "plan", entries: ["Read the workspace", "Make the change", "Report back"], done: 0 },
    { t: "think", text: "Start with the files that mention this, then decide what to touch." },
    {
      t: "tool",
      id: "read",
      title: "Read README.md",
      kind: "read",
      locations: ["README.md"],
      input: { file_path: "README.md" },
      output: "# QuantaFlow demo project\n\nA tiny express app used by the demo.",
      approval: "policy",
      policyReason: "Reads run freely under the safe preset",
    },
    { t: "plan", entries: ["Read the workspace", "Make the change", "Report back"], done: 1 },
    { t: "usage", used: 18_400, size: 200_000 },
  ];
  if (!lower.includes("readonly")) {
    steps.push({
      t: "tool",
      id: "edit",
      title: "Write NOTES.md",
      kind: "edit",
      locations: ["NOTES.md"],
      input: { file_path: "NOTES.md", content: `# Notes\n\n- ${short}\n` },
      diffs: [{ path: "NOTES.md", oldText: null, newText: `# Notes\n\n- ${short}\n` }],
      output: "Wrote 1 file",
      approval: "ask",
    });
  }
  if (lower.includes("run") || lower.includes("test")) {
    steps.push({
      t: "tool",
      id: "exec",
      title: "Run pnpm test",
      kind: "execute",
      input: { command: "pnpm test --run" },
      output:
        " ✓ test/login.test.ts (2 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)",
      approval: "ask",
    });
  }
  steps.push({
    t: "plan",
    entries: ["Read the workspace", "Make the change", "Report back"],
    done: 3,
  });
  if (lower.includes("fail")) {
    steps.push({ t: "log", text: "error: the demo was asked to fail" });
    steps.push({ t: "end", state: "failed", reason: "The demo agent was asked to fail." });
    return steps;
  }
  steps.push({ t: "usage", used: 26_900, size: 200_000, cost: 0.08 });
  steps.push({
    t: "say",
    text: "Done. I wrote a short note in NOTES.md describing the change. Send a follow-up if you want more.",
  });
  steps.push({ t: "end", state: "done" });
  return steps;
}
