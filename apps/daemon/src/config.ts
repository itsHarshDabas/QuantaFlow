import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentProfile, DEFAULT_PORT } from "@quantaflow/core";
import YAML from "yaml";
import { z } from "zod";

const HarnessOverrideSchema = z.object({
  label: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const ConfigFileSchema = z.object({
  port: z.number().int().min(0).max(65_535).optional(),
  maxConcurrent: z.number().int().min(1).max(64).optional(),
  idleMinutes: z
    .number()
    .min(1)
    .max(24 * 60)
    .optional(),
  allowedOrigins: z.array(z.url()).optional(),
  portRangeStart: z.number().int().min(1024).max(64_000).optional(),
  harnesses: z.record(z.string(), HarnessOverrideSchema).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface DaemonConfig {
  root: string;
  dataDir: string;
  stateDir: string;
  host: string;
  port: number;
  maxConcurrent: number;
  idleMinutes: number;
  allowedOrigins: string[];
  portRangeStart: number;
  harnesses: NonNullable<ConfigFile["harnesses"]>;
}

export interface ConfigOverrides {
  port?: number;
  host?: string;
  maxConcurrent?: number;
  allowedOrigins?: string[];
  harnesses?: ConfigFile["harnesses"];
}

async function readStructured(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
}

/** Reads `.quantaflow/config.yaml` (or `.json`) under the project root, if present. */
export async function loadConfig(
  root: string,
  overrides: ConfigOverrides = {},
): Promise<DaemonConfig> {
  const dataDir = path.join(root, ".quantaflow");
  let file: ConfigFile = {};
  for (const name of ["config.yaml", "config.yml", "config.json"]) {
    const candidate = path.join(dataDir, name);
    if (existsSync(candidate)) {
      const parsed = ConfigFileSchema.safeParse(await readStructured(candidate));
      if (!parsed.success) {
        throw new Error(`Invalid ${candidate}:\n${z.prettifyError(parsed.error)}`);
      }
      file = parsed.data;
      break;
    }
  }
  const envOrigins = (process.env.QF_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    root,
    dataDir,
    stateDir: path.join(dataDir, "state"),
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? file.port ?? DEFAULT_PORT,
    maxConcurrent: overrides.maxConcurrent ?? file.maxConcurrent ?? 4,
    idleMinutes: file.idleMinutes ?? 15,
    allowedOrigins: [
      ...(file.allowedOrigins ?? []),
      ...(overrides.allowedOrigins ?? []),
      ...envOrigins,
    ],
    portRangeStart: file.portRangeStart ?? 41_000,
    harnesses: { ...file.harnesses, ...overrides.harnesses },
  };
}

/** Creates `.quantaflow/state` and keeps it out of git. */
export async function ensureDataDir(config: DaemonConfig): Promise<void> {
  await mkdir(config.stateDir, { recursive: true });
  const ignore = path.join(config.dataDir, ".gitignore");
  if (!existsSync(ignore)) {
    await writeFile(
      ignore,
      "# QuantaFlow runtime state (database, worktrees, workspaces)\nstate/\n",
    );
  }
}

export interface FileAgentsResult {
  agents: AgentProfile[];
  errors: string[];
}

/** Loads agents defined as files in `.quantaflow/agents`. Invalid files are reported, not fatal. */
export async function loadFileAgents(config: DaemonConfig): Promise<FileAgentsResult> {
  const dir = path.join(config.dataDir, "agents");
  if (!existsSync(dir)) return { agents: [], errors: [] };
  const agents: AgentProfile[] = [];
  const errors: string[] = [];
  const names = (await readdir(dir)).filter((n) => /\.(ya?ml|json)$/.test(n)).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const raw = await readStructured(file);
      const id = name.replace(/\.(ya?ml|json)$/, "");
      const withId = raw && typeof raw === "object" && !("id" in raw) ? { id, ...raw } : raw;
      const parsed = AgentProfile.safeParse({ ...(withId as object), source: "file" });
      if (parsed.success) agents.push(parsed.data);
      else errors.push(`${file}: ${z.prettifyError(parsed.error)}`);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { agents, errors };
}
