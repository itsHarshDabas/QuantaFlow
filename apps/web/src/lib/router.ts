import { useSyncExternalStore } from "react";
import { parseRoute, type Route, routeUrl } from "./route";

export type { Route, ViewId } from "./route";
export { VIEWS } from "./route";

const listeners = new Set<() => void>();
let current = parseRoute(location.pathname, location.search);

function publish(): void {
  current = parseRoute(location.pathname, location.search);
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", publish);

export function navigate(patch: Partial<Route>, options: { replace?: boolean } = {}): void {
  const next = { ...current, ...patch };
  const url = routeUrl(next, location.search);
  if (url === `${location.pathname}${location.search}`) return;
  if (options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  publish();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function openJob(jobId: string | null): void {
  navigate({ job: jobId });
}
