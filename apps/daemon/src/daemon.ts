import { existsSync, readFileSync } from "node:fs";
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
import { Supervisor } from "./supervisor.js";
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
  });

  log.hydrate(store.listJobs(10_000));
  supervisor.recover();

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
    close() {
      closed ??= (async () => {
        await supervisor.shutdown();
        await server.close();
        store.close();
      })();
      return closed;
    },
  };
}
