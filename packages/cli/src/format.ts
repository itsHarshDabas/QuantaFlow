import { type Style, visibleLength } from "./style.js";

/** Lays out rows as aligned columns. The last column is never padded. */
export function table(header: string[], rows: string[][], style: Style): string {
  const all = [header.map((h) => style.dim(h)), ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => visibleLength(row[col] ?? ""))),
  );
  return all
    .map((row) =>
      row
        .map((cell, col) =>
          col === row.length - 1
            ? cell
            : cell + " ".repeat((widths[col] ?? 0) - visibleLength(cell)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function ago(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** One line, whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}
