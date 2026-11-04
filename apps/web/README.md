# @quantaflow/web

The browser UI for QuantaFlow. The daemon serves the built app at `http://127.0.0.1:4747`, so
`qf up` is all a user needs. This README is for working on the UI itself.

## Run it

```sh
pnpm install
pnpm build                      # builds core first, then the web app

# Terminal 1: the daemon, allowing the Vite dev origin
QF_ALLOWED_ORIGINS=http://localhost:5173 node packages/cli/dist/bin.js up --root <some git repo>

# Terminal 2: the UI with hot reload, proxying /api (and the WebSocket) to the daemon
pnpm --filter @quantaflow/web dev
```

Open `http://localhost:5173`. To fill it with jobs and approvals, run the scripted demo agent
(it needs no installs or keys) from the project you passed to `--root`:

```sh
node packages/cli/dist/bin.js init
node packages/cli/dist/bin.js run demo "write a summary and run the tests" --detach
```

Set `QF_DAEMON_URL` if the daemon is not on `127.0.0.1:4747`.

**No daemon?** Add `?demo` to any URL. An in-browser simulation of a small team (an
orchestrator, dependent jobs, approvals, diffs, a failure) runs behind the same interface as the
real client, so every view works offline.

## Views

| Route     | What it is for                                                                          |
| --------- | --------------------------------------------------------------------------------------- |
| `/table`  | Every job as a row, filterable by state and agent, with bulk cancel                     |
| `/flow`   | Who started what: agents, orchestrator jobs, the jobs they spawned and `then` edges     |
| `/orbit`  | You at the center; the closer a job sits, the sooner it needs you                       |
| `/agents` | Agent profiles (create, edit, delete) and which harnesses are installed                 |

The approvals queue is always on the left (a sheet on narrow screens). `?job=<id>` opens a job's
drawer: chat with follow-ups, diff, raw events and logs.

Keys: `n` new job, `1`–`4` views, `Esc` closes. In the queue, focus a request and press `a`
allow, `Shift+A` always allow, `d` deny.

## How it stays in sync

`src/lib/sync.ts` opens the `/api/stream` WebSocket, buffers events, fetches `/api/state`, then
replays buffered events with `seq` above the snapshot's `lastSeq`. Live events are batched every
40 ms. On a drop it reconnects with backoff and resyncs from a fresh snapshot. All state
folding is pure (`src/store/reduce.ts`) and unit tested.

## Design rules

- Amber means "your turn" and nothing else: approvals, jobs waiting on you, the queue count.
- State colors: blue working, green done, red failed, grey waiting or idle.
- Monospace is only for code, paths, commands and ids.
- Tokens live in `src/styles.css` with a light and a dark set; the theme toggle cycles system,
  light and dark.

## Checks

```sh
pnpm --filter @quantaflow/web test       # vitest
pnpm --filter @quantaflow/web typecheck
pnpm lint                                # biome, from the repo root
```
