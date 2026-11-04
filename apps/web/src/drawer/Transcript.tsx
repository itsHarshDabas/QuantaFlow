import { STATE_LABELS, type TranscriptItem } from "@quantaflow/core";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { InputPreview } from "../approvals/ApprovalsRail";
import { DecideButtons } from "../approvals/Decide";
import { cx, inlineCode, KindIcon } from "../components/ui";
import { diffLines, foldContext } from "../lib/diff";
import { formatClock, shortPath } from "../lib/format";
import { useQf } from "../store/store";

/** Splits agent text on ``` fences so code keeps its shape. Everything else stays plain text. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, index) => {
        // Parts come from splitting one string, so their order never changes.
        const key = `${index}:${part.length}`;
        if (index % 2 === 1) {
          const newline = part.indexOf("\n");
          const body = newline >= 0 ? part.slice(newline + 1) : part;
          return (
            <pre
              key={key}
              className="my-2 overflow-x-auto rounded-sm border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] leading-relaxed"
            >
              {body.replace(/\n$/, "")}
            </pre>
          );
        }
        return (
          <span key={key} className="whitespace-pre-wrap">
            {inlineCode(part)}
          </span>
        );
      })}
    </>
  );
}

const TOOL_STATUS = {
  pending: { icon: LoaderCircle, className: "text-ink-faint", label: "Pending" },
  in_progress: { icon: LoaderCircle, className: "animate-spin text-run", label: "Running" },
  completed: { icon: Check, className: "text-ok", label: "Done" },
  failed: { icon: X, className: "text-stop", label: "Failed" },
} as const;

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const status = TOOL_STATUS[item.status];
  const StatusIcon = status.icon;
  const hasBody =
    Boolean(item.output) || (item.diffs?.length ?? 0) > 0 || item.locations.length > 1;
  const summary = (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
      <KindIcon kind={item.toolKind} className="text-ink-muted" />
      <span className="min-w-0 flex-1 truncate">{inlineCode(item.title)}</span>
      <StatusIcon className={cx("size-3.5 shrink-0", status.className)} aria-label={status.label} />
    </span>
  );
  if (!hasBody) {
    return <div className="rounded-md border border-line bg-surface px-3 py-1.5">{summary}</div>;
  }
  return (
    <details className="group rounded-md border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
          aria-hidden
        />
        {summary}
      </summary>
      <div className="space-y-2 border-t border-line px-3 py-2">
        {item.locations.length > 0 && (
          <ul className="space-y-0.5 font-mono text-xs text-ink-muted">
            {item.locations.map((location) => (
              <li key={location} className="truncate" title={location}>
                {shortPath(location, 3)}
              </li>
            ))}
          </ul>
        )}
        {item.diffs?.map((diff) => (
          <FileDiffBlock
            key={diff.path}
            path={diff.path}
            oldText={diff.oldText ?? null}
            newText={diff.newText}
          />
        ))}
        {item.output && (
          <pre className="max-h-64 overflow-auto rounded-sm bg-sunken px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {item.output}
          </pre>
        )}
      </div>
    </details>
  );
}

/** A before/after view for edits the agent reported inline, with long unchanged runs folded. */
function FileDiffBlock({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const lines = useMemo(() => foldContext(diffLines(oldText, newText)), [oldText, newText]);
  return (
    <div className="overflow-hidden rounded-sm border border-line text-xs">
      <p className="truncate border-b border-line bg-raised px-2 py-1 font-mono">
        {shortPath(path, 3)}
        {oldText === null && <span className="ml-2 font-sans text-ink-faint">new file</span>}
      </p>
      <pre className="max-h-64 overflow-auto font-mono leading-relaxed">
        {lines.map((line) =>
          line.type === "fold" ? (
            <div key={line.key} className="bg-sunken px-2 text-ink-faint">
              {line.count} unchanged lines
            </div>
          ) : (
            <div
              key={`${line.type}:${line.oldLine ?? ""}:${line.newLine ?? ""}`}
              className={cx(
                "px-2",
                line.type === "add" && "bg-diff-add",
                line.type === "del" && "bg-diff-del",
              )}
            >
              <span
                className={cx(
                  "select-none",
                  line.type === "add"
                    ? "text-ok"
                    : line.type === "del"
                      ? "text-stop"
                      : "text-ink-faint",
                )}
              >
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
              </span>
              {line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  );
}

function PermissionRow({ item }: { item: Extract<TranscriptItem, { kind: "permission" }> }) {
  const approval = useQf((s) => s.approvals[item.approvalId]);
  // Routine policy approvals are noise in a conversation. The Events tab and the queue's
  // "Decided recently" list still show them.
  if (item.status === "allowed" && item.by === "policy") return null;
  if (item.status === "pending" && approval) {
    return (
      <div className="relative rounded-md border border-amber/60 bg-amber-soft py-2.5 pr-3 pl-4">
        <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-amber" aria-hidden />
        <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-text">
          <KindIcon kind={item.toolKind} />
          Asking you
        </p>
        <p className="mt-1 text-sm font-semibold">{inlineCode(item.title)}</p>
        {approval.input !== undefined && (
          <div className="mt-2">
            <InputPreview input={approval.input} jobId={approval.jobId} />
          </div>
        )}
        <DecideButtons approval={approval} className="mt-2.5" />
      </div>
    );
  }
  const by = item.by === "user" ? "you" : item.by === "policy" ? "policy" : "QuantaFlow";
  const text =
    item.status === "allowed"
      ? `Allowed by ${by}`
      : item.status === "denied"
        ? `Denied by ${by}`
        : item.status === "cancelled"
          ? "Request withdrawn"
          : "Waiting for an answer";
  return (
    <p className="flex items-start gap-1.5 px-1 text-xs text-ink-muted" title={item.reason}>
      {item.status === "allowed" ? (
        <Check className="mt-px size-3.5 shrink-0 text-ok" aria-hidden />
      ) : (
        <X className="mt-px size-3.5 shrink-0 text-stop" aria-hidden />
      )}
      <span>
        <span className="text-ink">{inlineCode(item.title)}</span>: {text}
        {item.reason && item.by !== "user" ? `. ${item.reason}` : ""}
      </span>
    </p>
  );
}

const PLAN_MARK: Record<string, string> = {
  completed: "text-ok",
  in_progress: "text-run",
  pending: "text-ink-faint",
};

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "message":
      if (item.role === "user") {
        return (
          <div className="rounded-md bg-raised px-3 py-2">
            <p className="mb-0.5 text-xs font-semibold text-ink-muted">You</p>
            <p className="text-sm whitespace-pre-wrap">{item.text}</p>
          </div>
        );
      }
      if (item.role === "thought") {
        return (
          <details className="group px-1 text-xs text-ink-muted">
            <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="size-3 transition-transform group-open:rotate-90"
                aria-hidden
              />
              Thinking
            </summary>
            <p className="mt-1 border-l border-line pl-3 whitespace-pre-wrap italic">{item.text}</p>
          </details>
        );
      }
      return (
        <div className="px-1 text-sm leading-relaxed">
          <RichText text={item.text} />
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "permission":
      return <PermissionRow item={item} />;
    case "plan":
      return (
        <div className="rounded-md border border-line px-3 py-2">
          <p className="mb-1 text-xs font-semibold text-ink-muted">Plan</p>
          <ol className="space-y-0.5 text-sm">
            {item.entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are replaced as a whole, never reordered
              <li key={`${index}-${entry.content}`} className="flex items-start gap-2">
                <span
                  className={cx(
                    "mt-[5px] size-2 shrink-0 rounded-[2px] border border-current",
                    PLAN_MARK[entry.status] ?? "text-ink-faint",
                    entry.status === "completed" && "bg-current",
                  )}
                  aria-hidden
                />
                <span
                  className={cx(
                    entry.status === "completed" &&
                      "text-ink-muted line-through decoration-ink-faint",
                  )}
                >
                  {entry.content}
                </span>
                <span className="sr-only">({entry.status.replace("_", " ")})</span>
              </li>
            ))}
          </ol>
        </div>
      );
    case "notice": {
      const Icon =
        item.severity === "error"
          ? CircleAlert
          : item.severity === "warning"
            ? TriangleAlert
            : Info;
      return (
        <div
          className={cx(
            "flex gap-2 rounded-md px-3 py-2 text-sm",
            item.severity === "error"
              ? "bg-stop-soft"
              : item.severity === "warning"
                ? "bg-raised"
                : "bg-raised",
          )}
        >
          <Icon
            className={cx(
              "mt-0.5 size-4 shrink-0",
              item.severity === "error" ? "text-stop" : "text-ink-muted",
            )}
            aria-hidden
          />
          <div>
            <p className="font-medium">{inlineCode(item.title)}</p>
            {item.description && (
              <p className="mt-0.5 text-ink-muted">
                <RichText text={item.description} />
              </p>
            )}
          </div>
        </div>
      );
    }
    case "state":
      return (
        <div className="flex items-center gap-3 py-1 text-xs text-ink-muted">
          <span className="h-px flex-1 bg-line" />
          <span
            className={cx(
              item.state === "failed" && "text-stop",
              item.state === "done" && "text-ok",
            )}
          >
            {STATE_LABELS[item.state]}
            {item.reason ? `: ${item.reason}` : ""} at {formatClock(item.ts)}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "turn":
      if (item.stopReason === "end_turn") return null;
      return (
        <p className="px-1 text-xs text-ink-faint">
          Turn stopped: {item.stopReason.replace(/_/g, " ")}
        </p>
      );
  }
}
