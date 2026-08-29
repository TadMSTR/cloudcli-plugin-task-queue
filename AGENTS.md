# cloudcli-plugin-task-queue

A CloudCLI tab plugin providing a browser UI for [task-queue-mcp](https://github.com/TadMSTR/task-queue-mcp). TypeScript, bundled with esbuild, no runtime framework.

## What it does

Renders a task list and detail view inside CloudCLI, and offers lifecycle actions (approve, cancel, park/unpark, amend, status change, requeue) plus session launch. It is a front end only — the queue itself lives in `task-queue-mcp`.

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
  dead-letters.ts       Shaping and reason-grouping for dead-lettered records, as
                        pure functions. Extracted for the same reason: the rule that
                        turns N identical failures into ONE problem deserves tests,
                        not a loop inside a renderer.
  path-guard.ts         The realpath-then-prefix filesystem check, in one place.
                        Used by the context-ref preview AND the headless-run
                        log reader. Not pure — resolving symlinks is the point.
  launch-log.ts         Reader side of the launch logs: the inverse of
                        launchLogName, fenced-block extraction, run timestamps.
  launch-policy.ts      Reads and validates the shared launch roster, and builds
                        the spawn argv. Same extraction reason.
  types.ts              Shared types. The Task shape mirrors task-queue-mcp's
                        YAML schema — keep them in step.
  panels/
    task-list.ts        List view, filters, grouping, per-row actions
    task-detail.ts      Detail view, history timeline, amendments, previews
    headless-runs.ts    Headless-run list and log viewer, below the task list
    dead-letters.ts     Collapsed dead-letter section, grouped by failure reason
    styles.ts           Theme colours (read live from CloudCLI CSS vars), helpers
    ws-client.ts        Reconnecting WebSocket client
  tests/                node --test
```

## Invariants

- **The plugin never writes queue YAML directly.** Reads are direct (fast, watchable); every mutation goes through `control-api.ts` to the MCP control API, inheriting its transition validation, `fcntl` locking, and atomic writes. A new mutation means a new control-API action, never an `fs.writeFile`.
- **`ControlAction` must match the MCP's route set.** The union type in `control-api.ts`, the route regex in `server.ts`, and the MCP's custom routes are three copies of one contract. Change one, change all three. The two copies that live in *this* repo are now pinned to each other by a source-level test in `control-api.test.ts` — nothing detected the drift before, because adding an action to the union alone compiles and the failure mode is a button that 404s against the plugin's own backend. The third copy is in another repo and still needs a human.
- **The plugin acts as `operator`, never as an agent.** Every proxied mutation sends `actor: 'operator'`. This is what makes the MCP's `amend_task` authorization accept it; the plugin must never assert an agent's identity.
- **Mutations fail closed without the secret.** `callControlApi` returns 500 and never attempts the fetch when `TASK_QUEUE_API_SECRET` is empty, and logs why. Do not add a fallback that proceeds without it.
- **The version comes from `package.json`.** `server.ts` reads it at startup rather than hardcoding a copy — a hardcoded constant silently drifted and reported a stale version on `/health` for two releases. `package.json` and `manifest.json` must also agree.
- **There is exactly one agent roster, and it is not in this repo.** `~/scripts/agent-launch.yml` (override: `AGENT_LAUNCH_POLICY`) is read by this plugin *and* by `task-dispatcher.py`. A hardcoded `AGENT_PROJECTS` map used to live in `server.ts`; it drifted, lost an agent, and that drift is vikunja#523. Do not add a literal roster back — extend the file.
- **A run-as agent goes through its launcher, always.** An entry with `run_as_user` is spawned as `sudo -n -u <user> <launcher> …`, never as `claude`. Spawning `claude` directly for such an agent bypasses the launcher's identity guard and yields a session that appears as that agent in every log while holding none of its credentials. A missing or non-executable launcher is refused by name — there is no fallback path, deliberately.
- **The launch policy fails closed, loudly.** A missing or malformed policy file disables Start with a named error. It must never degrade to an empty policy: an empty policy makes `run_as_user` absent for every agent, which is precisely the impersonation above.
- **Path guards resolve symlinks, and there is one guard.** `resolveAllowedPath` in `path-guard.ts` calls `fs.realpathSync` *before* the prefix compare; `path.resolve` alone normalises `..` but follows nothing, so a symlink inside an allowed prefix would escape it. The trailing `path.sep` on each prefix is load-bearing — without it `/comms-other` matches `/comms`. Both the context-ref preview and the headless-run reader call this one function. Do not write a second check; a subtly different copy is how this property gets lost.
- **The dead-letters section is read-only, and its count is not conditional on being open.** `GET /dead-letters` reads `dead-letters/*.yml` directly like every other read here; the one mutation (requeue) goes through `control-api.ts` like every other mutation. The count loads on every refresh rather than on expand — a number that appears only after the operator opens the section is a number nobody sees, which is the failure this whole surface exists to end. The healthy value is zero and the heading renders that too.
- **Dead letters are grouped by `failed_reason`, never listed flat.** Seventeen records carrying one identical reason are one bug that fired seventeen times; seventeen sibling rows read as seventeen unrelated problems, which is roughly how they were treated for three months (vikunja#557). The grouping is a pure function in `dead-letters.ts` with tests, not a loop in the panel.
- **A dead-letter record with no `id` is skipped, not rendered.** A row that cannot be addressed is a row whose Requeue button could not work, and offering one would be a lie. Likewise an unparseable failure timestamp renders as unknown — `ago()` maps an invalid date to "just now", which on this surface would claim a three-month-old drop happened seconds ago.
- **The queue watcher does not see `dead-letters/`.** `fs.watch` is not recursive on Linux and the watch is on the queue root, so a task arriving in the subdirectory fires no event. That is deliberate: the section is collapsed, a dead letter is not live work, and the dispatcher unlinks the original from the root as it dead-letters — which does fire. Do not add a recursive watch to stream a surface nobody is watching live.
- **The headless-runs section reads launch logs and never writes them.** Both routes are `GET`, resolve through `resolveAllowedPath`, and never treat a route id as a path: `:id` is validated as `<agent>-<task8>` and the filename is then *rebuilt* via `launchLogName`, so the caller's string cannot reach the filesystem even before the realpath guard runs. The guard applies to the **list** route as well as the detail route — the list head-reads every file, so without it a symlink planted in the log directory puts the first line of its target into a row. That was verified against a real `~/.secrets/forge.env` symlink, which leaked with the guard removed and was refused with it present.
- **The launch-log filename parser is the inverse of `launchLogName`, and is pinned to it by a round-trip test.** `launch-policy.ts` owns the name shape and two producers write it (this plugin and `task-dispatcher.py`). A hardcoded regex here would not error when it drifted — the section would simply list nothing. Unparseable names are **skipped**, never rendered with a guessed or empty agent.
- **A run's status comes from the queue, never from the log.** A log proves a session ran; it does not prove its task closed. `steward-f42d3aeb` completed on 2026-08-23 against a task that sat at `approved` for four days. Render that disagreement — do not infer status from the log's prose.
- **`birthtime` is trusted only when it precedes `mtime`.** The historical logs were copy-migrated into the launch-log directory, and a copy resets birthtime while `cp -p` preserves mtime, so for every migrated run birthtime is *later* than mtime. Trusting it reports each as starting "just now" and running for a negative duration. An untrustworthy birthtime yields a `null` duration, rendered as unknown rather than as zero.
- **Unterminated fenced blocks are dropped from `commands`.** Those strings are handed to the operator behind a copy button, i.e. built to be pasted into a shell. A fence with no closing delimiter has no known end, and half of a destructive command is worse than none. The full text is still rendered in the log pane.
- **The WebSocket upgrade gates on the peer address first, and on `Origin` only if one is present.** The server binds `127.0.0.1` on an ephemeral port, so a non-loopback peer is refused outright; a loopback peer with a *present but wrong* `Origin` is still refused. A loopback peer with **no** `Origin` is accepted, because that is CloudCLI's own plugin WS proxy — it uses the `ws` client library, which sends no `Origin` unless one is passed, and its browser leg is already authenticated by CloudCLI's `verifyClient` before the proxy is invoked.
  v0.4.0 inverted this, rejecting a *missing* `Origin` on the reasoning that only non-browser clients omit it. On this deployment the only non-browser client is that trusted proxy, so every connect was 403'd for three weeks (2239 failures) and the tab read `disconnected` throughout. Do not restore the missing-Origin rejection; the loopback bind is the boundary, and `Origin` alone never did the work this deployment needed. The rule is a pure function in `ws-guard.ts` with tests covering all three cases.

## Testing

```bash
npm install
npm run build   # tsc --noEmit is the typecheck gate; esbuild bundles after it passes
npm test
```

Tests cover `control-api.ts` (the secret gate, task-id validation, header and body shape per action, transport-failure mapping, pass-through of the MCP's authorization rejections, and the union/route-regex drift gate), `dead-letters.ts` (the real dispatcher record shape including the `Date`-valued `created` js-yaml hands back, the id-less and reason-less fallbacks, and the grouping rule against the live seventeen-identical-reasons case), `ws-guard.ts` (all three upgrade cases, including the loopback-with-no-Origin one that v0.4.0 broke), `launch-policy.ts` (every closed-set rejection, whole-document rejection, and both argv shapes), `path-guard.ts` (a **real** symlink escape, traversal, the `/comms-other` sibling case — with real files in a tmpdir, because a mocked `fs` cannot demonstrate that realpath runs first), `launch-log.ts` (round-trip against the real `launchLogName`, the live bare-UUID orphans, path-shaped route ids, fence extraction including the dropped unterminated case, and the birthtime-after-mtime fallback), and the reconnect schedule. The UI panels are not unit-tested — verify them in CloudCLI after `./deploy.sh && pm2 restart cloudcli`.

Two build/test gotchas worth knowing before you touch either script:

- **`npm test` needs Node 22.18+.** `node --test` runs the `.ts` test files directly, relying on Node's built-in type stripping. On Node 20 every test fails with `ERR_UNKNOWN_FILE_EXTENSION`. The plugin's *runtime* requirement is still Node 20+ — `dist/` is bundled plain JS — so the README's stated minimum and CI's Node version differ on purpose.
- **`npm run build` invokes `tsc`/`esbuild` from `node_modules/.bin`, not via bare `npx`.** `npx tsc` silently downloads an unrelated registry package named `tsc` when devDependencies are missing, replacing the typecheck gate with a stranger's binary. Do not "simplify" it back to `npx`.

## Git workflow

Branch before editing — do not commit directly to `main`. `dist/` is gitignored and built by `deploy.sh`, so a merged change is not live until someone runs `./deploy.sh && pm2 restart cloudcli`.
