# cloudcli-plugin-task-queue

A CloudCLI tab plugin providing a browser UI for [task-queue-mcp](https://github.com/TadMSTR/task-queue-mcp). TypeScript, bundled with esbuild, no runtime framework.

## What it does

Renders a task list and detail view inside CloudCLI, and offers lifecycle actions (approve, cancel, park/unpark, amend, status change) plus session launch. It is a front end only — the queue itself lives in `task-queue-mcp`.

## Module boundaries

```
src/
  index.ts              UI entry — mount/unmount, app state, action handlers.
                        Talks to the backend only via api.rpc(). No fs, no fetch.
  server.ts             Backend — HTTP + WebSocket, launched by CloudCLI as a
                        subprocess. Reads queue YAML directly; proxies every
                        mutation to control-api.ts. Owns the file watcher and
                        the session launcher.
  control-api.ts        The single outbound mutation path to task-queue-mcp.
                        Extracted from server.ts so the auth and transport
                        guards are unit-testable without booting the server.
  ws-guard.ts           The WebSocket upgrade decision, as a pure function of
                        (peer address, Origin, allowlist). Extracted for the
                        same reason: server.ts listens at import time.
  launch-policy.ts      Reads and validates the shared launch roster, and builds
                        the spawn argv. Same extraction reason.
  types.ts              Shared types. The Task shape mirrors task-queue-mcp's
                        YAML schema — keep them in step.
  panels/
    task-list.ts        List view, filters, grouping, per-row actions
    task-detail.ts      Detail view, history timeline, amendments, previews
    styles.ts           Theme colours (read live from CloudCLI CSS vars), helpers
    ws-client.ts        Reconnecting WebSocket client
  tests/                node --test
```

## Invariants

- **The plugin never writes queue YAML directly.** Reads are direct (fast, watchable); every mutation goes through `control-api.ts` to the MCP control API, inheriting its transition validation, `fcntl` locking, and atomic writes. A new mutation means a new control-API action, never an `fs.writeFile`.
- **`ControlAction` must match the MCP's route set.** The union type in `control-api.ts`, the route regex in `server.ts`, and the MCP's custom routes are three copies of one contract. Change one, change all three.
- **The plugin acts as `operator`, never as an agent.** Every proxied mutation sends `actor: 'operator'`. This is what makes the MCP's `amend_task` authorization accept it; the plugin must never assert an agent's identity.
- **Mutations fail closed without the secret.** `callControlApi` returns 500 and never attempts the fetch when `TASK_QUEUE_API_SECRET` is empty, and logs why. Do not add a fallback that proceeds without it.
- **The version comes from `package.json`.** `server.ts` reads it at startup rather than hardcoding a copy — a hardcoded constant silently drifted and reported a stale version on `/health` for two releases. `package.json` and `manifest.json` must also agree.
- **There is exactly one agent roster, and it is not in this repo.** `~/scripts/agent-launch.yml` (override: `AGENT_LAUNCH_POLICY`) is read by this plugin *and* by `task-dispatcher.py`. A hardcoded `AGENT_PROJECTS` map used to live in `server.ts`; it drifted, lost an agent, and that drift is vikunja#523. Do not add a literal roster back — extend the file.
- **A run-as agent goes through its launcher, always.** An entry with `run_as_user` is spawned as `sudo -n -u <user> <launcher> …`, never as `claude`. Spawning `claude` directly for such an agent bypasses the launcher's identity guard and yields a session that appears as that agent in every log while holding none of its credentials. A missing or non-executable launcher is refused by name — there is no fallback path, deliberately.
- **The launch policy fails closed, loudly.** A missing or malformed policy file disables Start with a named error. It must never degrade to an empty policy: an empty policy makes `run_as_user` absent for every agent, which is precisely the impersonation above.
- **Path guards resolve symlinks.** `previewFile` uses `fs.realpathSync` before the prefix check; `path.resolve` alone normalises `..` but follows nothing, so a symlink inside an allowed prefix would escape it.
- **The WebSocket upgrade gates on the peer address first, and on `Origin` only if one is present.** The server binds `127.0.0.1` on an ephemeral port, so a non-loopback peer is refused outright; a loopback peer with a *present but wrong* `Origin` is still refused. A loopback peer with **no** `Origin` is accepted, because that is CloudCLI's own plugin WS proxy — it uses the `ws` client library, which sends no `Origin` unless one is passed, and its browser leg is already authenticated by CloudCLI's `verifyClient` before the proxy is invoked.
  v0.4.0 inverted this, rejecting a *missing* `Origin` on the reasoning that only non-browser clients omit it. On this deployment the only non-browser client is that trusted proxy, so every connect was 403'd for three weeks (2239 failures) and the tab read `disconnected` throughout. Do not restore the missing-Origin rejection; the loopback bind is the boundary, and `Origin` alone never did the work this deployment needed. The rule is a pure function in `ws-guard.ts` with tests covering all three cases.

## Testing

```bash
npm install
npm run build   # tsc --noEmit is the typecheck gate; esbuild bundles after it passes
npm test
```

Tests cover `control-api.ts` (the secret gate, task-id validation, header and body shape per action, transport-failure mapping, pass-through of the MCP's authorization rejections), `ws-guard.ts` (all three upgrade cases, including the loopback-with-no-Origin one that v0.4.0 broke), `launch-policy.ts` (every closed-set rejection, whole-document rejection, and both argv shapes), and the reconnect schedule. The UI panels are not unit-tested — verify them in CloudCLI after `./deploy.sh && pm2 restart cloudcli`.

Two build/test gotchas worth knowing before you touch either script:

- **`npm test` needs Node 22.18+.** `node --test` runs the `.ts` test files directly, relying on Node's built-in type stripping. On Node 20 every test fails with `ERR_UNKNOWN_FILE_EXTENSION`. The plugin's *runtime* requirement is still Node 20+ — `dist/` is bundled plain JS — so the README's stated minimum and CI's Node version differ on purpose.
- **`npm run build` invokes `tsc`/`esbuild` from `node_modules/.bin`, not via bare `npx`.** `npx tsc` silently downloads an unrelated registry package named `tsc` when devDependencies are missing, replacing the typecheck gate with a stranger's binary. Do not "simplify" it back to `npx`.

## Git workflow

Branch before editing — do not commit directly to `main`. `dist/` is gitignored and built by `deploy.sh`, so a merged change is not live until someone runs `./deploy.sh && pm2 restart cloudcli`.
