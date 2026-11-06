import { lazy, Suspense, useEffect } from "react";
import { ApprovalsRail, ApprovalsSheet } from "../approvals/ApprovalsRail";
import { JobDrawer } from "../drawer/JobDrawer";
import { NewJobDialog } from "../jobs/NewJobDialog";
import { useMinWidth } from "../lib/hooks";
import { navigate, useRoute, VIEWS } from "../lib/router";
import { useQf } from "../store/store";
import { useChrome } from "../store/ui";
import { AgentsView } from "../views/agents/AgentsView";
import { OrbitView } from "../views/orbit/OrbitView";
import { TableView } from "../views/table/TableView";
import { ConnectionBanner, FirstConnect } from "./ConnectionBanner";
import { TopBar } from "./TopBar";

const FlowView = lazy(() => import("../views/flow/FlowView"));

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const chrome = useChrome.getState();
      if (event.key === "n") {
        event.preventDefault();
        chrome.openNewJob();
      } else if (event.key >= "1" && event.key <= String(VIEWS.length)) {
        const view = VIEWS[Number(event.key) - 1];
        if (view) navigate({ view });
      } else if (event.key === "Escape") {
        if (chrome.queueOpen) chrome.setQueueOpen(false);
        else navigate({ job: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const route = useRoute();
  const everConnected = useQf((s) => s.everConnected);
  const wide = useMinWidth(1024);
  useShortcuts();

  useEffect(() => {
    const labels = { table: "Table", flow: "Flow", orbit: "Orbit", agents: "Agents" } as const;
    document.title = `${labels[route.view]} · QuantaFlow`;
  }, [route.view]);

  return (
    <div className="flex h-full flex-col">
      <TopBar view={route.view} />
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
        {wide && everConnected && <ApprovalsRail />}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {!everConnected ? (
            <FirstConnect />
          ) : route.view === "table" ? (
            <TableView selectedJob={route.job} />
          ) : route.view === "flow" ? (
            <Suspense fallback={null}>
              <FlowView selectedJob={route.job} />
            </Suspense>
          ) : route.view === "orbit" ? (
            <OrbitView selectedJob={route.job} />
          ) : (
            <AgentsView />
          )}
        </main>
        {route.job && everConnected && <JobDrawer jobId={route.job} />}
      </div>
      {!wide && <ApprovalsSheet />}
      <NewJobDialog />
    </div>
  );
}
