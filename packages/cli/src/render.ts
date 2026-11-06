import type { QfEvent, ToolKind, Usage } from "@quantaflow/core";
import { oneLine } from "./format.js";
import type { Style } from "./style.js";

export interface RenderOptions {
  /** Show thoughts, harness stderr and tool output. */
  verbose: boolean;
  /** Print the person's own messages. Off when they just typed them. */
  echoUser: boolean;
}

interface AskInfo {
  title: string;
  kind: ToolKind;
  toolCallId?: string;
}

interface ToolInfo {
  title: string;
  kind: ToolKind;
  locations: string[];
}

const OUTPUT_TAIL_LINES = 12;

/**
 * Turns the event stream of one job into terminal output. Agent text streams in place; everything
 * else is a line of its own. It keeps just enough state to label approvals and tool results.
 */
export class Renderer {
  private atLineStart = true;
  private paragraph: { role: "agent" | "thought"; messageId?: string } | null = null;
  private lastPlan = "";
  readonly asks = new Map<string, AskInfo>();
  readonly tools = new Map<string, ToolInfo>();
  /** Approvals requested and not yet resolved, in request order. */
  readonly unresolved = new Set<string>();
  usage: Usage | null = null;
  /** The job's workspace, so paths inside it print relative to it. */
  workspacePath: string | null = null;
  /** Tool calls the person or a policy denied; their "failed" status is no news. */
  private readonly denied = new Set<string>();

  constructor(
    private readonly write: (text: string) => void,
    private readonly style: Style,
    private readonly options: RenderOptions,
  ) {}

  /** Writes a full line, first ending any streamed paragraph. */
  line(text: string): void {
    this.breakLine();
    this.paragraph = null;
    this.write(`${text}\n`);
    this.atLineStart = true;
  }

  private breakLine(): void {
    if (!this.atLineStart) {
      this.write("\n");
      this.atLineStart = true;
    }
  }

  private stream(role: "agent" | "thought", text: string, messageId?: string): void {
    if (!text) return;
    const same =
      this.paragraph?.role === role &&
      (messageId === undefined ||
        this.paragraph.messageId === undefined ||
        this.paragraph.messageId === messageId);
    if (!same) {
      this.breakLine();
      this.paragraph = { role, ...(messageId !== undefined ? { messageId } : {}) };
    }
    this.write(role === "thought" ? this.style.dim(text) : text);
    this.atLineStart = text.endsWith("\n");
  }

  /** Ends output with a newline so the shell prompt starts on a fresh line. */
  finish(): void {
    this.breakLine();
    this.paragraph = null;
  }

  /** A path relative to the workspace when it is inside it. */
  rel(file: string): string {
    const base = this.workspacePath;
    if (!base) return file;
    const prefix = base.endsWith("/") || base.endsWith("\\") ? base : `${base}/`;
    return file.startsWith(prefix) ? file.slice(prefix.length) : file === base ? "." : file;
  }

  describeAsk(approvalId: string): AskInfo | undefined {
    return this.asks.get(approvalId);
  }

  toolFor(toolCallId: string | undefined): ToolInfo | undefined {
    return toolCallId ? this.tools.get(toolCallId) : undefined;
  }

  event(event: QfEvent): void {
    const s = this.style;
    switch (event.type) {
      case "message":
        if (event.role === "agent") this.stream("agent", event.text, event.messageId);
        else if (event.role === "thought") {
          if (this.options.verbose) this.stream("thought", event.text, event.messageId);
        } else if (this.options.echoUser) {
          const [first = "", ...rest] = event.text.split("\n");
          this.line(
            `${s.bold("›")} ${s.bold(first)}${rest.length ? `\n  ${rest.join("\n  ")}` : ""}`,
          );
        }
        return;
      case "tool.call":
        this.tools.set(event.toolCallId, {
          title: event.title,
          kind: event.kind,
          locations: event.locations,
        });
        this.line(s.dim(`▸ ${event.kind.padEnd(7)} ${oneLine(event.title, 100)}`));
        this.toolResult(event.toolCallId, event.status, event.output);
        return;
      case "tool.update": {
        const known = this.tools.get(event.toolCallId);
        if (known && (event.title || event.kind)) {
          this.tools.set(event.toolCallId, {
            ...known,
            ...(event.title ? { title: event.title } : {}),
            ...(event.kind ? { kind: event.kind } : {}),
          });
        }
        if (event.status) this.toolResult(event.toolCallId, event.status, event.output);
        return;
      }
      case "plan": {
        const key = JSON.stringify(event.entries);
        if (key === this.lastPlan || event.entries.length === 0) return;
        this.lastPlan = key;
        const mark = (status: string) =>
          status === "completed"
            ? s.green("✓")
            : status === "in_progress"
              ? s.blue("▸")
              : s.dim("○");
        this.line(
          [s.bold("Plan"), ...event.entries.map((e) => `  ${mark(e.status)} ${e.content}`)].join(
            "\n",
          ),
        );
        return;
      }
      case "permission.requested":
        this.asks.set(event.approvalId, {
          title: event.title,
          kind: event.kind,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        });
        this.unresolved.add(event.approvalId);
        return;
      case "permission.resolved": {
        this.unresolved.delete(event.approvalId);
        const ask = this.asks.get(event.approvalId);
        const what = ask ? `${ask.kind}: ${oneLine(ask.title, 90)}` : event.approvalId;
        const by = event.by === "user" ? "you" : event.by;
        if (event.outcome === "allowed") {
          const text = `✓ allowed by ${by} · ${what}`;
          this.line(event.by === "policy" ? s.dim(text) : s.green(text));
        } else if (event.outcome === "denied") {
          if (ask?.toolCallId) this.denied.add(ask.toolCallId);
          this.line(s.red(`✗ denied by ${by} · ${what}`));
        } else {
          this.line(
            s.dim(`– approval cancelled · ${what}${event.reason ? ` (${event.reason})` : ""}`),
          );
        }
        return;
      }
      case "usage":
        this.usage = event.usage;
        return;
      case "notice": {
        const text = `${event.title}${event.description ? ` · ${event.description}` : ""}`;
        if (event.severity === "error") this.line(s.red(`✗ ${text}`));
        else if (event.severity === "warning") this.line(s.amber(`! ${text}`));
        else this.line(s.cyan(`i ${text}`));
        return;
      }
      case "log":
        if (this.options.verbose) this.line(s.dim(`[${event.stream}] ${event.text}`));
        return;
      case "job.updated":
        if (event.patch.workspacePath) {
          this.workspacePath = event.patch.workspacePath;
          const branch = event.patch.branch ? ` on branch ${event.patch.branch}` : "";
          this.line(s.dim(`Workspace: ${event.patch.workspacePath}${branch}`));
        }
        return;
      case "job.state":
        if (event.state === "starting") this.line(s.dim("Starting the agent…"));
        else if (event.state === "failed") {
          this.line(s.red(`✗ Failed${event.reason ? `: ${event.reason}` : ""}`));
        } else if (event.state === "cancelled") {
          this.line(s.dim(`– Cancelled${event.reason ? `: ${event.reason}` : ""}`));
        }
        return;
      case "turn.ended":
        if (this.options.verbose) this.line(s.dim(`turn ended: ${event.stopReason}`));
        return;
      case "workspace.merged":
        this.line(s.green(`✓ Merged into ${event.into} (${event.commit.slice(0, 10)})`));
        return;
      case "workspace.discarded":
        this.line(s.dim("– Workspace discarded"));
        return;
      case "job.created":
        return;
    }
  }

  private toolResult(toolCallId: string, status: string, output: string | undefined): void {
    if (status !== "completed" && status !== "failed") return;
    const tool = this.tools.get(toolCallId);
    const title = oneLine(tool?.title ?? toolCallId, 100);
    if (status === "failed") {
      if (!this.denied.has(toolCallId)) this.line(this.style.red(`✗ ${title}`));
    } else if (this.options.verbose) this.line(this.style.dim(`✓ ${title}`));
    if (this.options.verbose && output?.trim()) {
      const lines = output.trimEnd().split("\n");
      const tail = lines.slice(-OUTPUT_TAIL_LINES);
      const skipped = lines.length - tail.length;
      this.line(
        this.style.dim(
          [
            ...(skipped > 0 ? [`  … ${skipped} more lines`] : []),
            ...tail.map((l) => `  ${l}`),
          ].join("\n"),
        ),
      );
    }
  }
}

/** A short, safe preview of what a tool wants to do, from its raw input. */
export function previewInput(
  input: unknown,
  max = 240,
  rel: (file: string) => string = (file) => file,
): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") return oneLine(input, max);
  if (typeof input !== "object") return oneLine(String(input), max);
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (typeof command === "string") return `$ ${oneLine(command, max)}`;
  if (Array.isArray(command)) return `$ ${oneLine(command.map(String).join(" "), max)}`;
  const file = record.file_path ?? record.path ?? record.filePath;
  if (typeof file === "string") return `file: ${oneLine(rel(file), max)}`;
  const url = record.url;
  if (typeof url === "string") return `url: ${oneLine(url, max)}`;
  try {
    return oneLine(JSON.stringify(input), max);
  } catch {
    return null;
  }
}
