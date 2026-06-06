# cloudcli-plugin-task-queue

CloudCLI tab plugin for task queue management on forge. Provides a browser UI inside the CloudCLI web interface to view, filter, and act on agent tasks without leaving the editor.

## Overview

The plugin runs two components:

- **UI** (`dist/index.js`) — Renders a tab panel inside CloudCLI. Shows a filterable task list and detail view with history timeline and context ref previews.
- **Backend server** (`dist/server.js`) — HTTP + WebSocket server launched by CloudCLI. Proxies task-queue-mcp at `localhost:8485` and watches `~/.claude/task-queue/` for file changes.

The backend picks a free ephemeral port at startup and reports it to CloudCLI via JSON on stdout. The UI communicates with the backend via the CloudCLI plugin RPC API (`api.rpc()`), which proxies requests to the backend.

Live task updates arrive via WebSocket — the backend watches `~/.claude/task-queue/*.yml` and pushes a `tasks` event to connected UI clients when files change. The UI debounces refreshes by 2s.

## Features

- Task list with filters by agent, status, and task type
- Detail view: full task data, history timeline, context ref file previews (confined to `~/.claude/comms/` and `~/.claude/task-queue/`)
- Session launch: **review mode** (plan permission, agent presents summary then waits) or **auto mode** (agent claims and executes)
- Task approval (sets status to `approved`, actor `operator`)
- Live connection indicator (WebSocket dot: green = live, grey = disconnected)
- Manual refresh button

## Installation

Requires Node.js 20+ and CloudCLI running on `localhost:3004`.

```bash
cd ~/repos/personal/cloudcli-plugin-task-queue
npm install
./deploy.sh
```

`deploy.sh` builds the TypeScript, copies the plugin to `~/.claude-code-ui/plugins/cloudcli-plugin-task-queue/`, and toggles the plugin via the CloudCLI API to restart the backend server.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TASK_QUEUE_MCP_URL` | `http://localhost:8485/mcp` | task-queue-mcp JSON-RPC endpoint |
| `CLOUDCLI_ORIGIN` | — | Additional allowed WebSocket origin (added to `localhost:3004`) |

## Dependencies

| Package | Purpose |
|---------|---------|
| `ws` | WebSocket server |

## Plugin manifest (`manifest.json`)

| Field | Value |
|-------|-------|
| `name` | `task-queue` |
| `displayName` | `Task Queue` |
| `slot` | `tab` |
| `entry` | `dist/index.js` (UI) |
| `server` | `dist/server.js` (backend) |

## Backend API

The backend server exposes a small HTTP API consumed by the UI via `api.rpc()`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check; returns `{status, uptime, version}` |
| `GET` | `/tasks` | List tasks; query params: `agent`, `status`, `type` |
| `GET` | `/tasks/:id` | Task detail + context ref previews |
| `POST` | `/tasks/:id/start` | Launch headless agent session; body `{mode: "review"\|"auto"}` |
| `POST` | `/tasks/:id/approve` | Approve task via task-queue-mcp |

WebSocket upgrade is handled on the same port. Clients receive `{type: "connected"}` on connect and `{type: "tasks", count, changed}` when task files change.

## Session launch behavior

| Mode | Permission mode | Agent prompt |
|------|----------------|--------------|
| `review` | `plan` | Read task, present summary, wait for approval |
| `auto` | `default` | Read task, claim it (in-progress), execute |

Agent project directories are resolved from the hardcoded map in `server.js`:

| Agent | Project dir |
|-------|-------------|
| `sysadmin` | `~/.claude/projects/sysadmin` |
| `developer` | `~/.claude/projects/developer` |
| `research` | `~/.claude/projects/research` |
| `writer` | `~/.claude/projects/writer` |
| `security` | `~/.claude/projects/security` |

## Build

```bash
npm run build
# Compiles TypeScript + bundles server.js and index.js to dist/
```

Build uses `tsc` for type checking and `esbuild` for bundling (ESM format).

## Deployment

After initial `./deploy.sh`, subsequent deploys follow the same script: build → disable plugin → copy files → re-enable plugin → verify status.

The plugin lives at `~/.claude-code-ui/plugins/cloudcli-plugin-task-queue/`. CloudCLI manages the backend process lifecycle.
