import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ASSISTANT = `# A QuantaFlow agent. The file name is its id: \`qf run assistant "..."\`.
name: Assistant
description: General-purpose helper for this project.
# claude-code, codex, opencode, gemini, kilo or fake. See \`qf harnesses\`.
harness: claude-code
# model: sonnet
instructions: |
  You are a careful engineer working in this project. Keep changes small,
  explain what you changed and why, and run the project's checks when you can.
# worktree: its own git branch and folder. folder: a fresh empty folder. cwd: this checkout.
workspace: worktree
policy:
  # readonly, safe (asks before edits, commands, deletes and fetches) or trusted.
  preset: safe
  rules: []
  # Rules run before the preset, first match wins. For example:
  # - { action: allow, kinds: [execute], pattern: "^(pnpm|npm) (test|run lint)" }
  # - { action: deny, kinds: [fetch] }
limits:
  maxMinutes: 30
`;

const LEAD = `# An orchestrator: it splits a task across the other agents and combines their results.
# Run it as one with \`qf run lead --orchestrate "..."\`. Each worker keeps its own policy.
name: Lead
description: Plans the work, hands parts to worker agents and combines their results.
harness: claude-code
instructions: |
  You coordinate. Break the task into independent parts, give each one to the best-suited
  worker agent with a complete prompt, wait for the results, check them, and ask for fixes
  when needed. Do a part yourself only when it is too small to hand off.
workspace: worktree
policy:
  preset: safe
  rules:
    # Lets it use QuantaFlow's own orchestrator tools without asking each time.
    - action: allow
      kinds: [other]
      pattern: 'quantaflow(__|\\s*[-:./]\\s*)(list_agents|create_job|get_job|wait_for_jobs|send_message|cancel_job)\\b'
      note: QuantaFlow orchestrator tools
`;

const DEMO = `# The built-in demo agent. It needs no model or API key, so it's a safe way to try
# QuantaFlow: \`qf run demo "write a summary and run the tests"\`.
# It can orchestrate too: \`qf run demo --orchestrate "orchestrate a summary"\`.
name: Demo
description: Scripted agent that reads, edits a file and asks to run a command.
harness: fake
workspace: worktree
policy:
  preset: safe
`;

const CONFIG = `# QuantaFlow settings for this project. Everything here is optional.
# port: 4747
# maxConcurrent: 4          # jobs that run at the same time
# idleMinutes: 15           # close an idle agent session after this long
# allowedOrigins: []        # extra web origins allowed to call the API, e.g. a dev server
# harnesses:                # override how a harness is launched
#   claude-code:
#     command: npx
#     args: ["-y", "@agentclientprotocol/claude-agent-acp"]
`;

export interface InitResult {
  created: string[];
  skipped: string[];
}

/** Creates `.quantaflow/` with a config template and three agents. Never overwrites a file. */
export async function initProject(root: string): Promise<InitResult> {
  const dir = path.join(root, ".quantaflow");
  const files: [string, string][] = [
    [path.join(dir, "config.yaml"), CONFIG],
    [path.join(dir, "agents", "assistant.yaml"), ASSISTANT],
    [path.join(dir, "agents", "demo.yaml"), DEMO],
    [path.join(dir, "agents", "lead.yaml"), LEAD],
    [path.join(dir, ".gitignore"), "state/\n"],
  ];
  await mkdir(path.join(dir, "agents"), { recursive: true });
  const result: InitResult = { created: [], skipped: [] };
  for (const [file, content] of files) {
    if (existsSync(file)) {
      result.skipped.push(file);
      continue;
    }
    await writeFile(file, content, { flag: "wx" });
    result.created.push(file);
  }
  return result;
}
