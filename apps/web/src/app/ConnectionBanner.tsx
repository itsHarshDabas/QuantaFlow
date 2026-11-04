import { Button, Code, Lamp } from "../components/ui";
import { useNow } from "../lib/hooks";
import { retryNow } from "../lib/live";
import { useQf } from "../store/store";
import { Mark } from "./TopBar";

function useRetryIn(): number | null {
  const retryAt = useQf((s) => s.retryAt);
  const now = useNow(1000);
  return retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
}

/** A thin strip under the top bar while a connection that worked before is down. */
export function ConnectionBanner() {
  const connection = useQf((s) => s.connection);
  const everConnected = useQf((s) => s.everConnected);
  const seconds = useRetryIn();
  if (!everConnected || connection === "live") return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-line bg-stop-soft px-4 py-1.5 text-sm"
    >
      <Lamp tone="stop" />
      <span className="text-ink">
        {connection === "connecting"
          ? "Reconnecting to the daemon…"
          : `Lost the connection to the daemon. What you see may be out of date.${
              seconds !== null ? ` Retrying in ${seconds}s.` : ""
            }`}
      </span>
      {connection === "offline" && (
        <Button size="sm" variant="ghost" onClick={retryNow} className="ml-auto">
          Retry now
        </Button>
      )}
    </div>
  );
}

/** Shown until the first successful connection, with what to do if the daemon isn't running. */
export function FirstConnect() {
  const connection = useQf((s) => s.connection);
  const seconds = useRetryIn();
  const origin = location.origin;

  if (connection !== "offline") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted" role="status">
        Connecting to the daemon…
      </div>
    );
  }

  const demoUrl = `${location.pathname}?demo`;
  return (
    <div className="flex h-full items-start justify-center overflow-y-auto p-6 sm:items-center">
      <div className="w-full max-w-[34rem]">
        <Mark className="mb-5 size-10 text-run" />
        <h1 className="text-2xl font-semibold tracking-tight">The daemon isn't running</h1>
        <p className="mt-2 text-ink-muted">
          This page is the QuantaFlow control room. It needs the local daemon, which runs your
          agents, and it couldn't reach it from {origin}.
        </p>
        <ol className="mt-5 space-y-3 text-sm">
          <li>
            <p className="font-medium">If you installed QuantaFlow, start it in your project</p>
            <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[13px]">
              qf up
            </pre>
          </li>
          <li>
            <p className="font-medium">From a checkout of the QuantaFlow repo</p>
            <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[13px]">
              {"pnpm install && pnpm build\nnode packages/cli/dist/bin.js up --root <your project>"}
            </pre>
          </li>
        </ol>
        <p className="mt-4 text-sm text-ink-muted">
          Running the UI with <Code>pnpm dev</Code>? Start the daemon with{" "}
          <Code>QF_ALLOWED_ORIGINS={origin}</Code> so it accepts this page.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={retryNow}>
            Retry now
          </Button>
          <a
            href={demoUrl}
            className="text-sm font-medium text-run underline-offset-2 hover:underline"
          >
            Explore the demo instead
          </a>
          {seconds !== null && (
            <span className="text-xs text-ink-faint tabular" role="status">
              <Lamp tone="stop" size={6} /> Retrying in {seconds}s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
