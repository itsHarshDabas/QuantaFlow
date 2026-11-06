import { Monitor, Moon, Plus, Sun } from "lucide-react";
import { Button, cx, Lamp } from "../components/ui";
import { shortPath } from "../lib/format";
import { navigate, type ViewId } from "../lib/router";
import { needsYou } from "../lib/states";
import { type ThemeChoice, useTheme } from "../lib/theme";
import { useQf } from "../store/store";
import { useChrome } from "../store/ui";

const TABS: { id: ViewId; label: string; key: string }[] = [
  { id: "table", label: "Table", key: "1" },
  { id: "flow", label: "Flow", key: "2" },
  { id: "orbit", label: "Orbit", key: "3" },
  { id: "agents", label: "Agents", key: "4" },
];

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity=".4"
      />
      <circle cx="16" cy="16" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="13" width="6" height="6" rx="1.5" fill="var(--amber)" />
    </svg>
  );
}

function Connection() {
  const connection = useQf((s) => s.connection);
  const demo = useQf((s) => s.demo);
  if (demo) {
    return (
      <span
        className="hidden items-center gap-1.5 text-xs text-ink-muted sm:inline-flex"
        title="Running against an in-browser simulation"
      >
        <Lamp tone="run" size={7} />
        Demo
      </span>
    );
  }
  const label =
    connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline";
  const tone = connection === "live" ? "ok" : connection === "connecting" ? "wait" : "stop";
  return (
    <span
      className="hidden items-center gap-1.5 text-xs text-ink-muted sm:inline-flex"
      role="status"
    >
      <Lamp tone={tone} size={7} />
      {label}
    </span>
  );
}

function Summary() {
  const jobs = useQf((s) => s.jobs);
  let running = 0;
  for (const view of Object.values(jobs)) {
    const status = view.job.status;
    if (!needsYou(view) && (status === "working" || status === "starting")) running += 1;
  }
  if (running === 0) return null;
  return (
    <span className="hidden items-center gap-1.5 text-xs text-ink-muted tabular md:inline-flex">
      <Lamp tone="run" size={7} />
      {running} running
    </span>
  );
}

function QueueBadge() {
  const count = useQf((s) => Object.keys(s.approvals).length);
  const setQueueOpen = useChrome((s) => s.setQueueOpen);
  return (
    <button
      type="button"
      onClick={() => setQueueOpen(true)}
      className={cx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold tabular lg:hidden",
        count > 0 ? "bg-amber text-amber-ink" : "text-ink-muted hover:bg-raised",
      )}
      aria-label={
        count > 0 ? `${count} waiting on you. Open the queue.` : "Open the approvals queue"
      }
    >
      {count > 0 ? (
        <>
          {count}
          <span className="hidden sm:inline">waiting</span>
        </>
      ) : (
        "Queue"
      )}
    </button>
  );
}

export function TopBar({ view }: { view: ViewId }) {
  const root = useQf((s) => s.root);
  const connected = useQf((s) => s.everConnected);
  const openNewJob = useChrome((s) => s.openNewJob);
  const [theme, setTheme] = useTheme();
  const ThemeIcon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
      <a
        href="/table"
        onClick={(event) => {
          event.preventDefault();
          navigate({ view: "table" });
        }}
        className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight"
      >
        <Mark className="size-6 text-run" />
        <span className="hidden sm:inline">QuantaFlow</span>
      </a>
      {root && (
        <span
          className="hidden max-w-[220px] truncate font-mono text-xs text-ink-faint xl:inline"
          title={root}
        >
          {shortPath(root)}
        </span>
      )}

      <nav aria-label="Views" className="flex min-w-0 items-center sm:ml-3 sm:gap-0.5">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            href={`/${tab.id}`}
            aria-current={view === tab.id ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate({ view: tab.id });
            }}
            title={`${tab.label} (${tab.key})`}
            className={cx(
              "relative rounded-md px-2 py-1.5 text-sm transition-colors sm:px-2.5",
              view === tab.id
                ? "font-semibold text-ink after:absolute after:inset-x-2 after:-bottom-[9px] sm:after:inset-x-2.5 after:h-0.5 after:bg-ink"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        <Summary />
        <Connection />
        {connected && <QueueBadge />}
        <button
          type="button"
          onClick={() => setTheme(NEXT_THEME[theme])}
          className="rounded-md p-1.5 text-ink-muted hover:bg-raised hover:text-ink"
          aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}.`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-4" aria-hidden />
        </button>
        <Button
          variant="primary"
          onClick={() => openNewJob()}
          title="New job (N)"
          disabled={!connected}
        >
          <Plus className="size-4" aria-hidden />
          <span className="hidden sm:inline">New job</span>
        </Button>
      </div>
    </header>
  );
}
