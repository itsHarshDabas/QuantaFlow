/** A parsed unified diff, as `git diff` prints it. */
export interface DiffFile {
  /** Path after the change, or before it for deletions. */
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "del" | "context" | "note";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const startFile = (path: string, oldPath: string | null): DiffFile => {
    const next: DiffFile = {
      path,
      oldPath,
      status: "modified",
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    files.push(next);
    hunk = null;
    return next;
  };

  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = startFile(match?.[2] ?? line.slice(11), match?.[1] ?? null);
      continue;
    }
    if (!file || !hunk) {
      if (line.startsWith("--- ")) {
        const from = line.slice(4).trim();
        if (!file) file = startFile(stripPrefix(from), stripPrefix(from));
        if (from === "/dev/null") file.status = "added";
        else file.oldPath = stripPrefix(from);
        continue;
      }
      if (line.startsWith("+++ ") && file) {
        const to = line.slice(4).trim();
        if (to === "/dev/null") {
          file.status = "deleted";
          file.path = file.oldPath ?? file.path;
        } else {
          file.path = stripPrefix(to);
        }
        continue;
      }
      if (file && line.startsWith("new file mode")) file.status = "added";
      if (file && line.startsWith("deleted file mode")) file.status = "deleted";
      if (file && line.startsWith("rename to ")) {
        file.status = "renamed";
        file.path = line.slice(10);
      }
      if (file && line.startsWith("Binary files")) file.status = "binary";
    }
    if (!file) continue;

    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
      file.deletions += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else if (line.startsWith(" ") || line === "") {
      // A bare empty line is a blank context line whose leading space was trimmed.
      hunk.lines.push({
        type: "context",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    } else {
      // Anything else ends the hunk, such as the next file's header lines.
      hunk = null;
    }
  }

  return files;
}

/**
 * Line diff of two texts by longest common subsequence, for edits an agent reports inline.
 * Very large inputs fall back to "all removed, all added" to keep the browser responsive.
 */
export function diffLines(oldText: string | null, newText: string, maxCells = 250_000): DiffLine[] {
  const a = oldText ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  const del = (text: string) => out.push({ type: "del", text, oldLine: oldLine++, newLine: null });
  const add = (text: string) => out.push({ type: "add", text, oldLine: null, newLine: newLine++ });

  if (n * m > maxCells) {
    for (const line of a) del(line);
    for (const line of b) add(line);
    return out;
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ type: "context", text: a[i] ?? "", oldLine: oldLine++, newLine: newLine++ });
      i++;
      j++;
    } else if (
      j >= m ||
      (i < n && (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      del(a[i] ?? "");
      i++;
    } else {
      add(b[j] ?? "");
      j++;
    }
  }
  return out;
}

export type FoldedLine = DiffLine | { type: "fold"; count: number; key: string };

/** Hides long runs of unchanged lines, keeping `context` lines around each change. */
export function foldContext(lines: readonly DiffLine[], context = 2): FoldedLine[] {
  const out: FoldedLine[] = [];
  let run: DiffLine[] = [];
  let seenChange = false;
  const flush = (atEnd: boolean) => {
    const head = seenChange ? context : 0;
    const tail = atEnd ? 0 : context;
    if (run.length <= head + tail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, head));
      const hidden = run.length - head - tail;
      out.push({ type: "fold", count: hidden, key: `fold:${run[head]?.oldLine ?? 0}` });
      out.push(...run.slice(run.length - tail));
    }
    run = [];
  };
  for (const line of lines) {
    if (line.type === "context") {
      run.push(line);
      continue;
    }
    if (run.length > 0) flush(false);
    out.push(line);
    seenChange = true;
  }
  if (run.length > 0) flush(true);
  return out;
}
