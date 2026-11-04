import { EventEmitter } from "node:events";
import {
  applyEvent,
  createJobView,
  type Job,
  type JobView,
  type QfEvent,
  type QfEventData,
} from "@quantaflow/core";
import type { Store } from "./store.js";

/**
 * The single write path for events: persist, update the live job views, then notify listeners
 * (the WebSocket stream and the CLI).
 */
export class EventLog extends EventEmitter<{ event: [QfEvent] }> {
  private readonly views = new Map<string, JobView>();
  private readonly lastEvent = new Map<string, QfEvent>();

  constructor(private readonly store: Store) {
    super();
    this.setMaxListeners(0);
  }

  /** Rebuilds every job view from the stored events. Called once at startup. */
  hydrate(jobs: Job[]): void {
    for (const job of jobs) {
      let view = createJobView(job);
      let previous: QfEvent | undefined;
      for (const event of this.store.eventsForJob(job.id)) {
        view = applyEvent(view, event, previous);
        previous = event;
      }
      // The job row is authoritative for status, since recovery may have changed it.
      this.views.set(job.id, { ...view, job });
      if (previous) this.lastEvent.set(job.id, previous);
    }
  }

  append(jobId: string, data: QfEventData): QfEvent {
    const event = this.store.appendEvent(jobId, data);
    const current =
      this.views.get(jobId) ?? (data.type === "job.created" ? createJobView(data.job) : undefined);
    if (current) this.views.set(jobId, applyEvent(current, event, this.lastEvent.get(jobId)));
    this.lastEvent.set(jobId, event);
    this.emit("event", event);
    return event;
  }

  view(jobId: string): JobView | undefined {
    return this.views.get(jobId);
  }

  allViews(): JobView[] {
    return [...this.views.values()].sort((a, b) => b.job.createdAt - a.job.createdAt);
  }
}
