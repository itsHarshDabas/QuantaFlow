#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startDaemon, VERSION } from "./daemon.js";

const { values } = parseArgs({
  options: {
    root: { type: "string", short: "r" },
    port: { type: "string", short: "p" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.help) {
  console.log(`quantaflowd ${VERSION}

Usage: quantaflowd [--root <project dir>] [--port <port>]

Starts the QuantaFlow daemon for a project and serves the web UI and API on 127.0.0.1.`);
  process.exit(0);
}
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

const daemon = await startDaemon({
  ...(values.root ? { root: values.root } : {}),
  ...(values.port ? { port: Number.parseInt(values.port, 10) } : {}),
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

console.log(`QuantaFlow ${VERSION} is running at ${daemon.url} for ${daemon.config.root}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Stopping QuantaFlow...");
    void daemon.close().then(() => process.exit(0));
  });
}
