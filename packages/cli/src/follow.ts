import {
  type PendingApproval,
  QfApiError,
  type QfClient,
  type QfEvent,
  type SessionState,
} from "@quantaflow/core";
import { oneLine } from "./format.js";
import type { Io } from "./io.js";
import { previewInput, Renderer } from "./render.js";
import type { Style } from "./style.js";

/** States where a turn is over and `qf` stops following. */
const END_STATES: ReadonlySet<SessionState> = new Set(["done", "idle", "failed", "cancelled"]);
const HELLO_TIMEOUT_MS = 10_000;

export type FollowMode = "run" | "attach" | "say";

export interface FollowSetup {
  client: QfClient;
  io: Io;
  style: Style;
  verbose: boolean;
  mode: FollowMode;
  /** Ask for approvals on this terminal. Otherwise print how to decide them elsewhere. */
  interactive: boolean;
  /** Runs once the stream is open: creates the job, sends the message, or names the job. */
  begin: () => Promise<string>;
}

export interface FollowResult {
  jobId: string | null;
  state: SessionState | null;
  /** Process exit code. */
  code: number;
  /** The person stopped following (second Ctrl+C) before the turn ended. */
  detached: boolean;
  renderer: Renderer;
  startedAt: number;
}

type Decision = "allow" | "allow_always" | "deny" | "skip";

export function parseAnswer(answer: string, hasAlways: boolean): Decision | null {
  const a = answer.trim().toLowerCase();
  if (a === "y" || a === "yes") return "allow";
  if (hasAlways && (a === "a" || a === "always")) return "allow_always";
  if (a === "n" || a === "no") return "deny";
  if (a === "s" || a === "skip") return "skip";
  return null;
}

/**
 * Follows one job's turn on the live stream until it ends, answering approvals on the terminal.
 * The stream opens before `begin` runs, and events are buffered until the job id is known, so no
 * event is missed even when the turn finishes before the create call returns.
 */
export function follow(setup: FollowSetup): Promise<FollowResult> {
  const { client, io, style: s, mode } = setup;
  const renderer = new Renderer((text) => io.out(text), s, {
    verbose: setup.verbose,
    echoUser: mode === "attach",
  });
  const startedAt = Date.now();

  return new Promise<FollowResult>((resolve, reject) => {
    let jobId: string | null = null;
    let ready = false;
    let renderedUpTo = 0;
    let finished = false;
    let interrupts = 0;
    let helloSeq: number | null = null;
    const buffer: QfEvent[] = [];
    const queue: string[] = [];
    let pumping = false;
    let current: { id: string; abort: AbortController } | null = null;

    const end = (state: SessionState | null, extra: { code?: number; detached?: boolean } = {}) => {
      if (finished) return;
      finished = true;
      current?.abort.abort();
      clearTimeout(helloTimer);
      removeInterrupt();
      stream.close();
      renderer.finish();
      const code =
        extra.code ??
        (state === "done" || state === "idle"
          ? 0
          : state === "cancelled" && interrupts > 0
            ? 130
            : 1);
      resolve({ jobId, state, code, detached: extra.detached ?? false, renderer, startedAt });
    };

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      current?.abort.abort();
      clearTimeout(helloTimer);
      removeInterrupt();
      stream.close();
      renderer.finish();
      reject(error);
    };

    const handle = (event: QfEvent) => {
      if (finished || event.jobId !== jobId || event.seq <= renderedUpTo) return;
      renderedUpTo = event.seq;
      renderer.event(event);
      if (event.type === "permission.requested") {
        queue.push(event.approvalId);
        void pump();
      } else if (event.type === "permission.resolved") {
        if (current?.id === event.approvalId) current.abort.abort();
      } else if (event.type === "job.state" && END_STATES.has(event.state)) {
        end(event.state);
      }
    };

    const prompt = async (approval: PendingApproval) => {
      const ask = renderer.describeAsk(approval.id);
      const tool = renderer.toolFor(ask?.toolCallId);
      const preview = previewInput(approval.input, 240, (f) => renderer.rel(f));
      const hasAlways = approval.options.some((o) => o.kind === "allow_always");
      const lines = [
        `${s.amber(s.bold(`⏸ Approve ${approval.kind}?`))} ${oneLine(approval.title, 120)}`,
      ];
      if (preview) lines.push(s.dim(`  ${preview}`));
      const files = (tool?.locations ?? []).map((f) => renderer.rel(f));
      // Skip the file list when the preview already names the only file.
      if (files.length > 0 && !(files.length === 1 && preview === `file: ${files[0]}`)) {
        lines.push(
          s.dim(`  files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`),
        );
      }
      renderer.line(lines.join("\n"));
      const choices = hasAlways
        ? "[y] allow  [a] always  [n] deny  [s] decide later"
        : "[y] allow  [n] deny  [s] decide later";

      const abort = new AbortController();
      current = { id: approval.id, abort };
      try {
        for (;;) {
          let answer: string;
          try {
            answer = await io.ask(`  ${s.amber(choices)} › `, abort.signal);
          } catch {
            return; // Decided elsewhere, the turn ended, or Ctrl+C.
          }
          const decision = parseAnswer(answer, hasAlways);
          if (decision === null) {
            renderer.line(s.dim(hasAlways ? "  Type y, a, n or s." : "  Type y, n or s."));
            continue;
          }
          if (decision === "skip") {
            renderer.line(
              s.dim(
                `  Left waiting. Decide later with \`qf approve ${approval.id}\` or in the web UI.`,
              ),
            );
            return;
          }
          try {
            await client.decide(approval.id, decision);
          } catch (error) {
            if (error instanceof QfApiError && error.status === 404) {
              renderer.line(s.dim("  It was already decided elsewhere."));
            } else {
              throw error;
            }
          }
          return;
        }
      } finally {
        current = null;
      }
    };

    const pump = async () => {
      if (pumping) return;
      pumping = true;
      try {
        for (;;) {
          const id = queue.shift();
          if (id === undefined || finished) break;
          if (!renderer.unresolved.has(id)) continue; // A policy already decided it.
          const pending = (await client.approvals()).find((a) => a.id === id);
          if (!pending || !renderer.unresolved.has(id) || finished) continue;
          if (setup.interactive) {
            await prompt(pending);
          } else {
            const ask = renderer.describeAsk(id);
            renderer.line(
              `${s.amber(`⏸ Waiting for your approval · ${pending.kind}: ${oneLine(ask?.title ?? pending.title, 90)}`)}\n${s.dim(
                `  Decide with \`qf approve ${id}\`, \`qf deny ${id}\` or in the web UI.`,
              )}`,
            );
          }
        }
      } catch (error) {
        renderer.line(s.red(`Could not handle an approval: ${(error as Error).message}`));
      } finally {
        pumping = false;
      }
    };

    const stream = client.subscribe({
      onMessage(message) {
        if (message.type === "hello") {
          if (helloSeq === null) {
            helloSeq = message.lastSeq;
            void start(message.lastSeq);
          }
        } else if (message.type === "event") {
          if (ready) handle(message.event);
          else buffer.push(message.event);
        }
      },
      onClose(event) {
        if (finished) return;
        if (helloSeq === null) {
          fail(new Error(`Could not open the event stream (code ${event.code}).`));
          return;
        }
        renderer.line(
          s.red(
            `Lost the connection to the daemon${event.reason ? `: ${event.reason}` : ""}. The job keeps running there.`,
          ),
        );
        end(null, { code: 1, detached: true });
      },
    });

    const helloTimer = setTimeout(
      () => fail(new Error("The daemon accepted the connection but never sent its hello.")),
      HELLO_TIMEOUT_MS,
    );

    const removeInterrupt = io.onInterrupt(() => {
      interrupts += 1;
      current?.abort.abort();
      if (interrupts === 1 && jobId && ready && !finished) {
        renderer.line(s.dim("Cancelling the job… press Ctrl+C again to stop following it."));
        const id = jobId;
        client.cancelJob(id).catch((error: unknown) => {
          renderer.line(s.red(`Could not cancel: ${(error as Error).message}`));
        });
      } else {
        end(null, { code: 130, detached: true });
      }
    });

    const start = async (lastSeq: number) => {
      clearTimeout(helloTimer);
      try {
        const id = await setup.begin();
        if (finished) return;
        jobId = id;
        renderedUpTo = lastSeq;
        let pendingForJob: PendingApproval[] = [];
        if (mode === "say") {
          renderer.workspacePath = (await client.job(id)).job.workspacePath;
        }
        if (mode === "attach") {
          const [{ events }, view, approvals] = await Promise.all([
            client.events(id, 0),
            client.job(id),
            client.approvals(),
          ]);
          for (const event of events) renderer.event(event);
          renderedUpTo = events.at(-1)?.seq ?? 0;
          if (END_STATES.has(view.job.status)) {
            ready = true;
            end(view.job.status);
            return;
          }
          pendingForJob = approvals.filter((a) => a.jobId === id);
        }
        ready = true;
        for (const event of buffer.splice(0)) handle(event);
        for (const approval of pendingForJob) {
          if (!queue.includes(approval.id)) queue.push(approval.id);
        }
        void pump();
      } catch (error) {
        fail(error);
      }
    };
  });
}
