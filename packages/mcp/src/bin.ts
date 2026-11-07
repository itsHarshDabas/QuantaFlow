#!/usr/bin/env node
/**
 * qf-mcp: the QuantaFlow MCP server over stdio. The daemon starts it for orchestrator jobs, with
 * QF_URL (the daemon), QF_PARENT_JOB_ID (the orchestrator job) and QF_RUN_ID set.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QfClient } from "@quantaflow/core";
import { createMcpServer } from "./server.js";

const url = process.env.QF_URL;
const parentJobId = process.env.QF_PARENT_JOB_ID ?? process.env.QF_JOB_ID;
if (!url || !parentJobId) {
  process.stderr.write(
    "qf-mcp needs QF_URL and QF_PARENT_JOB_ID. QuantaFlow sets them for orchestrator jobs.\n",
  );
  process.exit(2);
}

const server = createMcpServer({
  client: new QfClient({ baseUrl: url }),
  parentJobId,
  ...(process.env.QF_RUN_ID ? { runId: process.env.QF_RUN_ID } : {}),
});
await server.connect(new StdioServerTransport());
