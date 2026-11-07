import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessRegistry } from "@quantaflow/drivers";
import type { FastifyInstance } from "fastify";
import { AgentDirectory } from "./agents.js";
import { ApprovalCenter } from "./approvals.js";
import {
  type ConfigOverrides,
  type DaemonConfig,
  ensureDataDir,
  loadConfig,
  loadFileAgents,
} from "./config.js";
import { EventLog } from "./events.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";
import { ORCHESTRATOR_MCP_NAME, Supervisor } from "./supervisor.js";
import { WorkspaceManager } from "./workspace.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** The built `qf-mcp` script that serves orchestrator tools, or null if it isn't built. */
function orchestratorMcpPath(): string | null {
  try {
    const file = fileURLToPath(import.meta.resolve("@quantaflow/mcp/bin"));
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** Finds the built web UI: an explicit path, QF_WEB_DIST, or apps/web/dist in this repo. */
function findWebDist(explicit: string | false | undefined): string | null {
  if (explicit === false) return null;
  const candidates = [
    explicit,
    process.env.QF_WEB_DIST,
    path.resolve(here, "..", "..", "web", "dist"),
    path.resolve(here, "..", "web"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return candidates.find((c) => existsSync(path.join(c, "index.html"))) ?? null;
}

export interface DaemonOptions extends ConfigOverrides {
  /** Project root. Defaults to the current directory. */
  root?: string;
  /** Path to the built web UI, or false to serve none. */
  webDist?: string | false;
  /** Print warnings, such as invalid agent files, to stderr. Defaults to true. */
  logWarnings?: boolean;
}

export interface RunningDaemon {
  url: string;
  port: number;
  config: DaemonConfig;
  warnings: string[];
  supervisor: Supervisor;
  server: FastifyInstance;
  /** Re-reads `.quantaflow/agents` now and returns the files that failed to load. */
  reloadAgents(): Promise<string[]>;
  close(): Promise<void>;
}

/** Starts the QuantaFlow daemon for one project and resolves once it is listening. */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const root = path.resolve(options.root ?? process.cwd());
  const config = await loadConfig(root, options);
  await ensureDataDir(config);

  const warnings: string[] = [];
  const fileAgents = await loadFileAgents(config);
  warnings.push(...fileAgents.errors);

  const store = await Store.open(path.join(config.stateDir, "quantaflow.db"));
  const registry = new HarnessRegistry(config.harnesses);
  const log = new EventLog(store);
  const agents = new AgentDirectory(store, fileAgents.agents);
  const approvals = new ApprovalCenter(log);
  const workspaces = new WorkspaceManager(root, config.stateDir, config.portRangeStart);
  const supervisor = new Supervisor({
    store,
    log,
    agents,
    approvals,
    workspaces,
    registry,
    maxConcurrent: config.maxConcurrent,
    idleMinutes: config.idleMinutes,
    version: VERSION,
    orchestratorMcp: (job) => {
      const bin = orchestratorMcpPath();
      if (!bin) return null;
      return {
        name: ORCHESTRATOR_MCP_NAME,
        command: process.execPath,
        args: [bin],
        env: {
          QF_URL: `http://127.0.0.1:${boundPort}`,
          QF_PARENT_JOB_ID: job.id,
          QF_RUN_ID: job.runId ?? job.id,
        },
      };
    },
  });

  log.hydrate(store.listJobs(10_000));
  supervisor.recover();

  // Agent files are re-read when they change, so `qf init` or an edited YAML file takes effect
  // without a restart. Editors save in bursts, hence the short debounce.
  const agentsDir = path.join(config.dataDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  const reloadAgents = async (): Promise<string[]> => {
    const result = await loadFileAgents(config);
    agents.replaceFileAgents(result.agents);
    return result.errors;
  };
  let reloadTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(agentsDir, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadAgents()
          .then((errors) => {
            if (options.logWarnings === false) return;
            for (const error of errors) console.warn(`[quantaflow] ${error}`);
          })
          .catch((error: unknown) => console.error("[quantaflow] Could not reload agents:", error));
      }, 150);
    });
    watcher.on("error", () => watcher?.close());
    watcher.unref();
  } catch {
    // Watching is a convenience. Without it, agent file changes apply on the next start.
  }

  let boundPort = config.port;
  const server = await buildServer({
    version: VERSION,
    root,
    store,
    log,
    agents,
    approvals,
    supervisor,
    workspaces,
    registry,
    allowedOrigins: config.allowedOrigins,
    webDist: findWebDist(options.webDist),
    port: () => boundPort,
  });

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    store.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `Port ${config.port} is in use. Is another QuantaFlow daemon running? Pick another port with --port.`,
      );
    }
    throw error;
  }
  const address = server.server.address();
  if (address && typeof address === "object") boundPort = address.port;

  if (options.logWarnings !== false) {
    for (const warning of warnings) console.warn(`[quantaflow] ${warning}`);
  }

  let closed: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    config,
    warnings,
    supervisor,
    server,
    reloadAgents,
    close() {
      closed ??= (async () => {
        watcher?.close();
        clearTimeout(reloadTimer);
        await supervisor.shutdown();
        await server.close();
        store.close();
      })();
      return closed;
    },
  };
}
