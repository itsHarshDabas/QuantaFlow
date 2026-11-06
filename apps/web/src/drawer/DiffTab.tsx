import type { DiffResult, JobView } from "@quantaflow/core";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, cx, Empty } from "../components/ui";
import { api } from "../lib/backend";
import { type DiffFile, parseUnifiedDiff } from "../lib/diff";
import { errorMessage } from "../lib/errors";

const MAX_LINES = 4000;

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Changed",
  renamed: "Renamed",
  binary: "Binary",
};

function FileBlock({ file }: { file: DiffFile }) {
  return (
    <section
      className="overflow-hidden rounded-md border border-line bg-surface"
      aria-label={file.path}
    >
      <header className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
          {file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="text-ink-faint">{STATUS_LABEL[file.status]}</span>
        <span className="text-ok tabular">+{file.additions}</span>
        <span className="text-stop tabular">−{file.deletions}</span>
      </header>
      {file.status === "binary" ? (
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
      )}
    </section>
  );
}

function HunkRows({
  header,
  lines,
}: {
  header: string;
  lines: DiffFile["hunks"][number]["lines"];
}) {
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
            {line.type === "note" ? (
              <span className="text-ink-faint italic">{line.text}</span>
            ) : (
              line.text
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

export function DiffTab({ view }: { view: JobView }) {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const jobId = view.job.id;

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
  const trigger = `${view.toolCalls}:${view.job.status}`;
  useEffect(() => {
    void trigger;
    const timer = setTimeout(() => void load(), 400);
    return () => clearTimeout(timer);
  }, [load, trigger]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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
        {shown.map((file) => (
          <FileBlock key={`${file.oldPath}:${file.path}`} file={file} />
        ))}
        {shown.length < files.length && (
          <Button onClick={() => setShowAll(true)}>Show all {files.length} files</Button>
        )}
      </div>
    </div>
  );
}
