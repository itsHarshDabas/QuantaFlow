import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessInfo } from "@quantaflow/core";
import type { HarnessSpec } from "./types.js";

function fakeAgentPath(): string {
  return fileURLToPath(import.meta.resolve("@quantaflow/fake-agent"));
}

/**
 * Harnesses QuantaFlow knows out of the box. Each one is launched in ACP mode.
 * Claude Code and Codex go through the official ACP adapters, which npx fetches on first use.
 */
export function builtinHarnesses(): HarnessSpec[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      tier: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      model: { env: "ANTHROPIC_MODEL" },
      detect: "claude",
      install:
        "Install Claude Code (https://claude.com/claude-code) and sign in once by running `claude`.",
      notes: "Runs through the official ACP adapter, @agentclientprotocol/claude-agent-acp.",
    },
    {
      id: "codex",
      label: "Codex",
      tier: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      detect: "codex",
      install: "Install the Codex CLI and run `codex login` once.",
      notes: "Runs through the official ACP adapter, @agentclientprotocol/codex-acp.",
    },
    {
      id: "opencode",
      label: "OpenCode",
      tier: "acp",
      command: "opencode",
      args: ["acp"],
      detect: "opencode",
      install:
        "Install OpenCode with `npm i -g opencode-ai` and set up a provider with `opencode auth login`.",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      tier: "acp",
      command: "gemini",
      args: ["--acp"],
      model: { args: ["--model", "{model}"] },
      detect: "gemini",
      install:
        "Install Gemini CLI with `npm i -g @google/gemini-cli` and sign in once by running `gemini`.",
    },
    {
      id: "kilo",
      label: "Kilo Code",
      tier: "acp",
      command: "kilo",
      args: ["acp"],
      detect: "kilo",
      install:
        "Install Kilo Code with `npm i -g @kilocode/cli` and sign in once by running `kilo`.",
    },
    {
      id: "fake",
      label: "Demo agent (no model)",
      tier: "acp",
      command: process.execPath,
      args: [fakeAgentPath()],
      install: "Built in. Needs nothing else.",
      notes: "A scripted agent for trying QuantaFlow without API keys.",
    },
  ];
}

export interface HarnessOverride {
  label?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Looks a command up on PATH, the way a shell would. */
export function findOnPath(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : null;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export class HarnessRegistry {
  private readonly specs = new Map<string, HarnessSpec>();

  constructor(overrides: Record<string, HarnessOverride> = {}) {
    for (const spec of builtinHarnesses()) this.specs.set(spec.id, spec);
    for (const [id, override] of Object.entries(overrides)) {
      const base = this.specs.get(id);
      if (base) {
        this.specs.set(id, { ...base, ...override, env: { ...base.env, ...override.env } });
      } else if (override.command) {
        this.specs.set(id, {
          id,
          label: override.label ?? id,
          tier: "acp",
          command: override.command,
          args: override.args ?? [],
          ...(override.env ? { env: override.env } : {}),
          install: `Custom harness from your QuantaFlow config: ${override.command}`,
        });
      }
    }
  }

  get(id: string): HarnessSpec | undefined {
    return this.specs.get(id);
  }

  list(): HarnessSpec[] {
    return [...this.specs.values()];
  }

  info(): HarnessInfo[] {
    return this.list().map((spec) => ({
      id: spec.id,
      label: spec.label,
      tier: spec.tier,
      command: spec.command,
      args: spec.args,
      found: spec.id === "fake" || findOnPath(spec.detect ?? spec.command) !== null,
      install: spec.install,
      ...(spec.notes ? { notes: spec.notes } : {}),
    }));
  }
}
