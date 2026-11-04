import type { PendingApproval } from "@quantaflow/core";
import { useState } from "react";
import { Button, cx } from "../components/ui";
import { api } from "../lib/backend";
import { errorMessage } from "../lib/errors";

export type Choice = "allow" | "allow_always" | "deny";

/** What a person can do with a request, based on the options the harness offered. */
export function availableChoices(approval: PendingApproval): Choice[] {
  const kinds = new Set(approval.options.map((o) => o.kind));
  const choices: Choice[] = [];
  if (kinds.has("allow_once") || kinds.size === 0) choices.push("allow");
  if (kinds.has("allow_always")) choices.push("allow_always");
  choices.push("deny");
  return choices;
}

const LABEL: Record<Choice, string> = {
  allow: "Allow",
  allow_always: "Always allow",
  deny: "Deny",
};

/** Sends a decision and tracks its state. Shared by the queue and the chat. */
export function useDecide(approvalId: string) {
  const [busy, setBusy] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(choice: Choice) {
    if (busy) return;
    setBusy(choice);
    setError(null);
    try {
      await api().decide(approvalId, choice);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }
  return { busy, error, decide };
}

export type DecideState = ReturnType<typeof useDecide>;

/** The decision buttons. Pass `state` to share it with keyboard shortcuts on the parent. */
export function DecideButtons({
  approval,
  state,
  size = "sm",
  className,
}: {
  approval: PendingApproval;
  state?: DecideState;
  size?: "sm" | "md";
  className?: string;
}) {
  const own = useDecide(approval.id);
  const { busy, error, decide } = state ?? own;
  const choices = availableChoices(approval);
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map((choice) => (
          <Button
            key={choice}
            size={size}
            variant={choice === "allow" ? "amber" : choice === "deny" ? "danger" : "quiet"}
            disabled={busy !== null}
            onClick={(event) => {
              event.stopPropagation();
              void decide(choice);
            }}
          >
            {busy === choice ? `${LABEL[choice]}…` : LABEL[choice]}
          </Button>
        ))}
      </div>
      {error && (
        <p className="text-xs text-stop" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
