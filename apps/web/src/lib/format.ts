const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "12s", "4m", "2h 5m", "3d". Short enough for a table cell. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE) return `${Math.floor(safe / 1000)}s`;
  if (safe < HOUR) {
    const minutes = Math.floor(safe / MINUTE);
    const seconds = Math.floor((safe % MINUTE) / 1000);
    return minutes < 10 && seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  if (safe < DAY) {
    const hours = Math.floor(safe / HOUR);
    const minutes = Math.floor((safe % HOUR) / MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.floor(safe / DAY)}d`;
}

/** "just now", "4m ago", "2h ago", then a date. */
export function formatAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 10_000) return "just now";
  if (diff < DAY) return `${formatDuration(diff).split(" ")[0]} ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 1234 -> "1.2k", 1_200_000 -> "1.2M". */
export function formatCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 1 ? 3 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Shortens a path for display: keeps the last segments and swaps a home dir for `~`. */
export function shortPath(path: string, keep = 2): string {
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)?.[0];
  const withHome = home ? `~${path.slice(home.length)}` : path;
  const parts = withHome.split(/[/\\]/).filter(Boolean);
  if (parts.length <= keep + 1) return withHome;
  return `…/${parts.slice(-keep).join("/")}`;
}

/** A path inside `root` without the root, so a worktree file reads like a repo file. */
export function relativePath(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const base = root.replace(/[/\\]+$/, "");
  if (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))
    return path.slice(base.length + 1);
  return path;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
