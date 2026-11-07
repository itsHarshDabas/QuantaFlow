# QuantaFlow

A local control room for AI agents. Define an agent once (its role, harness, model and permissions), hand it jobs, and run many agents in parallel across Claude Code, Codex, OpenCode, Gemini CLI and Kilo Code. Each job gets its own workspace, every risky action goes through one approvals inbox, and you watch it all live.

> **Status: early development.** M1 (the ACP driver for every harness, the `quantaflowd` daemon and the `qf` CLI) and M2 (the web UI) are done. Nothing is published to npm yet, so run it from source. See the [roadmap](#roadmap).

## Quick start

Requires Node.js 22.13 or newer, pnpm 10 and git.

```sh
git clone https://github.com/itsHarshDabas/quantaflow && cd quantaflow
pnpm install && pnpm build
alias qf="node $PWD/packages/cli/dist/bin.js"   # or: cd packages/cli && npm link
```

Then, in any project:

```sh
cd ~/code/my-project
qf init                                             # .quantaflow/ with an assistant and a demo agent
qf run demo "write a summary and run the tests"     # no model or API key needed
```

`qf run` streams the agent's work and stops at each approval:

```
▸ edit    Write QUANTAFLOW_DEMO.md
⏸ Approve edit? Write QUANTAFLOW_DEMO.md
  file: QUANTAFLOW_DEMO.md
  [y] allow  [a] always  [n] deny  [s] decide later › y
✓ allowed by you · edit: Write QUANTAFLOW_DEMO.md
…
✓ Done · 3s · 3 tool calls · context 1,200/200,000 tokens
  Branch qf/job_k3x9… · review the changes with `qf diff job_k3x9…`
```

The job ran in its own git worktree on branch `qf/<job id>`, so your checkout is untouched. Review it with `qf diff last`, continue with `qf say last "…"`, then `qf merge last` to bring it into your branch and `qf discard last` to clean up.

For real work, use the `assistant` agent (Claude Code) or add your own. Each harness needs its own CLI installed and signed in; `qf harnesses` shows which ones QuantaFlow found and how to install the rest.

### Keep a daemon running

`qf run` starts a temporary daemon when none is running and stops it when the run ends. To run several jobs at once, use the web UI, or answer approvals from another terminal, keep one running:

```sh
qf up                                      # serves the API (and the web UI once built) on 127.0.0.1:4747
qf run assistant "fix the flaky date test" --detach
qf approvals                               # everything waiting for you, from every job
qf approve apr_7h2k                        # ids accept a unique prefix
qf attach last                             # follow a job and answer its approvals here
```

## The `qf` CLI

| Command                           | What it does                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `qf up [--port N]`                | Start the daemon for this project and keep it running                              |
| `qf status`                       | Daemon, project, job counts and waiting approvals                                  |
| `qf init`                         | Create `.quantaflow/` with a config template and assistant, lead and demo agents   |
| `qf harnesses`                    | Harnesses QuantaFlow can drive, and whether their CLIs are installed               |
| `qf agents`                       | List agents                                                                        |
| `qf agent add <id> --harness <h>` | Add an agent. Also takes `--model`, `--instructions`, `--workspace` and `--preset` |
| `qf agent rm <id>`                | Remove an agent added with `qf agent add`                                          |
| `qf run <agent> <prompt…>`        | Start a job and follow it. Takes `--orchestrate`, `--detach`, `--after <job>`, `-` |
| `qf jobs [--limit n]`             | List jobs, newest first                                                            |
| `qf show <job>`                   | Print a job's conversation, tool calls and approvals                               |
| `qf attach <job>`                 | Follow a running job and answer its approvals                                      |
| `qf say <job> <message…>`         | Send a follow-up and follow the reply                                              |
| `qf diff <job>`                   | The job's changes against the commit it started from, including new files          |
| `qf merge <job> [--squash]`       | Commit the job's work and merge its branch into the branch you have checked out    |
| `qf discard <job>`                | Delete a stopped job's worktree and branch, or its folder                          |
| `qf cancel <job>`                 | Stop a job                                                                         |
| `qf approvals`                    | Everything waiting for you, from every job                                         |
| `qf approve <id> [--always]`      | Allow a waiting tool call                                                          |
| `qf deny <id>`                    | Deny a waiting tool call                                                           |

A job can be named by its full id, a unique prefix, or `last`. Every command takes `--url` (or `QF_URL`), `--root`, `--json`, `--verbose` (thoughts, harness stderr and tool output) and `--no-color`. The first Ctrl+C during `run`, `attach` or `say` cancels the job; the second stops following it.

QuantaFlow works on the nearest folder with a `.quantaflow/` directory, otherwise the top of the git checkout, otherwise the current folder.

## Agents

An agent is a reusable profile: a harness, an optional model, standing instructions, a workspace mode and a permission policy. Put agents in `.quantaflow/agents/<id>.yaml` to version them with the project (the daemon reloads them when they change), or add them with `qf agent add`.

```yaml
# .quantaflow/agents/reviewer.yaml  →  qf run reviewer "review the last commit"
name: Reviewer
harness: codex # claude-code, codex, opencode, gemini, kilo or fake
# model: <id>            # optional; passed to the harness when it supports choosing one
instructions: |
  Review changes for bugs and missing tests. Don't edit files.
workspace: worktree # worktree (own branch), folder (fresh empty folder) or cwd (this checkout)
policy:
  preset: readonly # readonly, safe (default) or trusted
  rules: # checked before the preset, first match wins
    - { action: allow, kinds: [execute], pattern: "^git (log|show|diff)" }
limits:
  maxMinutes: 20
```

**Policies.** `readonly` allows reads and searches and denies everything else. `safe` lets reads run and asks before edits, commands, deletes and web fetches. `trusted` runs everything except deletes, which ask. A short list of destructive commands (such as `rm -rf /` and force-pushes) is always denied, whatever the rules say.

**Workspaces.** `worktree` jobs get `git worktree add` on a new `qf/<job id>` branch under `.quantaflow/state/worktrees/`. Projects that aren't git repositories fall back to `folder`. `cwd` jobs work directly in your checkout, so use it only for agents you trust with it. Each job also gets its own block of 10 ports in `PORT` and `QF_PORT_BASE`, so parallel dev servers don't collide.

## Orchestrators

An orchestrator is a job that hands parts of a task to other agents. Start one with `--orchestrate` (or `role: "orchestrator"` in the API):

```sh
qf run lead --orchestrate "add input validation to every API route, one worker per route file"
qf run demo --orchestrate "orchestrate a summary"   # the scripted version, no model needed
```

QuantaFlow connects the orchestrator to its own MCP server, `quantaflow`, with six tools:

| Tool            | What it does                                                                      |
| --------------- | --------------------------------------------------------------------------------- |
| `list_agents`   | The agents it can give work to                                                    |
| `create_job`    | Start a worker job, optionally after other workers (`dependsOn`)                  |
| `wait_for_jobs` | Wait until workers finish, or until one needs your approval, with a timeout       |
| `get_job`       | A worker's status, its latest reply, the files it changed and, if asked, its diff |
| `send_message`  | A follow-up to a worker, such as a fix request                                    |
| `cancel_job`    | Stop a worker                                                                     |

Workers are ordinary jobs, each in its own workspace and under its own agent's policy, so their approvals still come to you. `qf run --orchestrate` and `qf attach` show the workers' progress and ask their approvals in the same terminal. The tools only reach the workers that orchestrator started. One orchestrator can start up to 20 workers, workers can't be orchestrators, and orchestrators don't count against `maxConcurrent`, because they spend most of their time waiting.

The `lead` agent from `qf init` runs on Claude Code and has a policy rule that allows the `quantaflow` tools without asking. Any harness that supports MCP servers over stdio can be an orchestrator.

## Configuration

`.quantaflow/config.yaml` is optional:

```yaml
port: 4747
maxConcurrent: 4 # jobs running at once; the rest queue
idleMinutes: 15 # close an idle agent session after this long
allowedOrigins: [] # extra web origins allowed to call the API, such as a UI dev server
harnesses: # change how a harness is launched, or add one that speaks ACP
  claude-code:
    command: claude-agent-acp
    args: []
```

Runtime state (the SQLite event log and the worktrees) lives in `.quantaflow/state/`, which `qf init` and the daemon add to `.quantaflow/.gitignore`.

## Security

The daemon is for one person on one machine. It listens on 127.0.0.1 only and has no accounts, so anything that can reach it can run agents. It defends against the browser-based attacks a local server is exposed to:

- The `Host` header must name the loopback address and the daemon's port, which blocks DNS rebinding.
- Requests that change anything, and the event stream, must come from the daemon's own origin or one listed in `allowedOrigins` (or `QF_ALLOWED_ORIGINS`), which blocks cross-site requests from other tabs.
- Request bodies must be JSON, so plain HTML forms can't post to it.

Agents run with your user's permissions. Policies and approvals decide which tool calls the harness may make, but they are not a sandbox, so use `readonly` or `safe` for anything you haven't vetted.

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
| [`packages/drivers`](packages/drivers)       | Starts any ACP harness, maps its updates to QuantaFlow events and relays permission requests    |
| [`apps/daemon`](apps/daemon)                 | `quantaflowd`: the event store, job supervisor, policies, approvals, workspaces and the API     |
| [`packages/cli`](packages/cli)               | `qf`: run, follow and approve jobs from the terminal                                            |
| [`packages/mcp`](packages/mcp)               | `qf-mcp`: the MCP server that gives orchestrator jobs their tools                               |

## Roadmap

1. **M0: Scaffold.** Monorepo, CI, core event model, policy engine, demo agent. (Done.)
2. **M1: One agent end to end.** ACP driver, daemon, SQLite event store, approvals in the `qf` CLI. (Done.)
3. **M2: Table view and approvals.** Web UI with a live table, an agent drawer and the approvals inbox. (Done, with early Flow and Orbit views.)
4. **M3: Many harnesses, isolated.** All five harnesses verified, a terminal fallback for anything without ACP, diff review and merge.
5. **M4: Orchestrator.** An orchestrator agent (Claude Code by default, configurable) that plans jobs and steers other agents through MCP tools, plus the live Flow view. (Backend done.)
6. **M5: Workflows and Orbit.** Reusable workflow YAML with fan-out and human gates, and the Orbit view.

## Development

```sh
pnpm install
pnpm check   # lint, build, typecheck and test everything
```

The HTTP and WebSocket API is typed in [`packages/core/src/client.ts`](packages/core/src/client.ts) (`QfClient`), and every event type is in [`packages/core/src/schemas.ts`](packages/core/src/schemas.ts). The demo agent (`harness: fake`) is scripted: it reads, asks to write `QUANTAFLOW_DEMO.md` unless the prompt says "readonly", asks to run a command when the prompt mentions "run" or "test", and fails when the prompt contains "fail". `QF_FAKE_DELAY_MS` sets its pace.

## License

[MIT](LICENSE)
