# QuantaFlow

A local control room for AI agents. Define an agent once (its role, harness, model and permissions), hand it jobs, and run many agents in parallel across Claude Code, Codex, OpenCode, Gemini CLI and Kilo Code. Each job gets its own workspace, every risky action goes through one approvals inbox, and you watch it all live.

> **Status: early development.** This is milestone M0: the monorepo, the shared event model and policy engine, and a scripted demo agent. The daemon, CLI and web UI land in the next milestones. See the [roadmap](#roadmap).

## Why

Running several agents at once is easy. Keeping track of them is not. Each harness has its own terminal, its own permission prompts and its own idea of where files live. QuantaFlow puts them behind one interface:

- **Any harness, one event stream.** QuantaFlow talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), so Claude Code, Codex, OpenCode, Gemini CLI and Kilo Code all report progress the same way.
- **One approvals inbox.** Every permission request from every agent lands in one queue. Policies decide the boring ones for you (reads run freely, edits and commands ask, dangerous commands are always blocked).
- **Isolated workspaces.** Code jobs run in their own git worktree and branch, other jobs in a fresh folder, so parallel agents never step on each other.
- **Not just code.** Agents and jobs are generic, so research, writing and ops work fit too.

## Architecture

```
 Web UI / qf CLI  ──HTTP + WebSocket──▶  quantaflowd (local daemon)  ──ACP over stdio──▶  harness processes
                                         ├─ run engine and job queue                      (one workspace each)
                                         ├─ policy engine and approvals inbox
                                         ├─ event store (SQLite, append-only)
                                         └─ workspace manager (worktrees, ports)
```

Everything an agent does becomes an event in an append-only log. Every view is a projection of that log, which is what makes live views and replay cheap.

| Package                                      | What it does                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)             | Zod schemas for agents, jobs and events, the policy engine, view projections and the API client |
| [`packages/fake-agent`](packages/fake-agent) | A scripted ACP agent with no model behind it, for demos and tests                               |

## Roadmap

1. **M0: Scaffold.** Monorepo, CI, core event model, policy engine, demo agent. (Done.)
2. **M1: One agent end to end.** ACP driver, daemon, SQLite event store, approvals in the `qf` CLI.
3. **M2: Table view and approvals.** Web UI with a live table, an agent drawer and the approvals inbox.
4. **M3: Many harnesses, isolated.** All five harnesses verified, a terminal fallback for anything without ACP, diff review and merge.
5. **M4: Orchestrator.** An orchestrator agent (Claude Code by default, configurable) that plans jobs and steers other agents through MCP tools, plus the live Flow view.
6. **M5: Workflows and Orbit.** Reusable workflow YAML with fan-out and human gates, and the Orbit view.

## Development

Requires Node.js 22.13 or newer and pnpm 10.

```sh
pnpm install
pnpm check   # lint, build, typecheck and test everything
```

## License

[MIT](LICENSE)
