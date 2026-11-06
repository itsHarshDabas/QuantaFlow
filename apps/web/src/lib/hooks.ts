import type { AgentProfile, HarnessInfo } from "@quantaflow/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQf } from "../store/store";

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: number | undefined;
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}

const tickers = new Map<number, Ticker>();

/**
 * One shared clock per interval. `read` must return the same value until the clock ticks,
 * or useSyncExternalStore re-renders forever, and `subscribe` must keep its identity so
 * React does not resubscribe on every render.
 */
function ticker(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs);
  if (existing) return existing;
  const t: Ticker = {
    now: Date.now(),
    listeners: new Set(),
    timer: undefined,
    read: () => t.now,
    subscribe: (listener) => {
      t.listeners.add(listener);
      if (t.timer === undefined) {
        t.now = Date.now();
        t.timer = window.setInterval(() => {
          t.now = Date.now();
          for (const l of t.listeners) l();
        }, intervalMs);
      }
      return () => {
        t.listeners.delete(listener);
        if (t.listeners.size === 0 && t.timer !== undefined) {
          window.clearInterval(t.timer);
          t.timer = undefined;
        }
      };
    },
  };
  tickers.set(intervalMs, t);
  return t;
}

/** The current time, refreshed every `intervalMs`. One timer per interval, shared by all users. */
export function useNow(intervalMs = 1000): number {
  const t = ticker(intervalMs);
  return useSyncExternalStore(t.subscribe, t.read);
}

export function useAgentMap(): Map<string, AgentProfile> {
  const agents = useQf((s) => s.agents);
  return useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
}

export function useHarnessMap(): Map<string, HarnessInfo> {
  const harnesses = useQf((s) => s.harnesses);
  return useMemo(() => new Map(harnesses.map((h) => [h.id, h])), [harnesses]);
}

export function harnessLabel(map: Map<string, HarnessInfo>, id: string): string {
  return map.get(id)?.label ?? id;
}

/** Whether the viewport is at least `px` wide. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
