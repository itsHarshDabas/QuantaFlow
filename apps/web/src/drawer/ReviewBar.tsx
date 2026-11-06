import type { JobView } from "@quantaflow/core";
import { Check, GitMerge, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Button, cx } from "../components/ui";
import { errorMessage } from "../lib/errors";
import {
  canDiscard,
  canMerge,
  type MergeRefusal,
  type MergeStrategy,
  refusalOf,
  review,
  stopped,
  workspaceState,
} from "../lib/review";
import { useQf } from "../store/store";

function Refusal({ refusal }: { refusal: MergeRefusal }) {
  return (
    <div className="rounded-md border border-stop/40 bg-stop-soft px-3 py-2 text-xs" role="alert">
      <p className="font-medium text-ink">{refusal.reason}</p>
      {refusal.conflicts && refusal.conflicts.length > 0 && (
        <>
          <p className="mt-1.5 text-ink-muted">
            The merge was aborted and the project is unchanged. These files conflict:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-ink">
            {refusal.conflicts.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DiscardButton({ view, label }: { view: JobView; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = view.job.workspace === "folder" ? "folder" : "worktree and branch";
  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        <Trash2 className="size-3.5" aria-hidden />
        {label}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-ink-muted">Delete the job's {what}?</span>
      <Button
        size="sm"
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await review().discard(view.job.id);
            setConfirming(false);
            setError(null);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Deleting…" : "Delete"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
        Keep
      </Button>
      {error && (
        <span className="w-full text-xs text-stop" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function MergeControls({ view }: { view: JobView }) {
  const ids = useId();
  const [strategy, setStrategy] = useState<MergeStrategy>("squash");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<MergeRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const merge = async () => {
    setBusy(true);
    setRefusal(null);
    setError(null);
    try {
      const text = message.trim();
      await review().merge(view.job.id, { strategy, ...(text ? { message: text } : {}) });
    } catch (err) {
      const refused = refusalOf(err);
      if (refused) setRefusal(refused);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex rounded-md border border-line p-0.5 text-xs">
          <legend className="sr-only">How to merge</legend>
          {(
            [
              ["squash", "Squash", "One commit with all of the job's changes"],
              ["merge", "Merge commit", "Keep the job's commits and add a merge commit"],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              title={hint}
              className={cx(
                "cursor-pointer rounded-sm px-2 py-1",
                strategy === value ? "bg-raised font-semibold text-ink" : "text-ink-muted",
              )}
            >
              <input
                type="radio"
                name={`${ids}-strategy`}
                value={value}
                checked={strategy === value}
                onChange={() => setStrategy(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </fieldset>
        <Button size="sm" variant="primary" onClick={() => void merge()} disabled={busy}>
          <GitMerge className="size-3.5" aria-hidden />
          {busy ? "Merging…" : "Merge into project"}
        </Button>
        <span className="ml-auto">
          <DiscardButton view={view} label="Discard" />
        </span>
      </div>
      <label htmlFor={`${ids}-message`} className="sr-only">
        Commit message
      </label>
      <input
        id={`${ids}-message`}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={`Commit message (optional, defaults to "${view.job.title}")`}
        className="h-7 w-full rounded-md border border-line bg-canvas px-2 text-xs placeholder:text-ink-faint focus:border-line-strong"
      />
      {refusal && <Refusal refusal={refusal} />}
      {error && (
        <p className="text-xs text-stop" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What to do with a finished job's changes: merge them into the project or throw them away. */
export function ReviewBar({ view }: { view: JobView }) {
  const merge = useQf((s) => s.merges[view.job.id]);
  const state = workspaceState(view);
  if (view.job.workspace === "cwd") return null;

  let body: React.ReactNode;
  if (state === "merged") {
    body = (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Check className="size-3.5 text-ok" aria-hidden />
        <span className="text-ink">
          Merged
          {merge && (
            <>
              {" "}
              into <span className="font-mono">{merge.into}</span> as{" "}
              <span className="font-mono">{merge.commit.slice(0, 7)}</span>
              {merge.strategy === "squash" && " (squashed)"}
            </>
          )}
        </span>
        <span className="ml-auto">
          {canDiscard(view) && <DiscardButton view={view} label="Remove worktree" />}
        </span>
      </div>
    );
  } else if (state === "discarded") {
    body = (
      <p className="text-xs text-ink-muted">
        Discarded. The job's {view.job.workspace === "folder" ? "folder" : "worktree and branch"} no
        longer exist.
      </p>
    );
  } else if (!stopped(view)) {
    body = (
      <p className="text-xs text-ink-muted">
        You can merge or discard these changes once the job stops.
      </p>
    );
  } else if (canMerge(view)) {
    body = <MergeControls view={view} />;
  } else if (canDiscard(view)) {
    body = (
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span>The job's folder is still on disk.</span>
        <span className="ml-auto">
          <DiscardButton view={view} label="Discard folder" />
        </span>
      </div>
    );
  } else {
    return null;
  }

  return <div className="shrink-0 border-b border-line bg-surface px-4 py-2.5">{body}</div>;
}
