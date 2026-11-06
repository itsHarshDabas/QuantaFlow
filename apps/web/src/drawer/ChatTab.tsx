import { buildTranscript, type JobView, type QfEvent } from "@quantaflow/core";
import { CornerDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty } from "../components/ui";
import { api } from "../lib/backend";
import { errorMessage } from "../lib/errors";
import { TranscriptItemView } from "./Transcript";

/** Whether the job can take a follow-up now, and why not if it can't. */
function composerState(view: JobView): { ready: boolean; hint: string } {
  switch (view.job.status) {
    case "idle":
    case "done":
      return { ready: true, hint: "Enter to send, Shift+Enter for a new line" };
    case "needs_input":
      return { ready: false, hint: "Answer the request above first." };
    case "working":
    case "starting":
      return { ready: false, hint: "You can reply when this turn ends." };
    case "queued":
      return { ready: false, hint: "This job hasn't started yet." };
    case "failed":
    case "cancelled":
      return { ready: false, hint: "This job has ended. Start a new job to continue the work." };
  }
}

function Composer({ view }: { view: JobView }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ready, hint } = composerState(view);

  async function send() {
    const message = text.trim();
    if (!message || !ready || sending) return;
    setSending(true);
    setError(null);
    try {
      await api().sendMessage(view.job.id, message);
      setText("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="shrink-0 border-t border-line bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="sr-only" htmlFor={`compose-${view.job.id}`}>
        Message the agent
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={`compose-${view.job.id}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder={ready ? "Send a follow-up" : hint}
          disabled={!ready}
          className="min-h-8 flex-1 resize-none rounded-md border border-line bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || sending || !text.trim()}
          aria-label="Send"
        >
          <CornerDownLeft className="size-4" aria-hidden />
        </Button>
      </div>
      <p
        className={error ? "mt-1.5 text-xs text-stop" : "mt-1.5 text-xs text-ink-faint"}
        role={error ? "alert" : undefined}
      >
        {error ?? (ready ? hint : "")}
      </p>
    </form>
  );
}

export function ChatTab({
  view,
  events,
  status,
}: {
  view: JobView;
  events: QfEvent[];
  status: "idle" | "loading" | "ready" | "error";
}) {
  const items = useMemo(() => buildTranscript(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Stay at the bottom while new output streams in, unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    pinned.current = true;
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        aria-live="polite"
        aria-busy={status === "loading"}
      >
        {status === "loading" && items.length === 0 && (
          <p className="text-sm text-ink-muted">Loading the conversation…</p>
        )}
        {status === "ready" && items.length === 0 && (
          <Empty title="Nothing yet" className="p-0">
            The agent's messages, tool calls and requests appear here as it works.
          </Empty>
        )}
        {items.map((item) => (
          <TranscriptItemView key={item.key} item={item} />
        ))}
      </div>
      <Composer view={view} />
    </div>
  );
}
