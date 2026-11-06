import type { PendingApproval } from "@quantaflow/core";
import { Check, Minus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { cx, inlineCode, KIND_LABEL, KindIcon } from "../components/ui";
import { formatAgo, formatDuration, relativePath, shortPath } from "../lib/format";
import { harnessLabel, useAgentMap, useHarnessMap, useNow } from "../lib/hooks";
import { clip, previewInput } from "../lib/preview";
import { openJob } from "../lib/router";
import { approvalQueue, type Decision } from "../store/reduce";
import { useQf } from "../store/store";
import { useChrome } from "../store/ui";
import { availableChoices, DecideButtons, useDecide } from "./Decide";

export function InputPreview({
  input,
  jobId,
  compact,
}: {
  input: unknown;
  jobId?: string;
  compact?: boolean;
}) {
  const workspace = useQf((s) => (jobId ? s.jobs[jobId]?.job.workspacePath : null) ?? s.root);
  const preview = previewInput(input);
  const maxLines = compact ? 4 : 10;
  switch (preview.kind) {
    case "none":
      return null;
    case "command": {
      const { text, clipped } = clip(preview.command, maxLines);
      return (
        <pre className="overflow-x-auto rounded-sm bg-sunken px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink">
          <span className="select-none text-ink-faint">$ </span>
          {text}
          {clipped && <span className="text-ink-faint"> …</span>}
        </pre>
      );
    }
    case "file": {
      const detail = preview.detail ? clip(preview.detail, compact ? 3 : 8) : null;
      return (
        <div className="overflow-hidden rounded-sm bg-sunken text-xs">
          <p className="truncate px-2 py-1 font-mono text-ink" title={preview.path}>
            {shortPath(relativePath(preview.path, workspace), 3)}
          </p>
          {detail && (
            <pre className="max-h-40 overflow-auto border-t border-line px-2 py-1.5 font-mono leading-relaxed whitespace-pre-wrap text-ink-muted">
              {detail.text}
              {detail.clipped && "\n…"}
            </pre>
          )}
        </div>
      );
    }
    case "url":
      return (
        <p
          className="truncate rounded-sm bg-sunken px-2 py-1 font-mono text-xs text-ink"
          title={preview.url}
        >
          {preview.url}
        </p>
      );
    case "json": {
      const { text, clipped } = clip(preview.text, maxLines);
      return (
        <pre className="max-h-40 overflow-auto rounded-sm bg-sunken px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-muted">
          {text}
          {clipped && "\n…"}
        </pre>
      );
    }
  }
}

function ApprovalItem({ approval, now }: { approval: PendingApproval; now: number }) {
  const job = useQf((s) => s.jobs[approval.jobId]);
  const agents = useAgentMap();
  const harnesses = useHarnessMap();
  const state = useDecide(approval.id);
  const choices = availableChoices(approval);
  const agent = job ? agents.get(job.job.agentId) : undefined;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const key = event.key.toLowerCase();
    const choice =
      key === "a"
        ? event.shiftKey && choices.includes("allow_always")
          ? "allow_always"
          : "allow"
        : key === "d"
          ? "deny"
          : null;
    if (!choice) return;
    event.preventDefault();
    void state.decide(choice);
  };

  return (
    <li
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so A and D can answer it from the keyboard
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${approval.title.replaceAll("`", "")}, from ${agent?.name ?? "an agent"}`}
      className="group relative border-b border-line bg-surface py-3 pr-3 pl-4 outline-none focus-visible:bg-amber-soft/60"
    >
      <span className="absolute inset-y-0 left-0 w-[3px] bg-amber" aria-hidden />
      <div className="flex items-center gap-1.5 text-xs text-amber-text">
        <KindIcon kind={approval.kind} />
        <span className="font-semibold">{KIND_LABEL[approval.kind]}</span>
        <span
          className="ml-auto text-ink-faint tabular"
          title={new Date(approval.createdAt).toLocaleString()}
        >
          waiting {formatDuration(now - approval.createdAt)}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold break-words text-ink">
        {inlineCode(approval.title)}
      </p>
      <div className="mt-2">
        <InputPreview input={approval.input} jobId={approval.jobId} compact />
      </div>
      {job && (
        <button
          type="button"
          onClick={() => openJob(job.job.id)}
          className="mt-2 block max-w-full truncate text-left text-xs text-ink-muted hover:text-ink hover:underline"
        >
          {agent?.name ?? job.job.agentId} on {harnessLabel(harnesses, job.job.harness)}:{" "}
          {job.job.title}
        </button>
      )}
      <DecideButtons approval={approval} state={state} className="mt-2.5" />
    </li>
  );
}

const DECISION_TEXT: Record<Decision["outcome"], string> = {
  allowed: "Allowed",
  denied: "Denied",
  cancelled: "Withdrawn",
};

const BY_TEXT: Record<Decision["by"], string> = {
  user: "by you",
  policy: "by policy",
  system: "by QuantaFlow",
};

function DecisionRow({ decision, now }: { decision: Decision; now: number }) {
  const Icon = decision.outcome === "allowed" ? Check : decision.outcome === "denied" ? X : Minus;
  return (
    <li>
      <button
        type="button"
        onClick={() => openJob(decision.jobId)}
        title={decision.reason}
        className="flex w-full items-start gap-2 px-4 py-1.5 text-left text-xs hover:bg-raised"
      >
        <Icon
          className={cx(
            "mt-0.5 size-3.5 shrink-0",
            decision.outcome === "allowed"
              ? "text-ok"
              : decision.outcome === "denied"
                ? "text-stop"
                : "text-ink-faint",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink">{inlineCode(decision.title)}</span>
          <span className="text-ink-faint">
            {DECISION_TEXT[decision.outcome]} {BY_TEXT[decision.by]}, {formatAgo(decision.ts, now)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Everything waiting on a person, oldest first, plus what was decided recently. */
export function ApprovalQueue() {
  const approvals = useQf((s) => s.approvals);
  const decisions = useQf((s) => s.decisions);
  const now = useNow(5000);
  const queue = useMemo(() => approvalQueue(approvals), [approvals]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <h2 className="text-sm font-semibold">Waiting on you</h2>
        {queue.length > 0 && (
          <span className="text-xs font-semibold text-amber-text tabular">{queue.length}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-ink-muted">
            <p className="text-ink">Nothing right now.</p>
            <p className="mt-1">
              When an agent wants to edit a file, run a command or fetch a page and its policy says
              ask, the request lands here.
            </p>
          </div>
        ) : (
          <>
            <ul className="border-t border-line">
              {queue.map((approval) => (
                <ApprovalItem key={approval.id} approval={approval} now={now} />
              ))}
            </ul>
            <p className="px-4 py-2 text-xs text-ink-faint pointer-coarse:hidden">
              Focus a request and press A to allow, Shift+A to always allow, or D to deny.
            </p>
          </>
        )}
        {decisions.length > 0 && (
          <section
            className="mt-2 border-t border-line pt-2 pb-3"
            aria-labelledby="decided-heading"
          >
            <h3 id="decided-heading" className="px-4 pb-1 text-xs font-medium text-ink-muted">
              Decided recently
            </h3>
            <ul>
              {decisions.slice(0, 12).map((decision) => (
                <DecisionRow key={decision.approvalId} decision={decision} now={now} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

export function ApprovalsRail() {
  return (
    <aside
      aria-label="Approvals"
      className="w-[300px] shrink-0 border-r border-line bg-canvas xl:w-[330px]"
    >
      <ApprovalQueue />
    </aside>
  );
}

/** The queue as a sheet, for screens too narrow for the rail. */
export function ApprovalsSheet() {
  const open = useChrome((s) => s.queueOpen);
  const setOpen = useChrome((s) => s.setQueueOpen);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Approvals"
      onClose={() => setOpen(false)}
      className="m-0 mr-auto h-dvh max-h-none w-[min(360px,92vw)] border-r border-line bg-canvas p-0 text-ink"
    >
      <div className="flex h-full flex-col">
        <div className="flex justify-end px-2 pt-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-ink-muted hover:bg-raised hover:text-ink"
            aria-label="Close the queue"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1">{open && <ApprovalQueue />}</div>
      </div>
    </dialog>
  );
}
