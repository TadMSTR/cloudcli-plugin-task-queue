# Changelog

All notable changes to this project will be documented in this file.

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
