import type { QfEvent } from "@quantaflow/core";
import { useMemo, useState } from "react";
import { cx, Empty } from "../components/ui";
import { formatClock } from "../lib/format";

type Filter = "all" | "tools" | "approvals" | "state" | "messages";

const FILTERS: { id: Filter; label: string; match: (e: QfEvent) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "tools", label: "Tools", match: (e) => e.type === "tool.call" || e.type === "tool.update" },
  {
    id: "approvals",
    label: "Approvals",
    match: (e) => e.type === "permission.requested" || e.type === "permission.resolved",
  },
  {
    id: "state",
    label: "Lifecycle",
    match: (e) => e.type.startsWith("job.") || e.type === "turn.ended",
  },
  { id: "messages", label: "Messages", match: (e) => e.type === "message" },
];

/** One line that says what an event was, without opening it. */
export function summarize(event: QfEvent): string {
  switch (event.type) {
    case "job.created":
      return `Created on ${event.job.harness}`;
    case "job.updated":
      return Object.keys(event.patch).join(", ") || "Updated";
    case "job.state":
      return event.reason ? `${event.state}: ${event.reason}` : event.state;
    case "message":
      return `${event.role}: ${event.text.replace(/\s+/g, " ").trim()}`;
    case "tool.call":
      return `${event.kind}: ${event.title} (${event.status})`;
    case "tool.update":
      return [event.title, event.status].filter(Boolean).join(" ") || "Output updated";
    case "plan":
      return `${event.entries.length} steps`;
    case "permission.requested":
      return event.title;
    case "permission.resolved":
      return `${event.outcome} by ${event.by}${event.reason ? `: ${event.reason}` : ""}`;
    case "usage":
      return `${event.usage.used.toLocaleString()} of ${event.usage.size.toLocaleString()} tokens`;
    case "notice":
      return `${event.severity}: ${event.title}`;
    case "log":
      return event.text;
    case "turn.ended":
      return event.stopReason;
  }
}

const SHOWN = 400;

export function EventsTab({ events }: { events: QfEvent[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [mergeChunks, setMergeChunks] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);

  const filtered = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
    const out: QfEvent[] = [];
    for (const event of events) {
      if (!match(event)) continue;
      const last = out.at(-1);
      // Streaming sends one event per few words. Folding them keeps the log readable.
      if (
        mergeChunks &&
        event.type === "message" &&
        last?.type === "message" &&
        last.role === event.role &&
        event.role !== "user" &&
        last.messageId === event.messageId
      ) {
        out[out.length - 1] = { ...last, text: last.text + event.text };
        continue;
      }
      out.push(event);
    }
    return out;
  }, [events, filter, mergeChunks]);

  const visible = all ? filtered : filtered.slice(-SHOWN);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx(
              "h-6 rounded-md px-2 text-xs",
              filter === f.id
                ? "bg-ink font-semibold text-surface"
                : "text-ink-muted hover:bg-raised",
            )}
          >
            {f.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            className="accent-ink"
            checked={mergeChunks}
            onChange={(event) => setMergeChunks(event.target.checked)}
          />
          Join streamed text
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <Empty title="No events" className="p-4">
            Nothing of this type has happened in this job.
          </Empty>
        ) : (
          <ol className="font-mono text-xs">
            {!all && filtered.length > SHOWN && (
              <li className="px-4 py-2">
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="font-sans text-run hover:underline"
                >
                  Show {filtered.length - SHOWN} earlier events
                </button>
              </li>
            )}
            {visible.map((event) => {
              const expanded = open === event.seq;
              return (
                <li key={event.seq} className="border-b border-line/60">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : event.seq)}
                    className="grid w-full grid-cols-[3.5rem_4.5rem_8.5rem_1fr] items-baseline gap-2 px-4 py-1 text-left hover:bg-raised"
                  >
                    <span className="text-ink-faint tabular">#{event.seq}</span>
                    <span className="text-ink-faint tabular">{formatClock(event.ts)}</span>
                    <span className="truncate text-ink-muted">{event.type}</span>
                    <span className="truncate font-sans text-ink">{summarize(event)}</span>
                  </button>
                  {expanded && (
                    <pre className="mx-4 mb-2 max-h-80 overflow-auto rounded-sm bg-sunken px-3 py-2 leading-relaxed whitespace-pre-wrap break-all">
                      {JSON.stringify(event, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
