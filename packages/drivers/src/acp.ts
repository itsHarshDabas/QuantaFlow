import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { FileDiff, McpServerConfig, ToolKind } from "@quantaflow/core";
import {
  type DriverEvent,
  type DriverSession,
  HarnessError,
  type PermissionAsk,
  type StartSessionOptions,
} from "./types.js";

const MAX_OUTPUT_CHARS = 8_000;
const MAX_DIFF_CHARS = 20_000;
const MAX_INPUT_CHARS = 4_000;
const MAX_STDERR_LINES = 400;
const STDERR_TAIL_LINES = 20;
const INIT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 3_000;

const TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

function toKind(kind: string | null | undefined): ToolKind {
  return kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : "other";
}

function clipText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function clipInput(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    return { unserializable: true };
  }
  if (json === undefined || json.length <= MAX_INPUT_CHARS) return raw;
  return { truncated: true, preview: json.slice(0, MAX_INPUT_CHARS) };
}

function mapContent(content: acp.ToolCallContent[] | null | undefined): {
  output?: string;
  diffs?: FileDiff[];
} {
  if (!content || content.length === 0) return {};
  const texts: string[] = [];
  const diffs: FileDiff[] = [];
  for (const item of content) {
    if (item.type === "content") {
      if (item.content.type === "text") texts.push(item.content.text);
      else if (item.content.type === "resource_link") texts.push(item.content.uri);
    } else if (item.type === "diff") {
      diffs.push({
        path: item.path,
        oldText: item.oldText == null ? null : clipText(item.oldText, MAX_DIFF_CHARS),
        newText: clipText(item.newText, MAX_DIFF_CHARS),
      });
    } else if (item.type === "terminal") {
      texts.push(`[terminal ${item.terminalId}]`);
    }
  }
  return {
    ...(texts.length > 0 ? { output: clipText(texts.join("\n"), MAX_OUTPUT_CHARS) } : {}),
    ...(diffs.length > 0 ? { diffs } : {}),
  };
}

function severityOf(severity: string): "info" | "warning" | "error" {
  return severity === "warning" || severity === "error" ? severity : "info";
}

/** Converts one ACP `session/update` into QuantaFlow driver events. Unknown updates are dropped. */
export function mapSessionUpdate(update: acp.SessionUpdate): DriverEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text" || update.content.text === "") return [];
      return [
        {
          type: "message",
          role: update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought",
          text: update.content.text,
          ...(update.messageId ? { messageId: update.messageId } : {}),
        },
      ];
    }
    case "tool_call": {
      const input = clipInput(update.rawInput);
      return [
        {
          type: "tool.call",
          toolCallId: update.toolCallId,
          title: update.title || "Tool call",
          kind: toKind(update.kind),
          status: update.status ?? "pending",
          locations: (update.locations ?? []).map((l) => l.path),
          ...(input !== undefined ? { input } : {}),
          ...mapContent(update.content),
        },
      ];
    }
    case "tool_call_update":
      return [
        {
          type: "tool.update",
          toolCallId: update.toolCallId,
          ...(update.title ? { title: update.title } : {}),
          ...(update.kind ? { kind: toKind(update.kind) } : {}),
          ...(update.status ? { status: update.status } : {}),
          ...mapContent(update.content),
        },
      ];
    case "plan":
      return [
        {
          type: "plan",
          entries: update.entries.map((e) => ({
            content: e.content,
            status: e.status,
            priority: e.priority,
          })),
        },
      ];
    case "usage_update":
      return [
        {
          type: "usage",
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost
              ? { amount: update.cost.amount, currency: update.cost.currency }
              : null,
          },
        },
      ];
    case "notice":
      return [
        {
          type: "notice",
          severity: severityOf(update.severity),
          title: update.title,
          ...(update.description ? { description: update.description } : {}),
        },
      ];
    default:
      return [];
  }
}

function toAsk(params: acp.RequestPermissionRequest): PermissionAsk {
  const input = clipInput(params.toolCall.rawInput);
  return {
    toolCallId: params.toolCall.toolCallId,
    title: params.toolCall.title || "Permission requested",
    kind: toKind(params.toolCall.kind),
    options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    ...(input !== undefined ? { input } : {}),
  };
}

function toAcpMcpServers(servers: McpServerConfig[] = []): acp.McpServer[] {
  return servers.map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args,
    env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
  }));
}

function flattenSelectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const entry of options) {
    if (entry && typeof entry === "object") {
      if ("value" in entry && typeof entry.value === "string") values.push(entry.value);
      if ("options" in entry) values.push(...flattenSelectValues(entry.options));
    }
  }
  return values;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HarnessError(message, "protocol")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Starts a harness as a child process, connects to it over ACP, and opens one session.
 * Resolves once the session exists and is ready for `prompt()`.
 */
export async function startAcpSession(options: StartSessionOptions): Promise<DriverSession> {
  const { spec } = options;
  const args = [...spec.args];
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env, ...options.env };
  if (options.model && spec.model?.env) env[spec.model.env] = options.model;
  if (options.model && spec.model?.args) {
    const model = options.model;
    args.push(...spec.model.args.map((a) => a.replaceAll("{model}", model)));
  }

  const child = spawn(spec.command, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
    windowsHide: true,
  });

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error));
  });
  if (spawnError) {
    throw new HarnessError(
      `Could not start ${spec.label} ("${spec.command}"): ${spawnError.message}. ${spec.install}`,
      "not_installed",
    );
  }
  child.on("error", () => {
    // Surfaced through the exit handler; this listener keeps the daemon alive.
  });
  child.stdin?.on("error", () => {
    // EPIPE when the harness exits mid-write is expected.
  });

  const stderrTail: string[] = [];
  let stderrLines = 0;
  let partial = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      stderrLines += 1;
      if (stderrLines <= MAX_STDERR_LINES) {
        options.onEvent({ type: "log", stream: "stderr", text: clipText(line, 2_000) });
      } else if (stderrLines === MAX_STDERR_LINES + 1) {
        options.onEvent({
          type: "log",
          stream: "system",
          text: "Further harness logs are hidden.",
        });
      }
    }
  });

  let closing = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve();
    });
  });

  let turn: AbortController | null = null;

  const app = acp
    .client({ name: "quantaflow" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      for (const event of mapSessionUpdate(params.update)) options.onEvent(event);
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
      const signals = [signal];
      if (turn) signals.push(turn.signal);
      const decision = await options.onPermission(toAsk(params), AbortSignal.any(signals));
      return {
        outcome:
          decision.outcome === "selected"
            ? { outcome: "selected" as const, optionId: decision.optionId }
            : { outcome: "cancelled" as const },
      };
    });

  if (!child.stdin || !child.stdout) throw new HarnessError("Harness has no stdio", "protocol");
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  const agent = connection.agent;

  const exitMessage = () => {
    const info = exitInfo as { code: number | null; signal: string | null } | null;
    const how = info?.signal ? `signal ${info.signal}` : `code ${info?.code ?? "unknown"}`;
    const tail = stderrTail.slice(-5).join("\n");
    return `${spec.label} exited (${how}).${tail ? ` Last output:\n${tail}` : ""}`;
  };

  void exited.then(() => {
    connection.close(new HarnessError(exitMessage(), "exited"));
    if (!closing) {
      options.onExit?.({
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        stderrTail: stderrTail.join("\n"),
      });
    }
  });

  const describe = (error: unknown): HarnessError => {
    if (error instanceof HarnessError) return error;
    if (exitInfo) return new HarnessError(exitMessage(), "exited");
    if (error instanceof acp.RequestError && error.code === -32000) {
      return new HarnessError(
        `${spec.label} needs you to sign in. Run \`${spec.detect ?? spec.command}\` once in a terminal to log in, then retry.`,
        "auth_required",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new HarnessError(`${spec.label}: ${message}`, "protocol");
  };

  const shutdown = async () => {
    closing = true;
    connection.close();
    child.stdin?.end();
    killTree(child, "SIGTERM");
    const timer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    timer.unref();
    await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS + 500).unref())]);
    clearTimeout(timer);
  };

  let sessionId: string;
  let agentName: string | null = null;
  try {
    const init = await withTimeout(
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: {
          name: "quantaflow",
          title: "QuantaFlow",
          version: options.clientVersion ?? "0.0.0",
        },
      }),
      INIT_TIMEOUT_MS,
      `${spec.label} did not answer the ACP handshake within ${INIT_TIMEOUT_MS / 1000}s.`,
    );
    agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? null;

    const created = await withTimeout(
      agent.request(acp.methods.agent.session.new, {
        cwd: options.cwd,
        mcpServers: toAcpMcpServers(options.mcpServers),
      }),
      INIT_TIMEOUT_MS,
      `${spec.label} did not open a session within ${INIT_TIMEOUT_MS / 1000}s.`,
    );
    sessionId = created.sessionId;

    if (options.model) {
      const modelOption = created.configOptions?.find(
        (o) => o.type === "select" && (o.category === "model" || o.id === "model"),
      );
      if (modelOption && modelOption.type === "select") {
        if (flattenSelectValues(modelOption.options).includes(options.model)) {
          await agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: modelOption.id,
            value: options.model,
          });
        } else {
          options.onEvent({
            type: "notice",
            severity: "warning",
            title: `Model "${options.model}" is not offered by ${spec.label}`,
            description: `Using ${spec.label}'s current model instead.`,
          });
        }
      } else if (!spec.model) {
        options.onEvent({
          type: "notice",
          severity: "info",
          title: `${spec.label} does not let QuantaFlow pick a model`,
          description: "It runs with its own default. Set the model in its own config.",
        });
      }
    }
  } catch (error) {
    const described = describe(error);
    await shutdown();
    throw described;
  }

  const session: DriverSession = {
    sessionId,
    agentName,
    get closed() {
      return closing || exitInfo !== null;
    },
    async prompt(text) {
      if (session.closed) throw new HarnessError(`${spec.label} session is closed.`, "exited");
      const current = new AbortController();
      turn = current;
      try {
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return { stopReason: response.stopReason };
      } catch (error) {
        throw describe(error);
      } finally {
        current.abort();
        if (turn === current) turn = null;
      }
    },
    async cancel() {
      if (session.closed) return;
      turn?.abort();
      await agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
    },
    async close() {
      if (closing) return;
      await shutdown();
    },
  };
  return session;
}
