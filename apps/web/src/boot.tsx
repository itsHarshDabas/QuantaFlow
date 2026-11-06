import { QfClient } from "@quantaflow/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { Crash } from "./app/Crash";
import { type Backend, demoRequested, setBackend } from "./lib/backend";
import { startLive } from "./lib/live";
import { useQf } from "./store/store";

const demo = demoRequested(location.search);
const backend: Backend = demo
  ? new (await import("./demo/demo-backend")).DemoBackend()
  : new QfClient();

setBackend(backend);
useQf.setState({ demo });
startLive(backend);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Crash>
        <App />
      </Crash>
    </StrictMode>,
  );
}
