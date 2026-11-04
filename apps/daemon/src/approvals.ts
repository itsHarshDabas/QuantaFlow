import { newId, type PendingApproval, pickPermissionOption } from "@quantaflow/core";
import type { PermissionAsk, PermissionDecision } from "@quantaflow/drivers";
import { notFound } from "./errors.js";
import type { EventLog } from "./events.js";

interface Pending {
  approval: PendingApproval;
  resolve: (decision: PermissionDecision) => void;
  cleanup: () => void;
}

/** The approvals inbox: permission requests waiting for a person, from every job. */
export class ApprovalCenter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly log: EventLog) {}

  list(): PendingApproval[] {
    return [...this.pending.values()]
      .map((p) => p.approval)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Records the request and waits for a decision. Resolves `cancelled` if `signal` aborts first. */
  request(jobId: string, ask: PermissionAsk, signal: AbortSignal): Promise<PermissionDecision> {
    const id = newId("apr");
    const approval: PendingApproval = {
      id,
      jobId,
      title: ask.title,
      kind: ask.kind,
      options: ask.options,
      ...(ask.input !== undefined ? { input: ask.input } : {}),
      createdAt: Date.now(),
    };
    this.log.append(jobId, {
      type: "permission.requested",
      approvalId: id,
      title: ask.title,
      kind: ask.kind,
      options: ask.options,
      ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}),
      ...(ask.input !== undefined ? { input: ask.input } : {}),
    });

    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = () => this.settle(id, { outcome: "cancelled" }, "system", "The turn ended");
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      this.pending.set(id, { approval, resolve, cleanup });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Applies a person's decision. */
  decide(id: string, decision: "allow" | "allow_always" | "deny"): void {
    const entry = this.pending.get(id);
    if (!entry) throw notFound(`Approval "${id}"`);
    const option = pickPermissionOption(entry.approval.options, decision);
    if (!option) {
      this.settle(id, { outcome: "cancelled" }, "user", "No matching option; treated as a cancel");
      return;
    }
    this.settle(id, { outcome: "selected", optionId: option.optionId }, "user");
  }

  cancelForJob(jobId: string, reason = "The job stopped"): void {
    for (const [id, entry] of this.pending) {
      if (entry.approval.jobId === jobId)
        this.settle(id, { outcome: "cancelled" }, "system", reason);
    }
  }

  private settle(
    id: string,
    decision: PermissionDecision,
    by: "user" | "system",
    reason?: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
    const option =
      decision.outcome === "selected"
        ? entry.approval.options.find((o) => o.optionId === decision.optionId)
        : undefined;
    this.log.append(entry.approval.jobId, {
      type: "permission.resolved",
      approvalId: id,
      outcome:
        decision.outcome === "cancelled"
          ? "cancelled"
          : option?.kind.startsWith("allow")
            ? "allowed"
            : "denied",
      ...(decision.outcome === "selected" ? { optionId: decision.optionId } : {}),
      by,
      ...(reason ? { reason } : {}),
    });
    entry.resolve(decision);
  }
}
