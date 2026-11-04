#!/usr/bin/env node
/**
 * A scripted ACP agent with no model behind it.
 *
 * It lets people try QuantaFlow without any API keys, and gives the test suite a
 * real ACP process to drive. It streams a reply, publishes a plan, reads a file,
 * asks permission to write one, and optionally asks to run a command.
 *
 * Prompt keywords change the script:
 * - "run" or "test": also asks to run a shell command.
 * - "readonly": skips the file edit.
 * - "fail": the turn fails with an error.
 * - "slow": every step takes four times longer.
 *
 * Set QF_FAKE_DELAY_MS to change the pause between steps (default 120, 0 in tests).
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

interface FakeSession {
  cwd: string;
  turns: number;
  turn?: AbortController;
}

class Cancelled extends Error {}

const sessions = new Map<string, FakeSession>();
const baseDelay = Math.max(0, Number.parseInt(process.env.QF_FAKE_DELAY_MS ?? "120", 10) || 0);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Cancelled());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function promptText(prompt: acp.ContentBlock[]): string {
  return prompt
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

const app = acp
  .agent({ name: "quantaflow-fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "quantaflow-fake-agent", title: "QuantaFlow demo agent", version: "0.1.0" },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, turns: 0 });
    return { sessionId };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.turn?.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.sessionNotFound(params.sessionId);

    const turn = new AbortController();
    session.turn = turn;
    session.turns += 1;
    const { sessionId } = params;
    const text = promptText(params.prompt);
    const lower = text.toLowerCase();
    const delay = lower.includes("slow") ? baseDelay * 4 : baseDelay;
    const pause = () => sleep(delay, turn.signal);
    const update = (u: acp.SessionUpdate) =>
      client.notify(acp.methods.client.session.update, { sessionId, update: u });
    const say = async (message: string) => {
      const messageId = randomUUID();
      for (const word of message.split(/(?<=\s)/)) {
        await update({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: word },
        });
        await sleep(Math.round(delay / 6), turn.signal);
      }
    };

    try {
      const firstLine = text.split("\n").at(-1) ?? text;
      const short = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
      await say(
        session.turns === 1
          ? `Got it. I'm a scripted demo agent, so I'll walk through the steps a real agent would take for: "${short}"\n\n`
          : `Following up on: "${short}"\n\n`,
      );

      const steps = ["Read the workspace", "Write a summary file", "Report back"];
      const plan = (done: number): acp.SessionUpdate => ({
        sessionUpdate: "plan",
        entries: steps.map((content, i) => ({
          content,
          priority: "medium",
          status: i < done ? "completed" : i === done ? "in_progress" : "pending",
        })),
      });
      await update(plan(0));
      await pause();

      await update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Looking at what is in the workspace first." },
      });
      await update({
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "List files in the workspace",
        kind: "read",
        status: "pending",
        locations: [{ path: session.cwd }],
      });
      const readAsk = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "read-1", title: "List files in the workspace", kind: "read" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const readAllowed =
        readAsk.outcome.outcome === "selected" && readAsk.outcome.optionId === "allow";
      let readme = "";
      if (readAllowed) {
        readme = await readFile(path.join(session.cwd, "README.md"), "utf8").catch(() => "");
      }
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        status: readAllowed ? "completed" : "failed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: readAllowed
                ? readme
                  ? `README.md has ${readme.split("\n").length} lines.`
                  : "No README.md here."
                : "Read was not allowed.",
            },
          },
        ],
      });
      await pause();

      if (lower.includes("fail")) {
        throw acp.RequestError.internalError(undefined, "Simulated failure, as the prompt asked");
      }

      if (!lower.includes("readonly")) {
        await update(plan(1));
        const target = path.join(session.cwd, "QUANTAFLOW_DEMO.md");
        const newText = `# QuantaFlow demo\n\nPrompt: ${short}\n\nWritten by the scripted demo agent on turn ${session.turns}.\n`;
        await update({
          sessionUpdate: "tool_call",
          toolCallId: `edit-${session.turns}`,
          title: "Write QUANTAFLOW_DEMO.md",
          kind: "edit",
          status: "pending",
          locations: [{ path: target }],
          content: [{ type: "diff", path: target, oldText: null, newText }],
          rawInput: { path: target },
        });
        const editAsk = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: `edit-${session.turns}`,
            title: "Write QUANTAFLOW_DEMO.md",
            kind: "edit",
            rawInput: { path: target },
          },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        const editAllowed =
          editAsk.outcome.outcome === "selected" && editAsk.outcome.optionId.startsWith("allow");
        if (editAllowed) await writeFile(target, newText, "utf8");
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: `edit-${session.turns}`,
          status: editAllowed ? "completed" : "failed",
        });
        await say(
          editAllowed ? "Wrote the summary file. " : "Skipped the file, since it wasn't allowed. ",
        );
        await pause();
      }

      if (/\b(run|test)\b/.test(lower)) {
        const command = "echo ok";
        await update({
          sessionUpdate: "tool_call",
          toolCallId: `run-${session.turns}`,
          title: `Run \`${command}\``,
          kind: "execute",
          status: "pending",
          rawInput: { command },
        });
        const runAsk = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: `run-${session.turns}`,
            title: `Run \`${command}\``,
            kind: "execute",
            rawInput: { command },
          },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        const runAllowed =
          runAsk.outcome.outcome === "selected" && runAsk.outcome.optionId === "allow-once";
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: `run-${session.turns}`,
          status: runAllowed ? "completed" : "failed",
          content: [
            { type: "content", content: { type: "text", text: runAllowed ? "ok" : "Not run." } },
          ],
        });
        await pause();
      }

      await update(plan(3));
      await update({
        sessionUpdate: "usage_update",
        used: 1200 * session.turns,
        size: 200_000,
        cost: { amount: 0, currency: "USD" },
      });
      await say("All done. Send a follow-up message if you want another pass.");
      return { stopReason: "end_turn" };
    } catch (error) {
      if (error instanceof Cancelled || turn.signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      if (session.turn === turn) session.turn = undefined;
    }
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
const connection = app.connect(stream);
await connection.closed;
process.exit(0);
