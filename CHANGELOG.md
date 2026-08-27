# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-08-27

Requires a launch policy file at `~/scripts/agent-launch.yml` (see README). The Start
button is disabled with a named error if it is missing or malformed — it never falls back
to a built-in roster, because falling back is what this release removes.

### Fixed
- **The live WebSocket, dead since v0.4.0.** v0.4.0 tightened the upgrade guard to reject a
  *missing* `Origin` as well as a wrong one, reasoning that only non-browser clients omit
  it. The one non-browser client here is CloudCLI's own plugin WS proxy, which uses the
  `ws` library — and that sends no `Origin` unless explicitly passed. Every upstream
  handshake was 403'd from 2026-08-02 to 2026-08-27: 2239 `WS proxy error … 403` lines, and
  a tab that read `disconnected` the whole time. The guard now gates on the **peer**
  (loopback only, refused outright otherwise) and applies the `Origin` allowlist only when
  an `Origin` is actually present. A present-but-wrong `Origin` is still refused; the
  loopback bind was always the real boundary. `AGENTS.md` carried the old rule as a project
  invariant and has been rewritten — leaving it would have invited the same regression from
  the next reviewer. New `ws-guard.ts` holds the decision as a pure function, with tests.
- **The five-second full-panel repaint.** Every failed reconnect emitted `_disconnected`,
  which called `render()` — and `render()` does `root.innerHTML = ''`. So the entire panel
  was torn down and rebuilt every 5s while disconnected, losing scroll position and closing
  any open filter dropdown, even though `wsConnected` was already `false`. Connection state
  no longer reaches `render()` at all: it updates the header badge in place, and only on a
  genuine transition.
- **Start could not launch a run-as agent.** `AGENT_PROJECTS` was a second, drifted copy of
  `task-dispatcher.py`'s roster with no `steward` entry, so Start refused it outright. The
  literal is deleted rather than extended: simply adding an entry would have made
  `launchSession()` spawn `claude` as the plugin's own user, bypassing the launcher whose
  entire purpose is that agent's isolation — a session appearing as steward in every log
  and holding none of steward's credentials.

### Added
- **Reconnect backoff** — 5s → 10s → 30s, capped, reset on a successful open. The first
  delay is unchanged, so a transient blip still recovers as fast as before; the widening is
  for outages. A fixed 5s retry is what turned a three-week outage into 2239 identical log
  lines.
- **`launch-policy.ts`** — one roster, read by this plugin and by `task-dispatcher.py`, from
  `~/scripts/agent-launch.yml`. `AGENT_LAUNCH_POLICY` overrides the path. Every field is
  validated against a closed set (agent name shape, `project_dir` under `~/.claude/projects`,
  `run_as_user` matching `agent-*`, `launcher` under `/usr/local/sbin/forge/`) and the whole
  document is rejected on any violation — a partially-honoured roster would silently launch
  some agent the wrong way. A missing or malformed file is a named error, never an empty
  policy.
- An agent carrying `run_as_user` is launched as
  `sudo -n -u <user> <launcher> --workflow-mode <mode> -- <prompt>`, mirroring the
  dispatcher. A launcher that is missing or not executable is refused **by name**; it never
  degrades to spawning `claude`.
- `env:CLOUDCLI_ORIGIN` in `manifest.json` permissions, so the plugin's allowlist can carry
  the same origin the host's proxy sends.
- Tests for the upgrade guard, the reconnect schedule, and the launch policy. The suite grew
  from 12 to 39.

### Changed
- **Launch logs moved** to `~/.claude/comms/artifacts/task-launches/<agent>-<task8>.log`.
  The dispatcher wrote `~/.pm2/logs/agent-launch-<agent>-<task8>.log` and this plugin wrote
  `<taskId>.log` — two destinations for one concept, so nothing could list "the launches".
  Both now write the same shape to the same directory. `~/.claude/comms` is the side both
  can read; `~/.pm2/logs` is not in `PREVIEW_ALLOWED_PREFIXES` and must not be added, since
  that prefix covers every PM2 service log on the host.
- **Start's `review` maps to the queue's `semi-auto`** for run-as agents rather than being
  passed through. `review` is not a value `task-queue-mcp` or `run-steward.sh` accepts —
  passed through, the launcher refuses it by name. Note that for a run-as agent `review` is
  **prompt-enforced only**: `run-steward.sh` sets `--dangerously-skip-permissions` itself and
  accepts no permission mode, so `--permission-mode plan` is not reachable. The toast says so
  rather than implying a tool gate that is not there.
- A refused WebSocket upgrade now logs why. v0.4.0's refusals were silent on this side; the
  only signal was a 403 on the far side of the proxy, naming neither leg nor the cause.

## [0.4.0] - 2026-08-02

Requires [task-queue-mcp](https://github.com/TadMSTR/task-queue-mcp) **v0.4.0** — the
park, unpark, and amend routes do not exist on earlier versions.

### Added
- **Park / Unpark** replaces the Quarantine button in both the list and detail views. A
  parked task **stays in the list**, rendered muted and dashed with an `Unpark` button, and
  the detail view carries a banner naming the status it will return to. Because `parked` is
  now a status rather than a directory move, `listTasks()` picks it up with no reader
  change — the payoff of the upstream design.
- **Amend** action in the detail view. Amendments render directly below the description,
  highlighted, headed "read these, the description above is unchanged" — an amendment
  nobody reads is no better than a note in a file somewhere.
- `parked` is always present in the status filter dropdown, not only once something is
  parked, so the new status is discoverable before first use. It sorts below the live
  statuses but above the terminal ones.
- The history timeline now labels non-status actions (`amend`) by action rather than
  repeating the task's status, which read as a redundant transition.
- `AGENTS.md`, `LICENSE` (MIT), `.github/workflows/ci.yml` and `release.yml`, and README
  badges — bringing the repo to Baseline standard. CI pins Node 22, not 20: `npm test`
  runs `node --test` against the `.ts` sources and depends on Node's built-in type
  stripping, so on Node 20 every test fails with `ERR_UNKNOWN_FILE_EXTENSION`. The repo
  had no CI before, so this was never exercised on a clean interpreter. The plugin's
  runtime requirement is unchanged at Node 20+ — `dist/` is bundled plain JS.

### Changed
- README rewritten for a public audience. It now says what the plugin *is* — a UI for
  `task-queue-mcp` — and that the MCP server is a hard requirement, which a reader landing
  on the repo cold previously could not tell at all. Adds a Requirements section, a Mermaid
  architecture diagram showing the reads-direct / writes-proxied asymmetry, Non-goals, and
  a description of the agent-to-project mapping mechanism in place of a specific agent
  roster. Host-specific paths and log locations genericized.
- `ControlAction` is now `approve | cancel | status | park | unpark | amend`.

### Fixed
- **The reported version was stale.** `server.ts` hardcoded `VERSION = '0.2.0'` while
  `package.json` and `manifest.json` said `0.3.0`, so `/health` and the WebSocket
  `connected` event both under-reported by two releases. The version is now read from
  `package.json` at startup, so it cannot drift again.
- **The Quarantine confirm dialog promised a restore that did not exist.** It told the
  operator the task "can be restored" — but no reader ever listed `quarantine/`, there was
  no Restore button anywhere in the UI, and the backend's restore route was unreachable.
  Quarantining was a one-way trip from the only interface that showed the queue. It had
  never bitten anyone only because the feature had never been used.
- **WebSocket origin check could be skipped entirely.** The guard read
  `if (origin && !allowed.includes(origin))`, so a client sending *no* `Origin` header
  bypassed it. Browsers always send one; non-browser clients do not — precisely the case
  the check exists for. A missing origin is now rejected.
- **`previewFile` did not resolve symlinks.** It used `path.resolve`, which normalises
  `..` but follows nothing, so a symlink inside an allowed prefix pointing anywhere on disk
  passed the check. Now `fs.realpathSync` first, and the prefix compare uses the platform
  separator.
- **`npm run build` invoked `tsc` and `esbuild` through bare `npx`.** With devDependencies
  absent, `npx tsc` silently downloads an unrelated package named `tsc` from the registry
  and the typecheck gate is replaced by a stranger's binary — observed live during this
  build. Both now resolve from `node_modules/.bin`.

### Security
- **`js-yaml` 4.2.0 → 4.3.1** (GHSA-52cp-r559-cp3m, high). "YAML merge-key chains can force
  quadratic CPU consumption", on a **production** dependency sitting on the hot path —
  `yamlLoad()` parses every task file on every list and detail request. Real-world
  exploitability here is low, since the YAML is written by trusted local writers rather
  than attacker-controlled, but the fix was in the declared range and non-breaking.
  `npm audit --omit=dev` is now clean and enforced in CI.

## [0.3.0] - 2026-07-23

### Changed
- Repalette to follow CloudCLI's own theme. `themeColors()` now reads CloudCLI's
  CSS custom properties live off the shared document root — `--primary` (accent),
  `--background`, `--card` (surface), `--border`, `--foreground` (text),
  `--muted-foreground` (muted) — instead of the previous hardcoded amber palette.
  The accent is now CloudCLI blue, and the plugin auto-follows any future CloudCLI
  palette change (including light/dark toggle, already re-driven via
  `api.onContextChange`). Per-theme hardcoded fallbacks are used only when a var is
  missing; the `dark` param now just selects the fallback set.
- Status colors (`ok`/`warn`/`error`) stay hardcoded green/amber/red — CloudCLI has
  no semantic status vars and its dark `--destructive` is too low-contrast for text.

## [0.2.0] - 2026-07-20

### Fixed
- Control-API mutations (approve/cancel/status/quarantine/restore) were silently
  dead: the plugin subprocess never received `TASK_QUEUE_API_SECRET` (the host
  launcher strips it), so `callControlApi`'s missing-secret branch returned an
  unlogged 500 and the request never left the process. Declare
  `permissions: ["env:TASK_QUEUE_API", "env:TASK_QUEUE_API_SECRET"]` in the
  manifest so the (updated) claudecodeui launcher passes the secret through to
  this plugin. Requires claudecodeui with the permission-gated env passthrough.

### Changed
- Both previously-silent failure branches in `callControlApi` (missing secret,
  transport unreachable) now log to stderr — captured into
  `~/.pm2/logs/cloudcli-error.log` — including the task id and action. Never the
  secret value.
- Extracted `callControlApi` into `src/control-api.ts` with an injectable `fetch`
  so its auth/transport guards are unit-testable without booting the HTTP server.

### Tests
- First tests for this repo (`node --test`, native TS type-stripping): missing
  secret returns 500 and never attempts fetch; invalid task id returns 400;
  configured secret is sent as `X-Task-Queue-Secret`; transport failure maps to 502.

### Security
- `SECURITY[accepted]`: control-API 502 response surfaces a Node fetch connection
  error (e.g. ECONNREFUSED) to the loopback operator UI — pre-existing, accepted
  alongside the OE-02 precedent.
