import { createInterface } from "node:readline";

/** Everything the CLI touches outside itself, so tests can drive it in-process. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Whether stdout is a terminal, which turns color on by default. */
  stdoutIsTty: boolean;
  /** Whether approvals can be asked for on this terminal. */
  interactive: boolean;
  /** Asks one question and resolves with the typed line. Rejects if `signal` aborts first. */
  ask(question: string, signal: AbortSignal): Promise<string>;
  /** Registers a Ctrl+C handler and returns a function that removes it. */
  onInterrupt(handler: () => void): () => void;
  readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export class PromptAborted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PromptAborted";
  }
}

export function nodeIo(): Io {
  const handlers = new Set<() => void>();
  const onSigint = () => {
    for (const handler of [...handlers]) handler();
  };

  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask(question, signal) {
      return new Promise<string>((resolve, reject) => {
        // One interface per question, so stdin is released (and the process can exit) in between.
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          rl.close();
          finish();
        };
        const onAbort = () =>
          settle(() => {
            process.stdout.write("\n");
            reject(new PromptAborted("aborted"));
          });
        // While readline owns the terminal, Ctrl+C arrives here instead of as a process signal.
        rl.on("SIGINT", () => {
          settle(() => {
            process.stdout.write("\n");
            reject(new PromptAborted("interrupted"));
          });
          onSigint();
        });
        rl.on("close", () => settle(() => reject(new PromptAborted("closed"))));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        rl.question(question, (answer) => settle(() => resolve(answer)));
      });
    },
    onInterrupt(handler) {
      if (handlers.size === 0) process.on("SIGINT", onSigint);
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) process.off("SIGINT", onSigint);
      };
    },
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    env: process.env,
    cwd: process.cwd(),
  };
}
