import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type OrchestratorContext, OrchestratorTools, toolDefinitions } from "./tools.js";
import { VERSION } from "./version.js";

/** An MCP server exposing the orchestrator tools. Connect it to a transport to serve it. */
export function createMcpServer(ctx: OrchestratorContext): Server {
  const tools = new OrchestratorTools(ctx);
  const server = new Server(
    { name: "quantaflow", title: "QuantaFlow", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "QuantaFlow runs worker agents for you. Call list_agents to see who can help, create_job to give one a task, and wait_for_jobs to collect the results. Each worker has its own workspace. A person may need to approve some worker steps, so a job can wait.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await tools.call(request.params.name, request.params.arguments, extra.signal);
    return {
      content: [{ type: "text" as const, text: result.text }],
      structuredContent: result.data,
      ...(result.isError ? { isError: true } : {}),
    };
  });
  return server;
}
