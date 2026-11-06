import type { JobView } from "@quantaflow/core";
import { needsYou } from "../../lib/states";

/** Rings from the center outward: distance is how soon a job needs you. */
export const RINGS = [
  { id: "you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Waiting" },
  { id: "finished", label: "Finished" },
] as const;
export type RingIndex = 0 | 1 | 2 | 3;

export function ringOf(view: JobView): RingIndex {
  if (needsYou(view)) return 0;
  switch (view.job.status) {
    case "working":
    case "starting":
      return 1;
    case "queued":
    case "idle":
      return 2;
    default:
      return 3;
  }
}

export interface OrbitNode {
  view: JobView;
  ring: RingIndex;
  angle: number;
  x: number;
  y: number;
}

export interface OrbitSector {
  agentId: string;
  start: number;
  end: number;
  mid: number;
  count: number;
}

export interface OrbitLayout {
  nodes: OrbitNode[];
  sectors: OrbitSector[];
  ringCounts: [number, number, number, number];
  hiddenFinished: number;
}

export interface OrbitOptions {
  radii: readonly [number, number, number, number];
  /** Older finished jobs beyond this are counted, not drawn. */
  maxFinished: number;
  /** Radians left empty between agent sectors. */
  gap: number;
}

const TOP = -Math.PI / 2;

/**
 * Places jobs on rings by urgency and in sectors by agent, so one agent's work stays together
 * and moves inward as it starts needing you. Angles start at twelve o'clock and run clockwise.
 */
export function layoutOrbit(
  views: readonly JobView[],
  agentOrder: readonly string[],
  options: OrbitOptions,
): OrbitLayout {
  const others = views;
  const finished = others
    .filter((v) => ringOf(v) === 3)
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
  const keptFinished = new Set(finished.slice(0, options.maxFinished));
  const shown = others.filter((v) => ringOf(v) !== 3 || keptFinished.has(v));

  const ringCounts: [number, number, number, number] = [0, 0, 0, 0];
  for (const v of others) ringCounts[ringOf(v)] += 1;

  const byAgent = new Map<string, JobView[]>();
  for (const view of shown) {
    const list = byAgent.get(view.job.agentId) ?? [];
    list.push(view);
    byAgent.set(view.job.agentId, list);
  }
  const rank = (id: string) => {
    const index = agentOrder.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const agentIds = [...byAgent.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const total = shown.length;
  const gap = agentIds.length > 1 ? options.gap : 0;
  const usable = Math.PI * 2 - gap * agentIds.length;
  const sectors: OrbitSector[] = [];
  const nodes: OrbitNode[] = [];
  let cursor = TOP + gap / 2;

  for (const agentId of agentIds) {
    const jobs = byAgent.get(agentId) ?? [];
    const span = total > 0 ? (usable * jobs.length) / total : usable;
    const start = cursor;
    const end = cursor + span;
    sectors.push({ agentId, start, end, mid: (start + end) / 2, count: jobs.length });

    for (const ring of [0, 1, 2, 3] as const) {
      const onRing = jobs
        .filter((v) => ringOf(v) === ring)
        .sort((a, b) => a.job.createdAt - b.job.createdAt || a.job.id.localeCompare(b.job.id));
      onRing.forEach((view, i) => {
        const angle = start + ((i + 0.5) * span) / onRing.length;
        const radius = options.radii[ring];
        nodes.push({
          view,
          ring,
          angle,
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
        });
      });
    }
    cursor = end + gap;
  }

  return {
    nodes,
    sectors,
    ringCounts,
    hiddenFinished: Math.max(0, finished.length - keptFinished.size),
  };
}
