import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_PORT, QfClient } from "@quantaflow/core";

export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function daemonUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = flag ?? env.QF_URL ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`"${raw}" is not a valid URL.`, "Use something like http://127.0.0.1:4747.");
  }
  if (url.protocol !== "http:") {
    throw new CliError(`The daemon URL must start with http:// (got ${url.protocol}//).`);
  }
  return url.origin;
}

/**
 * The project a command works on: the nearest folder with a `.quantaflow/` directory, otherwise the
 * git checkout's top level, otherwise the current folder. A `.quantaflow/` in the home folder is
 * skipped, so running qf somewhere under ~ doesn't silently pick it.
 */
export function findProjectRoot(start: string): string {
  const home = homedir();
  let dir = path.resolve(start);
  for (;;) {
    if (dir !== home && existsSync(path.join(dir, ".quantaflow"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (top) return path.resolve(top);
  } catch {
    // Not a git checkout.
  }
  return path.resolve(start);
}

type Probe =
  | { state: "up"; version: string }
  | { state: "down" }
  | { state: "error"; message: string };

/** Errors from reusing a pooled connection the server already closed. A fresh one settles it. */
const STALE_SOCKET = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);

export async function probe(url: string, retry = true): Promise<Probe> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      version?: string;
    } | null;
    if (response.ok && body?.ok) return { state: "up", version: body.version ?? "?" };
    return {
      state: "error",
      message: `${url} answered with HTTP ${response.status}, so it doesn't look like a QuantaFlow daemon.`,
    };
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED") return { state: "down" };
    if (retry && code && STALE_SOCKET.has(code)) return probe(url, false);
    if ((error as Error).name === "TimeoutError") {
      return { state: "error", message: `${url} did not answer within 3 seconds.` };
    }
    const detail = (error as { cause?: { message?: string } }).cause?.message;
    return {
      state: "error",
      message: `Could not reach ${url}: ${(error as Error).message}${detail ? ` (${detail})` : ""}`,
    };
  }
}

export interface Connection {
  client: QfClient;
  url: string;
  /** Set when this command started its own daemon. It stops when the command ends. */
  embedded: { close(): Promise<void> } | null;
}

export interface ConnectOptions {
  url: string;
  /** Port for a daemon this command starts. Omit to use the project's configured port. */
  port?: number;
  /** Start a temporary in-process daemon when nothing listens at a loopback URL. */
  autoStart: boolean;
  root: string;
  onStarted?: (url: string, warnings: string[]) => void;
}

export async function connect(options: ConnectOptions): Promise<Connection> {
  const found = await probe(options.url);
  if (found.state === "up") {
    return { client: new QfClient({ baseUrl: options.url }), url: options.url, embedded: null };
  }
  if (found.state === "error") throw new CliError(found.message);

  const parsed = new URL(options.url);
  if (!options.autoStart || !LOOPBACK.has(parsed.hostname)) {
    throw new CliError(
      `No QuantaFlow daemon is running at ${options.url}.`,
      "Start one with `qf up` (keep it open), or use `qf run`, which starts one for the run.",
    );
  }
  // Loaded lazily: the daemon pulls in SQLite and Fastify, which most commands never need.
  const { startDaemon } = await import("@quantaflow/daemon");
  const daemon = await startDaemon({
    root: options.root,
    ...(options.port !== undefined ? { port: options.port } : {}),
    logWarnings: false,
  });
  options.onStarted?.(daemon.url, daemon.warnings);
  return {
    client: new QfClient({ baseUrl: daemon.url }),
    url: daemon.url,
    embedded: { close: () => daemon.close() },
  };
}
