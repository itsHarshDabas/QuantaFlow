export const VIEWS = ["table", "flow", "orbit", "agents"] as const;
export type ViewId = (typeof VIEWS)[number];

export interface Route {
  view: ViewId;
  /** The job open in the drawer. */
  job: string | null;
}

export function parseRoute(pathname: string, search: string): Route {
  const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  const view = (VIEWS as readonly string[]).includes(segment) ? (segment as ViewId) : "table";
  const job = new URLSearchParams(search).get("job");
  return { view, job: job || null };
}

/** Builds the URL for a route, keeping `?demo` so the demo survives navigation. */
export function routeUrl(route: Route, currentSearch: string): string {
  const params = new URLSearchParams();
  if (new URLSearchParams(currentSearch).has("demo")) params.set("demo", "");
  if (route.job) params.set("job", route.job);
  const query = params.toString().replace(/^demo=(&|$)/, "demo$1");
  return `/${route.view}${query ? `?${query}` : ""}`;
}
