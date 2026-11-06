import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  type AgentProfile,
  ApprovalDecision,
  type QfEvent,
  type StateSnapshot,
  type StreamMessage,
} from "@quantaflow/core";
import type { HarnessRegistry } from "@quantaflow/drivers";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentDirectory } from "./agents.js";
import type { ApprovalCenter } from "./approvals.js";
import { badRequest, HttpError, notFound } from "./errors.js";
import type { EventLog } from "./events.js";
import type { Store } from "./store.js";
import type { Supervisor } from "./supervisor.js";
import type { WorkspaceManager } from "./workspace.js";

export interface ServerDeps {
  version: string;
  root: string;
  store: Store;
  log: EventLog;
  agents: AgentDirectory;
  approvals: ApprovalCenter;
  supervisor: Supervisor;
  workspaces: WorkspaceManager;
  registry: HarnessRegistry;
  allowedOrigins: string[];
  webDist: string | null;
  /** Returns the port actually bound, which is only known after listen(). */
  port: () => number;
}

const MessageBody = z.object({ text: z.string().min(1).max(100_000) });
const AfterQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;

const NO_UI_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>QuantaFlow</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fafafa}code{background:#eee;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>QuantaFlow is running</h1><p>The daemon is up, but the web UI has not been built yet. Run <code>pnpm build</code> in the QuantaFlow repo, then reload.</p>
<p>The API is at <code>/api/state</code>.</p></body></html>`;

function loopbackHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

function allowedOrigins(deps: ServerDeps): Set<string> {
  const port = deps.port();
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    ...deps.allowedOrigins,
  ]);
}

/** Builds the HTTP and WebSocket server. Only loopback clients and same-origin pages get in. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  // Register the WebSocket plugin before the guard hook. Its own onRequest hook marks upgrade
  // requests, so that when the guard rejects one, the plugin's onResponse hook destroys the raw
  // socket. Registered after the guard, a rejected upgrade would leak a paused socket forever.
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  // Only JSON bodies. A cross-site form or text/plain POST can't reach a handler, and any
  // JSON request from another origin needs a CORS preflight, which this server never grants.
  app.removeContentTypeParser("text/plain");

  app.addHook("onRequest", async (request, reply) => {
    // DNS rebinding guard: the Host header must name the loopback address and our port.
    const host = request.headers.host ?? "";
    if (!loopbackHosts(deps.port()).has(host)) {
      return reply.code(403).send({ error: "Forbidden host" });
    }
    const origin = request.headers.origin;
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    const isStream = request.url.startsWith("/api/stream");
    if (origin && (mutating || isStream) && !allowedOrigins(deps).has(origin)) {
      return reply.code(403).send({ error: "Forbidden origin" });
    }
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler((error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) console.error("[quantaflow]", error);
    return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: message });
  });

  const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw badRequest(`Invalid ${what}`, result.error.issues);
    return result.data;
  };
  const knownHarness = (id: string) => deps.registry.get(id) !== undefined;
  const jobView = (id: string) => {
    const view = deps.log.view(id);
    if (!view) throw notFound(`Job "${id}"`);
    return view;
  };

  app.get("/api/health", async () => ({ ok: true, version: deps.version }));

  app.get("/api/state", async (): Promise<StateSnapshot> => {
    const lastSeq = deps.store.lastSeq();
    return {
      version: deps.version,
      root: deps.root,
      agents: deps.agents.list(),
      harnesses: deps.registry.info(),
      jobs: deps.log.allViews(),
      approvals: deps.approvals.list(),
      lastSeq,
    };
  });

  app.get("/api/harnesses", async () => deps.registry.info());

  app.get("/api/agents", async () => deps.agents.list());
  app.post("/api/agents", async (request, reply) => {
    const agent = deps.agents.create(request.body, knownHarness);
    return reply.code(201).send(agent);
  });
  app.put<{ Params: { id: string } }>("/api/agents/:id", async (request) =>
    deps.agents.update(request.params.id, request.body, knownHarness),
  );
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (request) => {
    deps.agents.delete(request.params.id);
    return { ok: true };
  });

  app.get("/api/jobs", async () => deps.log.allViews());
  app.post("/api/jobs", async (request, reply) => {
    const job = deps.supervisor.createJob(request.body);
    return reply.code(201).send(job);
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request) =>
    jobView(request.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request) => {
    jobView(request.params.id);
    const { after } = parse(AfterQuery, request.query, "query");
    return { events: deps.store.eventsForJob(request.params.id, after) };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/messages", async (request) => {
    const { text } = parse(MessageBody, request.body, "message");
    deps.supervisor.sendMessage(request.params.id, text);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request) => {
    await deps.supervisor.cancel(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/merge", async (request) =>
    deps.supervisor.merge(request.params.id, request.body),
  );
  app.post<{ Params: { id: string } }>("/api/jobs/:id/discard", async (request) => {
    await deps.supervisor.discard(request.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id/diff", async (request) => {
    const job = deps.store.getJob(request.params.id);
    if (!job) throw notFound(`Job "${request.params.id}"`);
    return deps.workspaces.diff(job);
  });

  app.get("/api/approvals", async () => deps.approvals.list());
  app.post<{ Params: { id: string } }>("/api/approvals/:id", async (request) => {
    const { decision } = parse(ApprovalDecision, request.body, "decision");
    deps.approvals.decide(request.params.id, decision);
    return { ok: true };
  });

  app.get("/api/stream", { websocket: true }, (socket) => {
    const send = (message: StreamMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER) {
        // A client this far behind should resync from /api/state.
        socket.close(1013, "Too far behind; reconnect");
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const onEvent = (event: QfEvent) => send({ type: "event", event });
    const onAgents = (agents: AgentProfile[]) => send({ type: "agents", agents });
    deps.log.on("event", onEvent);
    deps.agents.on("changed", onAgents);
    socket.on("close", () => {
      deps.log.off("event", onEvent);
      deps.agents.off("changed", onAgents);
    });
    socket.on("message", () => {
      // The stream is server-to-client only.
    });
    send({ type: "hello", lastSeq: deps.store.lastSeq(), version: deps.version });
  });

  app.all("/api/*", async () => {
    throw notFound("API route");
  });

  if (deps.webDist && existsSync(path.join(deps.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: deps.webDist, wildcard: false, index: false });
    const sendIndex = (_request: FastifyRequest, reply: FastifyReply) => {
      const host = _request.headers.host ?? "";
      reply.header(
        "content-security-policy",
        `default-src 'self'; connect-src 'self' ws://${host}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
      );
      return reply.sendFile("index.html");
    };
    app.get("/", sendIndex);
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return sendIndex(request, reply);
      }
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    app.get("/", async (_request, reply) => reply.type("text/html").send(NO_UI_PAGE));
  }

  return app;
}
