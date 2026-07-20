# Changelog

All notable changes to this project will be documented in this file.

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
