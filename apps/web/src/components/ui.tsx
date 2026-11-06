import { type JobView, type SessionState, STATE_LABELS, type ToolKind } from "@quantaflow/core";
import {
  Ban,
  Brain,
  FilePen,
  FileText,
  Globe,
  Move,
  Search,
  Settings2,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { type ButtonHTMLAttributes, type ComponentType, Fragment, type ReactNode } from "react";
import { jobTone, STATE_TONE, TONE, type Tone } from "../lib/states";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "amber" | "quiet" | "ghost" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary: "bg-ink text-surface hover:bg-ink/85 border-transparent",
  amber: "bg-amber text-amber-ink hover:brightness-105 border-transparent font-semibold",
  quiet: "bg-surface text-ink border-line hover:border-line-strong hover:bg-raised",
  ghost: "bg-transparent text-ink-muted border-transparent hover:text-ink hover:bg-raised",
  danger: "bg-surface text-stop border-line hover:border-stop hover:bg-stop-soft",
};

export function Button({
  variant = "quiet",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        BUTTON[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-line bg-surface px-1 font-sans text-[11px] text-ink-muted">
      {children}
    </kbd>
  );
}

/** A small status lamp. The one that waits on you pulses. */
export function Lamp({ tone, size = 8, pulse }: { tone: Tone; size?: number; pulse?: boolean }) {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {pulse && <span className={cx("beacon absolute inset-0 rounded-[2px]", TONE[tone].fill)} />}
      <span
        className={cx("relative rounded-[2px]", TONE[tone].fill)}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

export function StateTag({ view, state }: { view?: JobView; state?: SessionState }) {
  const status = view?.job.status ?? state ?? "queued";
  const tone = view ? jobTone(view) : STATE_TONE[status];
  const waitingOnApproval = view && view.pendingApprovals > 0 && status !== "needs_input";
  const label = waitingOnApproval ? "Needs you" : STATE_LABELS[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", TONE[tone].text)}>
      <Lamp tone={tone} pulse={tone === "amber"} />
      {label}
    </span>
  );
}

const KIND_ICON: Record<
  ToolKind,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: Move,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Settings2,
  other: Wrench,
};

export const KIND_LABEL: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Command",
  think: "Think",
  fetch: "Web",
  switch_mode: "Mode",
  other: "Tool",
};

export function KindIcon({ kind, className }: { kind: ToolKind; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Ban;
  return <Icon className={cx("size-3.5 shrink-0", className)} aria-hidden />;
}

export function Empty({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-start gap-2 p-6 text-sm", className)}>
      <p className="font-semibold text-ink">{title}</p>
      {children && <div className="max-w-prose text-ink-muted">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx("rounded-sm bg-sunken px-1 py-px font-mono text-[0.92em]", className)}>
      {children}
    </code>
  );
}

/** Renders `backtick` spans as code, for hints and messages that come as plain text. */
export function inlineCode(text: string): ReactNode {
  const pieces = text.split(/(`[^`\n]+`)/);
  if (pieces.length === 1) return text;
  return pieces.map((piece, index) =>
    piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one split string never reorder
      <code key={`${index}-${piece}`} className="rounded-sm bg-sunken px-1 font-mono text-[0.9em]">
        {piece.slice(1, -1)}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one split string never reorder
      <Fragment key={`${index}-${piece.length}`}>{piece}</Fragment>
    ),
  );
}
