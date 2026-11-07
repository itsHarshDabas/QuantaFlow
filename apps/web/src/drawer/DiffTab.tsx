import type { DiffResult, JobView } from "@quantaflow/core";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, cx, Empty } from "../components/ui";
import { api } from "../lib/backend";
import {
  type DiffFile,
  type DiffLine,
  pairInlineChanges,
  parseUnifiedDiff,
  type Segment,
} from "../lib/diff";
import { errorMessage } from "../lib/errors";
import { workspaceState } from "../lib/review";
import { ReviewBar } from "./ReviewBar";

const MAX_LINES = 4000;

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Changed",
  renamed: "Renamed",
  binary: "Binary",
};

function signature(file: DiffFile): string {
  return `${file.additions}:${file.deletions}:${file.hunks.map((h) => h.header).join("|")}`;
}

/** Files marked as viewed, per job. Kept for the browser session; a file that changes again is unmarked. */
function useViewed(jobId: string) {
  const key = `qf.viewed.${jobId}`;
  const [viewed, setViewed] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const toggle = useCallback(
    (file: DiffFile) => {
      setViewed((current) => {
        const next = { ...current };
        if (next[file.path] === signature(file)) delete next[file.path];
        else next[file.path] = signature(file);
        try {
          sessionStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage can be unavailable; marks then last until the drawer closes.
        }
        return next;
      });
    },
    [key],
  );
  const isViewed = useCallback((file: DiffFile) => viewed[file.path] === signature(file), [viewed]);
  return { isViewed, toggle };
}

function fileLabel(file: DiffFile): string {
  return file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path;
}

function FileBlock({
  file,
  anchor,
  viewed,
  open,
  onToggleOpen,
  onToggleViewed,
}: {
  file: DiffFile;
  anchor: string;
  viewed: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleViewed: () => void;
}) {
  return (
    <section
      id={anchor}
      className="scroll-mt-2 overflow-hidden rounded-md border border-line bg-surface"
      aria-label={file.path}
    >
      <header className="flex items-center gap-2 border-b border-line bg-raised px-2 py-1 text-xs">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
          className="rounded-sm p-0.5 text-ink-faint hover:text-ink"
        >
          <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <span
          className={cx(
            "min-w-0 flex-1 truncate font-mono",
            viewed ? "text-ink-muted" : "text-ink",
          )}
          title={fileLabel(file)}
        >
          {fileLabel(file)}
        </span>
        <span className="hidden text-ink-faint sm:inline">{STATUS_LABEL[file.status]}</span>
        <span className="text-ok tabular">+{file.additions}</span>
        <span className="text-stop tabular">−{file.deletions}</span>
        <label className="ml-1 flex cursor-pointer items-center gap-1 text-ink-muted">
          <input
            type="checkbox"
            checked={viewed}
            onChange={onToggleViewed}
            className="accent-ink"
          />
          Viewed
        </label>
      </header>
      {open &&
        (file.status === "binary" ? (
          <p className="px-3 py-2 text-xs text-ink-muted">Binary file, not shown.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
              <tbody>
                {file.hunks.map((hunk) => (
                  <HunkRows key={hunk.header} lines={hunk.lines} header={hunk.header} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

function LineText({ line, segments }: { line: DiffLine; segments: Segment[] | undefined }) {
  if (line.type === "note") return <span className="text-ink-faint italic">{line.text}</span>;
  if (!segments) return <>{line.text}</>;
  const strong = line.type === "add" ? "bg-diff-add-strong" : "bg-diff-del-strong";
  return (
    <>
      {segments.map((segment, index) =>
        segment.changed ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one line never reorder
          <mark key={index} className={cx("rounded-[2px] text-inherit", strong)}>
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one line never reorder
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function HunkRows({
  header,
  lines,
}: {
  header: string;
  lines: DiffFile["hunks"][number]["lines"];
}) {
  const inline = useMemo(() => pairInlineChanges(lines), [lines]);
  return (
    <>
      <tr>
        <td colSpan={3} className="bg-sunken px-3 py-0.5 text-ink-faint">
          {header}
        </td>
      </tr>
      {lines.map((line, index) => (
        <tr
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static once parsed
          key={`${index}-${line.oldLine}-${line.newLine}`}
          className={cx(line.type === "add" && "bg-diff-add", line.type === "del" && "bg-diff-del")}
        >
          <td className="w-10 select-none px-2 text-right text-ink-faint tabular">
            {line.oldLine ?? ""}
          </td>
          <td className="w-10 select-none px-2 text-right text-ink-faint tabular">
            {line.newLine ?? ""}
          </td>
          <td className="px-2 whitespace-pre">
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
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            <LineText line={line} segments={inline.get(index)} />
          </td>
        </tr>
      ))}
    </>
  );
}

function FileNav({
  files,
  isViewed,
  onJump,
}: {
  files: DiffFile[];
  isViewed: (file: DiffFile) => boolean;
  onJump: (index: number) => void;
}) {
  return (
    <nav aria-label="Changed files" className="rounded-md border border-line bg-surface text-xs">
      <ul className="max-h-40 divide-y divide-line overflow-y-auto">
        {files.map((file, index) => (
          <li key={`${file.oldPath}:${file.path}`}>
            <button
              type="button"
              onClick={() => onJump(index)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-raised"
            >
              <span
                className={cx(
                  "size-1.5 shrink-0 rounded-full",
                  isViewed(file) ? "bg-ok" : "bg-line-strong",
                )}
                aria-hidden
              />
              <span
                className={cx(
                  "min-w-0 flex-1 truncate font-mono",
                  isViewed(file) ? "text-ink-muted" : "text-ink",
                )}
              >
                {fileLabel(file)}
              </span>
              <span className="text-ok tabular">+{file.additions}</span>
              <span className="text-stop tabular">−{file.deletions}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DiffTab({ view }: { view: JobView }) {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const jobId = view.job.id;
  const discarded = workspaceState(view) === "discarded";
  const { isViewed, toggle } = useViewed(jobId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await api().diff(jobId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // Refresh when the job does something that could change files, at most once a second.
  const trigger = `${view.toolCalls}:${view.job.status}:${workspaceState(view)}`;
  useEffect(() => {
    void trigger;
    if (discarded) return;
    const timer = setTimeout(() => void load(), 400);
    return () => clearTimeout(timer);
  }, [load, trigger, discarded]);

  const files = useMemo(() => (result?.available ? parseUnifiedDiff(result.diff) : []), [result]);
  const totalLines = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const shown = useMemo(() => {
    if (showAll || totalLines <= MAX_LINES) return files;
    let budget = MAX_LINES;
    const out: DiffFile[] = [];
    for (const file of files) {
      if (budget <= 0) break;
      out.push(file);
      budget -= file.hunks.reduce((m, h) => m + h.lines.length, 0);
    }
    return out;
  }, [files, showAll, totalLines]);

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const viewedCount = files.filter(isViewed).length;
  const anchor = (index: number) => `diff-${jobId}-${index}`;
  // Viewed files fold away, like a reviewed file in a pull request, unless opened again.
  const isOpen = (file: DiffFile) => !(collapsed[file.path] ?? isViewed(file));
  const setOpen = (file: DiffFile, open: boolean) =>
    setCollapsed((current) => ({ ...current, [file.path]: !open }));

  const jump = (index: number) => {
    const file = files[index];
    if (!file) return;
    if (index >= shown.length) setShowAll(true);
    setOpen(file, true);
    requestAnimationFrame(() =>
      document.getElementById(anchor(index))?.scrollIntoView({ block: "start" }),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReviewBar view={view} />
      {!discarded && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-muted">
          {result?.available && files.length > 0 ? (
            <span>
              {files.length} {files.length === 1 ? "file" : "files"} changed,{" "}
              <span className="text-ok tabular">+{additions}</span>{" "}
              <span className="text-stop tabular">−{deletions}</span>
              {view.job.baseRef && (
                <>
                  {" "}
                  since <span className="font-mono">{view.job.baseRef.slice(0, 9)}</span>
                </>
              )}
              <span className="text-ink-faint">
                {" "}
                · {viewedCount} of {files.length} viewed
              </span>
            </span>
          ) : (
            <span>
              {view.job.branch ? <span className="font-mono">{view.job.branch}</span> : "Changes"}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} aria-hidden />
            Refresh
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {discarded ? (
          <Empty title="Nothing to review" className="p-0">
            This job's workspace was discarded, so its changes are gone.
          </Empty>
        ) : (
          <>
            {error && (
              <p className="text-sm text-stop" role="alert">
                {error}
              </p>
            )}
            {!error && result && !result.available && (
              <Empty title="No diff for this job" className="p-0">
                {result.reason ?? "This job has no git worktree."}
              </Empty>
            )}
            {!error && result?.available && files.length === 0 && (
              <Empty title="No changes yet" className="p-0">
                Nothing in the worktree differs from where the job started.
              </Empty>
            )}
            {files.length > 1 && <FileNav files={files} isViewed={isViewed} onJump={jump} />}
            {shown.map((file, index) => (
              <FileBlock
                key={`${file.oldPath}:${file.path}`}
                file={file}
                anchor={anchor(index)}
                viewed={isViewed(file)}
                open={isOpen(file)}
                onToggleOpen={() => setOpen(file, !isOpen(file))}
                onToggleViewed={() => {
                  setCollapsed((current) => {
                    const next = { ...current };
                    delete next[file.path];
                    return next;
                  });
                  toggle(file);
                }}
              />
            ))}
            {shown.length < files.length && (
              <Button onClick={() => setShowAll(true)}>Show all {files.length} files</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
