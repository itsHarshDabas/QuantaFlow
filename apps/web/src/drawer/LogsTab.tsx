import type { EventOf, QfEvent } from "@quantaflow/core";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Empty } from "../components/ui";
import { formatClock } from "../lib/format";

/** The harness's own stderr and system lines: what a terminal would have shown around the chat. */
export function LogsTab({ events }: { events: QfEvent[] }) {
  const lines = useMemo(
    () => events.filter((event): event is EventOf<"log"> => event.type === "log"),
    [events],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const count = lines.length;

  useLayoutEffect(() => {
    void count;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  if (lines.length === 0) {
    return (
      <Empty title="No log output" className="p-4">
        Lines the harness prints to stderr, like warnings and crash output, show up here.
      </Empty>
    );
  }

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-sunken px-4 py-3">
      <pre className="font-mono text-xs leading-relaxed">
        {lines.map((line) => (
          <div key={line.seq} className="flex gap-3">
            <span className="shrink-0 select-none text-ink-faint tabular">
              {formatClock(line.ts)}
            </span>
            <span className={line.stream === "stderr" ? "text-ink" : "text-ink-muted"}>
              {line.text.replace(/\n$/, "")}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
