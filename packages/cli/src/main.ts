import { readFile } from "node:fs/promises";
import path from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import {
  type AgentProfileInput,
  countStates,
  type JobView,
  type PolicyPreset,
  PRESET_DESCRIPTIONS,
  QfApiError,
  type QfClient,
  SESSION_STATES,
  type SessionState,
  STATE_LABELS,
  TERMINAL_STATES,
  type WorkspaceMode,
} from "@quantaflow/core";
import {
  CliError,
  type Connection,
  connect,
  DEFAULT_URL,
  daemonUrl,
  findProjectRoot,
} from "./connect.js";
import { type FollowResult, follow } from "./follow.js";
import { ago, count, duration, oneLine, table } from "./format.js";
import { initProject } from "./init.js";
import type { Io } from "./io.js";
import { Renderer } from "./render.js";
import { makeStyle, type Style, wantsColor } from "./style.js";
import { VERSION } from "./version.js";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

const GLOBAL_OPTIONS: Options = {
  url: { type: "string" },
  root: { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

interface Context {
  io: Io;
  style: Style;
  values: Values;
  positionals: string[];
  /** The project folder: --root, or found from the current folder. */
  root(): string;
  url(): string;
  /** The daemon URL came from --url or QF_URL rather than the default. */
  explicitUrl: boolean;
  connect(autoStart?: boolean): Promise<Connection>;
  print(text: string): void;
  json(value: unknown): void;
}

interface Command {
  usage: string;
  summary: string;
  group: "Daemon" | "Agents" | "Jobs" | "Approvals";
  options?: Options;
  run(ctx: Context): Promise<number>;
}

const STATE_ORDER: readonly SessionState[] = SESSION_STATES;
/** A little over the daemon's grace period for an agent to honor a cancel. */
const CANCEL_WAIT_MS = 6_000;

function stateLabel(state: SessionState, s: Style): string {
  const label = STATE_LABELS[state];
  switch (state) {
    case "needs_input":
      return s.amber(label);
    case "working":
    case "starting":
      return s.blue(label);
    case "done":
      return s.green(label);
    case "failed":
      return s.red(label);
    case "queued":
    case "cancelled":
      return s.dim(label);
    default:
      return label;
  }
}

function str(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function strs(values: Values, key: string): string[] {
  const value = values[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

function need(ctx: Context, index: number, what: string, usage: string): string {
  const value = ctx.positionals[index];
  if (!value) throw new CliError(`Missing ${what}.`, `Usage: qf ${usage}`, 2);
  return value;
}

const WORKSPACES: readonly WorkspaceMode[] = ["worktree", "folder", "cwd"];
const PRESETS: readonly PolicyPreset[] = ["readonly", "safe", "trusted"];

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new CliError(
    `--${flag} must be one of ${allowed.join(", ")} (got "${value}").`,
    undefined,
    2,
  );
}

/** Finds a job by full id, unique prefix (with or without `job_`), or `last`. */
async function resolveJob(client: QfClient, ref: string): Promise<JobView> {
  if (ref === "last") {
    const latest = (await client.jobs()).sort((a, b) => b.job.createdAt - a.job.createdAt)[0];
    if (!latest)
      throw new CliError("There are no jobs yet.", 'Start one with `qf run <agent> "<prompt>"`.');
    return latest;
  }
  try {
    return await client.job(ref);
  } catch (error) {
    if (!(error instanceof QfApiError && error.status === 404)) throw error;
  }
  const matches = (await client.jobs()).filter(
    (v) => v.job.id.startsWith(ref) || v.job.id.startsWith(`job_${ref}`),
  );
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length === 0)
    throw new CliError(`No job matches "${ref}".`, "List jobs with `qf jobs`.");
  throw new CliError(`"${ref}" matches ${matches.length} jobs.`, "Type more of the id.");
}

async function resolveApproval(client: QfClient, ref: string): Promise<string> {
  const pending = await client.approvals();
  const matches = pending.filter(
    (a) => a.id === ref || a.id.startsWith(ref) || a.id.startsWith(`apr_${ref}`),
  );
  const exact = matches.find((a) => a.id === ref);
  if (exact) return exact.id;
  const [only] = matches;
  if (matches.length === 1 && only) return only.id;
  if (matches.length === 0) {
    throw new CliError(`No pending approval matches "${ref}".`, "List them with `qf approvals`.");
  }
  throw new CliError(`"${ref}" matches ${matches.length} approvals.`, "Type more of the id.");
}

/** Prints the end-of-turn line and what to do next. */
async function summarize(ctx: Context, client: QfClient, result: FollowResult): Promise<void> {
  const s = ctx.style;
  if (!result.jobId || result.detached) {
    if (result.jobId)
      ctx.print(
        s.dim(`Stopped following ${result.jobId}. Pick it up with \`qf attach ${result.jobId}\`.`),
      );
    return;
  }
  let view: JobView | null = null;
  try {
    view = await client.job(result.jobId);
  } catch {
    // The daemon may be gone; the stream already said so.
  }
  const id = result.jobId;
  if (result.state === "done" || result.state === "idle") {
    const parts = [result.state === "done" ? s.green("✓ Done") : "Turn ended"];
    parts.push(duration(Date.now() - result.startedAt));
    if (view) parts.push(`${view.toolCalls} tool call${view.toolCalls === 1 ? "" : "s"}`);
    const usage = result.renderer.usage ?? view?.usage;
    if (usage) parts.push(`context ${count(usage.used)}/${count(usage.size)} tokens`);
    ctx.print(parts.join(s.dim(" · ")));
    if (view?.job.branch)
      ctx.print(
        s.dim(
          `  Branch ${view.job.branch} · review with \`qf diff ${id}\`, then \`qf merge ${id}\``,
        ),
      );
    else if (view?.job.workspace === "folder" && view.job.workspacePath) {
      ctx.print(s.dim(`  Files are in ${view.job.workspacePath}`));
    }
    ctx.print(s.dim(`  Follow up with \`qf say ${id} "…"\``));
  } else if (result.state === "failed") {
    ctx.print(s.dim(`  Full log: \`qf show ${id} --verbose\``));
  }
}

async function runFollow(
  ctx: Context,
  connection: Connection,
  mode: "run" | "attach" | "say",
  begin: (client: QfClient) => Promise<string>,
): Promise<number> {
  const { client } = connection;
  try {
    const result = await follow({
      client,
      io: ctx.io,
      style: ctx.style,
      verbose: ctx.values.verbose === true,
      mode,
      interactive: ctx.io.interactive,
      begin: () => begin(client),
    });
    await summarize(ctx, client, result);
    return result.code;
  } finally {
    if (connection.embedded) {
      ctx.io.err(ctx.style.dim("Stopping the temporary daemon…\n"));
      await connection.embedded.close();
    }
  }
}

/** Warns when the running daemon serves another project than the one qf was started in. */
async function checkRoot(ctx: Context, client: QfClient): Promise<void> {
  const here = ctx.root();
  const { root } = await client.state();
  const inside = path.relative(root, here);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    ctx.io.err(
      ctx.style.amber(
        `! The daemon at ${ctx.url()} serves ${root}, not ${here}. The job runs there.\n`,
      ),
    );
  }
}

const COMMANDS: Record<string, Command> = {
  up: {
    group: "Daemon",
    usage: "up [--port <port>]",
    summary: "Start the daemon and web UI for this project and keep it running",
    options: { port: { type: "string", short: "p" } },
    async run(ctx) {
      const portFlag = str(ctx.values, "port");
      const port =
        portFlag !== undefined
          ? Number.parseInt(portFlag, 10)
          : ctx.explicitUrl
            ? Number(new URL(ctx.url()).port)
            : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        throw new CliError(`"${portFlag}" is not a valid port.`, undefined, 2);
      }
      const { startDaemon } = await import("@quantaflow/daemon");
      const daemon = await startDaemon({
        root: ctx.root(),
        ...(port !== undefined ? { port } : {}),
        logWarnings: false,
      });
      for (const warning of daemon.warnings) ctx.io.err(ctx.style.amber(`! ${warning}\n`));
      ctx.print(
        `${ctx.style.bold("QuantaFlow")} ${VERSION} is running at ${ctx.style.cyan(daemon.url)}`,
      );
      ctx.print(ctx.style.dim(`Project: ${daemon.config.root}. Press Ctrl+C to stop.`));
      await new Promise<void>((resolve) => {
        let stopping = false;
        const remove = ctx.io.onInterrupt(() => {
          if (stopping) process.exit(130);
          stopping = true;
          ctx.print(ctx.style.dim("Stopping QuantaFlow… press Ctrl+C again to force it."));
          void daemon.close().then(() => {
            remove();
            resolve();
          });
        });
      });
      return 0;
    },
  },

  status: {
    group: "Daemon",
    usage: "status",
    summary: "Show the daemon, its project and what its jobs are doing",
    async run(ctx) {
      const { client } = await ctx.connect();
      const state = await client.state();
      if (ctx.values.json) {
        ctx.json(state);
        return 0;
      }
      const s = ctx.style;
      const counts = countStates(state.jobs);
      const active = STATE_ORDER.filter((st) => counts[st] > 0)
        .map((st) => `${counts[st]} ${stateLabel(st, s).toLowerCase()}`)
        .join(", ");
      ctx.print(`${s.bold("QuantaFlow")} ${state.version} at ${s.cyan(ctx.url())}`);
      ctx.print(`Project    ${state.root}`);
      ctx.print(`Agents     ${state.agents.length}`);
      ctx.print(`Jobs       ${state.jobs.length}${active ? ` (${active})` : ""}`);
      const waiting = state.approvals.length;
      ctx.print(`Approvals  ${waiting ? s.amber(`${waiting} waiting for you`) : "none waiting"}`);
      return 0;
    },
  },

  harnesses: {
    group: "Agents",
    usage: "harnesses",
    summary: "List the agent harnesses QuantaFlow can drive",
    async run(ctx) {
      const { client } = await ctx.connect();
      const list = await client.harnesses();
      if (ctx.values.json) {
        ctx.json(list);
        return 0;
      }
      const s = ctx.style;
      ctx.print(
        table(
          ["ID", "NAME", "CLI FOUND", "LAUNCH"],
          list.map((h) => [
            h.id,
            h.label,
            h.found ? s.green("yes") : s.dim("no"),
            s.dim(oneLine([h.command, ...h.args].join(" "), 60)),
          ]),
          s,
        ),
      );
      const missing = list.filter((h) => !h.found);
      if (missing.length > 0) {
        ctx.print("");
        for (const h of missing) ctx.print(s.dim(`${h.id}: ${h.install}`));
      }
      return 0;
    },
  },

  agents: {
    group: "Agents",
    usage: "agents",
    summary: "List agents",
    async run(ctx) {
      const { client } = await ctx.connect();
      const list = await client.agents();
      if (ctx.values.json) {
        ctx.json(list);
        return 0;
      }
      if (list.length === 0) {
        ctx.print(
          "No agents yet. Create some with `qf init`, or `qf agent add <id> --harness <harness>`.",
        );
        return 0;
      }
      const s = ctx.style;
      ctx.print(
        table(
          ["ID", "NAME", "HARNESS", "MODEL", "WORKSPACE", "POLICY", "FROM"],
          list.map((a) => [
            a.id,
            a.name,
            a.harness,
            a.model ?? s.dim("default"),
            a.workspace,
            a.policy.preset,
            a.source === "file" ? "file" : "qf",
          ]),
          s,
        ),
      );
      return 0;
    },
  },

  agent: {
    group: "Agents",
    usage: "agent add <id> --harness <harness> [options] | agent rm <id>",
    summary: "Add or remove an agent",
    options: {
      harness: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      model: { type: "string" },
      instructions: { type: "string" },
      "instructions-file": { type: "string" },
      workspace: { type: "string" },
      preset: { type: "string" },
    },
    async run(ctx) {
      const action = need(ctx, 0, "an action (add or rm)", this.usage);
      const id = need(ctx, 1, "the agent id", this.usage);
      const { client } = await ctx.connect();
      if (action === "rm" || action === "remove") {
        await client.deleteAgent(id);
        ctx.print(`Removed agent ${id}.`);
        return 0;
      }
      if (action !== "add")
        throw new CliError(`Unknown action "${action}".`, `Usage: qf ${this.usage}`, 2);
      const harness = str(ctx.values, "harness");
      if (!harness)
        throw new CliError("--harness is required.", "See the choices with `qf harnesses`.", 2);
      const file = str(ctx.values, "instructions-file");
      const instructions = file
        ? await readFile(path.resolve(ctx.io.cwd, file), "utf8")
        : str(ctx.values, "instructions");
      const workspace = oneOf(str(ctx.values, "workspace"), WORKSPACES, "workspace");
      const preset = oneOf(str(ctx.values, "preset"), PRESETS, "preset");
      const model = str(ctx.values, "model");
      const description = str(ctx.values, "description");
      const input: AgentProfileInput = {
        id,
        name:
          str(ctx.values, "name") ??
          id.replace(
            /(^|-)([a-z0-9])/g,
            (_m, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`,
          ),
        harness,
        ...(model ? { model } : {}),
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
        ...(workspace ? { workspace } : {}),
        ...(preset ? { policy: { preset, rules: [] } } : {}),
      };
      const agent = await client.createAgent(input);
      ctx.print(
        `Added agent ${ctx.style.bold(agent.id)} (${agent.harness}, ${agent.workspace}, ${agent.policy.preset} policy).`,
      );
      ctx.print(ctx.style.dim(`  ${PRESET_DESCRIPTIONS[agent.policy.preset]}`));
      return 0;
    },
  },

  init: {
    group: "Agents",
    usage: "init",
    summary: "Create .quantaflow/ with a config template, an assistant and a demo agent",
    async run(ctx) {
      const root = ctx.root();
      const result = await initProject(root);
      const s = ctx.style;
      for (const file of result.created)
        ctx.print(`${s.green("created")} ${path.relative(root, file)}`);
      for (const file of result.skipped)
        ctx.print(`${s.dim("exists ")} ${path.relative(root, file)}`);
      ctx.print("");
      ctx.print(`Try it: ${s.bold('qf run demo "write a summary and run the tests"')}`);
      ctx.print(s.dim("Agents in .quantaflow/agents/ can be committed and shared with your team."));
      return 0;
    },
  },

  run: {
    group: "Jobs",
    usage:
      "run <agent> <prompt…> [--orchestrate] [--detach] [--title <t>] [--workspace <mode>] [--after <job>]…",
    summary:
      "Start a job and follow it, answering approvals here. Use - to read the prompt from stdin",
    options: {
      detach: { type: "boolean", short: "d" },
      orchestrate: { type: "boolean", short: "o" },
      title: { type: "string" },
      workspace: { type: "string" },
      after: { type: "string", multiple: true },
    },
    async run(ctx) {
      const agentId = need(ctx, 0, "the agent id", this.usage);
      let prompt = ctx.positionals.slice(1).join(" ").trim();
      if (prompt === "-") prompt = (await ctx.io.readStdin()).trim();
      if (!prompt) throw new CliError("Missing the prompt.", `Usage: qf ${this.usage}`, 2);
      const workspace = oneOf(str(ctx.values, "workspace"), WORKSPACES, "workspace");
      const title = str(ctx.values, "title");
      const detach = ctx.values.detach === true;
      const orchestrate = ctx.values.orchestrate === true;
      const connection = await ctx.connect(!detach);
      const { client } = connection;
      await checkRoot(ctx, client);
      const dependsOn: string[] = [];
      for (const ref of strs(ctx.values, "after"))
        dependsOn.push((await resolveJob(client, ref)).job.id);
      const create = async (c: QfClient) => {
        const job = await c.createJob({
          agentId,
          prompt,
          ...(title ? { title } : {}),
          ...(workspace ? { workspace } : {}),
          ...(dependsOn.length ? { dependsOn } : {}),
          ...(orchestrate ? { role: "orchestrator" as const } : {}),
        });
        if (!detach) {
          const after = dependsOn.length ? ` · waits for ${dependsOn.join(", ")}` : "";
          const role = orchestrate ? " · orchestrator" : "";
          ctx.print(
            ctx.style.dim(
              `Job ${job.id} · ${job.agentId} on ${job.harness} · ${job.workspace}${role}${after}`,
            ),
          );
        }
        return job.id;
      };
      if (detach) {
        const id = await create(client);
        if (ctx.values.json) {
          ctx.json({ id });
          return 0;
        }
        ctx.print(id);
        return 0;
      }
      return runFollow(ctx, connection, "run", create);
    },
  },

  jobs: {
    group: "Jobs",
    usage: "jobs [--limit <n>]",
    summary: "List jobs, newest first",
    options: { limit: { type: "string", short: "n" } },
    async run(ctx) {
      const { client } = await ctx.connect();
      const limit = Number.parseInt(str(ctx.values, "limit") ?? "20", 10) || 20;
      const views = (await client.jobs()).sort((a, b) => b.job.createdAt - a.job.createdAt);
      if (ctx.values.json) {
        ctx.json(views.slice(0, limit));
        return 0;
      }
      if (views.length === 0) {
        ctx.print('No jobs yet. Start one with `qf run <agent> "<prompt>"`.');
        return 0;
      }
      const s = ctx.style;
      ctx.print(
        table(
          ["ID", "AGENT", "STATE", "STARTED", "TOOLS", "TITLE"],
          views
            .slice(0, limit)
            .map((v) => [
              v.job.id,
              v.job.agentId,
              stateLabel(v.job.status, s) +
                (v.pendingApprovals ? s.amber(` (${v.pendingApprovals})`) : ""),
              ago(v.job.createdAt),
              String(v.toolCalls),
              (v.job.parentJobId
                ? s.dim("↳ ")
                : v.job.role === "orchestrator"
                  ? s.cyan("◆ ")
                  : "") + oneLine(v.job.title, 60),
            ]),
          s,
        ),
      );
      if (views.length > limit)
        ctx.print(s.dim(`… and ${views.length - limit} more. Use --limit to see them.`));
      return 0;
    },
  },

  show: {
    group: "Jobs",
    usage: "show <job>",
    summary: "Print a job's conversation, tool calls and approvals",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const { client } = await ctx.connect();
      const view = await resolveJob(client, ref);
      const { events } = await client.events(view.job.id, 0);
      if (ctx.values.json) {
        ctx.json({ view, events });
        return 0;
      }
      const s = ctx.style;
      ctx.print(
        `${s.bold(view.job.title)}\n${s.dim(`${view.job.id} · ${view.job.agentId} on ${view.job.harness} · `)}${stateLabel(view.job.status, s)}`,
      );
      const renderer = new Renderer((text) => ctx.io.out(text), s, {
        verbose: ctx.values.verbose === true,
        echoUser: true,
      });
      for (const event of events) renderer.event(event);
      renderer.finish();
      for (const id of renderer.unresolved) {
        const ask = renderer.describeAsk(id);
        ctx.print(
          s.amber(
            `⏸ Waiting for your approval · ${ask?.kind}: ${oneLine(ask?.title ?? id, 90)}  (qf approve ${id})`,
          ),
        );
      }
      return 0;
    },
  },

  attach: {
    group: "Jobs",
    usage: "attach <job>",
    summary: "Follow a job that is already running and answer its approvals",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const connection = await ctx.connect();
      const view = await resolveJob(connection.client, ref);
      return runFollow(ctx, connection, "attach", async () => view.job.id);
    },
  },

  say: {
    group: "Jobs",
    usage: "say <job> <message…>",
    summary: "Send a follow-up message to a job and follow the reply",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      let text = ctx.positionals.slice(1).join(" ").trim();
      if (text === "-") text = (await ctx.io.readStdin()).trim();
      if (!text) throw new CliError("Missing the message.", `Usage: qf ${this.usage}`, 2);
      const connection = await ctx.connect(true);
      const view = await resolveJob(connection.client, ref);
      return runFollow(ctx, connection, "say", async (client) => {
        await client.sendMessage(view.job.id, text);
        return view.job.id;
      });
    },
  },

  diff: {
    group: "Jobs",
    usage: "diff <job>",
    summary: "Print the changes a job made, including new files",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const { client } = await ctx.connect();
      const view = await resolveJob(client, ref);
      const result = await client.diff(view.job.id);
      if (ctx.values.json) {
        ctx.json(result);
        return 0;
      }
      if (!result.available)
        throw new CliError(result.reason ?? "No diff is available for this job.");
      if (!result.diff.trim()) {
        ctx.print(ctx.style.dim("No changes yet."));
        return 0;
      }
      const s = ctx.style;
      const colored = s.enabled
        ? result.diff
            .split("\n")
            .map((line) =>
              line.startsWith("+++") || line.startsWith("---")
                ? s.bold(line)
                : line.startsWith("+")
                  ? s.green(line)
                  : line.startsWith("-")
                    ? s.red(line)
                    : line.startsWith("@@")
                      ? s.cyan(line)
                      : line,
            )
            .join("\n")
        : result.diff;
      ctx.io.out(colored.endsWith("\n") ? colored : `${colored}\n`);
      return 0;
    },
  },

  merge: {
    group: "Jobs",
    usage: "merge <job> [--squash] [-m <message>]",
    summary:
      "Commit a finished job's work and merge its branch into the branch you have checked out",
    options: { squash: { type: "boolean" }, message: { type: "string", short: "m" } },
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const { client } = await ctx.connect();
      const view = await resolveJob(client, ref);
      const message = str(ctx.values, "message");
      try {
        const result = await client.merge(view.job.id, {
          strategy: ctx.values.squash ? "squash" : "merge",
          ...(message ? { message } : {}),
        });
        if (ctx.values.json) {
          ctx.json(result);
          return 0;
        }
        const how = result.strategy === "squash" ? "Squashed" : "Merged";
        ctx.print(
          `${ctx.style.green("✓")} ${how} ${view.job.branch} into ${ctx.style.bold(result.into)} as ${result.commit.slice(0, 10)}.`,
        );
        ctx.print(
          ctx.style.dim(`  Remove the worktree and branch with \`qf discard ${view.job.id}\`.`),
        );
        return 0;
      } catch (error) {
        const details =
          error instanceof QfApiError
            ? (error.body as { details?: { conflicts?: string[]; files?: string[] } } | undefined)
                ?.details
            : undefined;
        const files = details?.conflicts ?? details?.files;
        if (files?.length) {
          throw new CliError(
            (error as Error).message,
            files
              .slice(0, 20)
              .map((f) => `  ${f}`)
              .join("\n") + (files.length > 20 ? `\n  … ${files.length - 20} more` : ""),
          );
        }
        throw error;
      }
    },
  },

  discard: {
    group: "Jobs",
    usage: "discard <job>",
    summary: "Delete a stopped job's worktree and branch, or its folder",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const { client } = await ctx.connect();
      const view = await resolveJob(client, ref);
      await client.discard(view.job.id);
      const what = view.job.branch ? `worktree and branch ${view.job.branch}` : "folder";
      ctx.print(`Discarded the ${what} of ${view.job.id}.`);
      return 0;
    },
  },

  cancel: {
    group: "Jobs",
    usage: "cancel <job>",
    summary: "Stop a job",
    async run(ctx) {
      const ref = need(ctx, 0, "the job id", this.usage);
      const { client } = await ctx.connect();
      const view = await resolveJob(client, ref);
      if (TERMINAL_STATES.has(view.job.status)) {
        ctx.print(`${view.job.id} already ended (${STATE_LABELS[view.job.status].toLowerCase()}).`);
        return 0;
      }
      await client.cancelJob(view.job.id);
      // Cancelling asks the agent to stop; wait a moment for it to confirm.
      const deadline = Date.now() + CANCEL_WAIT_MS;
      let status = view.job.status;
      while (Date.now() < deadline) {
        status = (await client.job(view.job.id)).job.status;
        if (TERMINAL_STATES.has(status) || status === "idle") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (status === "cancelled") ctx.print(`Cancelled ${view.job.id}.`);
      else if (TERMINAL_STATES.has(status) || status === "idle") {
        ctx.print(
          `${view.job.id} ended as ${STATE_LABELS[status].toLowerCase()} before the cancel landed.`,
        );
      } else {
        ctx.print(
          `Asked ${view.job.id} to stop. It is still ${STATE_LABELS[status].toLowerCase()}; check with \`qf jobs\`.`,
        );
      }
      return 0;
    },
  },

  approvals: {
    group: "Approvals",
    usage: "approvals",
    summary: "List approvals waiting for you, from every job",
    async run(ctx) {
      const { client } = await ctx.connect();
      const list = await client.approvals();
      if (ctx.values.json) {
        ctx.json(list);
        return 0;
      }
      if (list.length === 0) {
        ctx.print("Nothing is waiting for you.");
        return 0;
      }
      const s = ctx.style;
      ctx.print(
        table(
          ["ID", "JOB", "KIND", "ASKED", "WHAT"],
          list.map((a) => [a.id, a.jobId, s.amber(a.kind), ago(a.createdAt), oneLine(a.title, 70)]),
          s,
        ),
      );
      ctx.print(
        s.dim("\nDecide with `qf approve <id>` (add --always to remember it) or `qf deny <id>`."),
      );
      return 0;
    },
  },

  approve: {
    group: "Approvals",
    usage: "approve <approval> [--always]",
    summary: "Allow a waiting tool call",
    options: { always: { type: "boolean" } },
    async run(ctx) {
      const ref = need(ctx, 0, "the approval id", this.usage);
      const { client } = await ctx.connect();
      const id = await resolveApproval(client, ref);
      await client.decide(id, ctx.values.always ? "allow_always" : "allow");
      ctx.print(`Allowed ${id}${ctx.values.always ? " (always)" : ""}.`);
      return 0;
    },
  },

  deny: {
    group: "Approvals",
    usage: "deny <approval>",
    summary: "Deny a waiting tool call",
    async run(ctx) {
      const ref = need(ctx, 0, "the approval id", this.usage);
      const { client } = await ctx.connect();
      const id = await resolveApproval(client, ref);
      await client.decide(id, "deny");
      ctx.print(`Denied ${id}.`);
      return 0;
    },
  },
};

const ALIASES: Record<string, string> = { ls: "jobs", log: "show", start: "up", daemon: "up" };

function helpText(s: Style): string {
  const groups = ["Daemon", "Agents", "Jobs", "Approvals"] as const;
  const lines = [
    `${s.bold("qf")} ${VERSION} · run, follow and approve AI agent jobs`,
    "",
    `${s.bold("Usage:")} qf <command> [options]`,
  ];
  for (const group of groups) {
    lines.push("", s.bold(group));
    for (const [name, command] of Object.entries(COMMANDS)) {
      if (command.group !== group) continue;
      lines.push(`  ${name.padEnd(10)} ${command.summary}`);
    }
  }
  lines.push(
    "",
    s.bold("Options"),
    `  --url <url>    Daemon address (default ${DEFAULT_URL}, or QF_URL)`,
    "  --root <dir>   Project folder (default: nearest folder with .quantaflow/, or the git root)",
    "  --json         Print JSON instead of tables",
    "  --verbose      Show thoughts, harness stderr and tool output",
    "  --no-color     Plain output (NO_COLOR works too)",
    "",
    `Jobs accept a full id, a unique prefix, or ${s.bold("last")}. Run ${s.bold("qf <command> --help")} for its options.`,
  );
  return lines.join("\n");
}

function commandHelp(name: string, command: Command, s: Style): string {
  const lines = [`${s.bold("Usage:")} qf ${command.usage}`, "", command.summary];
  const options = Object.entries(command.options ?? {});
  if (options.length > 0) {
    lines.push("", s.bold("Options"));
    for (const [flag, spec] of options) {
      const short = "short" in spec && spec.short ? `-${spec.short}, ` : "";
      lines.push(`  ${short}--${flag}${spec.type === "string" ? " <value>" : ""}`);
    }
  }
  if (name === "agent") {
    lines.push(
      "",
      "Workspaces: worktree (own branch, the default), folder (fresh folder), cwd (this checkout)",
      "Presets: readonly, safe (the default), trusted",
    );
  }
  return lines.join("\n");
}

/** Finds the command word, skipping global options and their values. */
function splitCommand(argv: string[]): { name: string | undefined; rest: string[] } {
  const takesValue = new Set(["--url", "--root"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (takesValue.has(arg)) i += 1;
      continue;
    }
    return { name: arg, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { name: undefined, rest: argv };
}

function describeError(error: unknown, s: Style): { text: string; code: number } {
  if (error instanceof CliError) {
    return {
      text: `${s.red("error:")} ${error.message}${error.hint ? `\n${s.dim(error.hint)}` : ""}`,
      code: error.code,
    };
  }
  if (error instanceof QfApiError) {
    const lines = [`${s.red("error:")} ${error.message}`];
    const details = (error.body as { details?: unknown } | undefined)?.details;
    if (Array.isArray(details)) {
      for (const issue of details as { path?: (string | number)[]; message?: string }[]) {
        const where = issue.path?.length ? `${issue.path.join(".")}: ` : "";
        lines.push(s.dim(`  ${where}${issue.message ?? ""}`));
      }
    }
    return { text: lines.join("\n"), code: 1 };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS")
  ) {
    return { text: `${s.red("error:")} ${error.message}`, code: 2 };
  }
  return {
    text: `${s.red("error:")} ${error instanceof Error ? error.message : String(error)}`,
    code: 1,
  };
}

/** Runs one `qf` invocation and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const plainStyle = makeStyle(false);
  let style = makeStyle(wantsColor(io.stdoutIsTty, io.env, argv.includes("--no-color")));
  try {
    const { name: raw, rest } = splitCommand(argv);
    const name = raw ? (ALIASES[raw] ?? raw) : undefined;
    const command = name ? COMMANDS[name] : undefined;
    if (raw && !command) {
      throw new CliError(`Unknown command "${raw}".`, "Run `qf --help` to see the commands.", 2);
    }
    const parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...command?.options },
      allowPositionals: true,
      strict: true,
    });
    const values = parsed.values as Values;
    if (values["no-color"]) style = plainStyle;
    if (values.version) {
      io.out(`${VERSION}\n`);
      return 0;
    }
    if (!command || !name) {
      io.out(`${helpText(style)}\n`);
      return 0;
    }
    if (values.help) {
      io.out(`${commandHelp(name, command, style)}\n`);
      return 0;
    }

    const explicitUrl = str(values, "url") !== undefined || io.env.QF_URL !== undefined;
    let root: string | undefined;
    let url: string | undefined;
    const ctx: Context = {
      io,
      style,
      values,
      positionals: parsed.positionals,
      explicitUrl,
      root: () => {
        const flag = str(values, "root");
        root ??= flag ? path.resolve(io.cwd, flag) : findProjectRoot(io.cwd);
        return root;
      },
      url: () => {
        url ??= daemonUrl(str(values, "url"), io.env);
        return url;
      },
      connect: async (autoStart = false) => {
        const target = ctx.url();
        return connect({
          url: target,
          ...(explicitUrl ? { port: Number(new URL(target).port) } : {}),
          autoStart,
          root: ctx.root(),
          onStarted: (started, warnings) => {
            url = started;
            for (const warning of warnings) io.err(style.amber(`! ${warning}\n`));
            io.err(
              style.dim(
                `Started a temporary daemon at ${started} for ${ctx.root()}. It stops when this command ends; \`qf up\` keeps one running.\n`,
              ),
            );
          },
        });
      },
      print: (text) => io.out(`${text}\n`),
      json: (value) => io.out(`${JSON.stringify(value, null, 2)}\n`),
    };
    return await command.run(ctx);
  } catch (error) {
    const { text, code } = describeError(error, style);
    io.err(`${text}\n`);
    return code;
  }
}
