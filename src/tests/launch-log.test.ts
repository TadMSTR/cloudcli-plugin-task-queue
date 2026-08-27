import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchLogName } from '../launch-policy.ts';
import {
  parseLaunchLogName,
  parseRunId,
  runIdToFilename,
  runId,
  firstLine,
  extractFencedBlocks,
  runTimes,
} from '../launch-log.ts';

// ── The producer/parser contract ──────────────────────────────────────
// These are the tests that matter most. The parser is the inverse of launchLogName,
// and pinning it to the real function is what stops the two drifting apart silently —
// a drifted parser does not error, it just lists nothing.

test('parseLaunchLogName inverts launchLogName for every rostered agent', () => {
  const taskId = 'f42d3aeb-1c4e-4a77-9b2f-0d5e6a7b8c9d';
  for (const agent of ['sysadmin', 'developer', 'research', 'writer', 'security', 'steward']) {
    const parsed = parseLaunchLogName(launchLogName(agent, taskId));
    assert.deepEqual(parsed, { agent, taskId8: 'f42d3aeb' }, `round trip failed for ${agent}`);
  }
});

test('parseLaunchLogName inverts launchLogName for a hyphenated agent name', () => {
  // No rostered agent has a hyphen today, but the split must stay unambiguous if one
  // ever does — the task segment is fixed-width and anchored, so it cannot be eaten.
  const name = launchLogName('build-worker', 'abcdef01-2222-3333-4444-555555555555');
  assert.deepEqual(parseLaunchLogName(name), { agent: 'build-worker', taskId8: 'abcdef01' });
});

test('runIdToFilename round-trips a parsed run id back through the producer', () => {
  const name = launchLogName('steward', 'f42d3aeb-1c4e-4a77-9b2f-0d5e6a7b8c9d');
  const parsed = parseRunId('steward-f42d3aeb');
  assert.ok(parsed);
  assert.equal(runIdToFilename(parsed), name);
  assert.equal(runId(parsed.agent, parsed.taskId8), 'steward-f42d3aeb');
});

// ── Rejection ─────────────────────────────────────────────────────────

test('parseLaunchLogName rejects the bare-UUID orphans in the live log directory', () => {
  // Two real files predating the <agent>-<task8> scheme. They must be SKIPPED, never
  // rendered as a row with a guessed or empty agent.
  assert.equal(parseLaunchLogName('94e1e015-b8dd-4841-a2ae-03be0742b11f.log'), null);
  assert.equal(parseLaunchLogName('ddf53cb9-eda6-46ec-8015-48268c92a466.log'), null);
});

test('parseLaunchLogName rejects malformed names', () => {
  for (const bad of [
    'steward.log',                 // no task segment
    'steward-f42d3aeb',            // no extension
    'steward-f42d3ae.log',         // 7 chars
    'steward-f42d3aebc.log',       // 9 chars
    'steward-f42d3aeg.log',        // 'g' is not hex
    'steward-F42D3AEB.log',        // uppercase — uuid4 renders lowercase
    '-f42d3aeb.log',               // empty agent
    '9steward-f42d3aeb.log',       // agent must start with a letter
    'Steward-f42d3aeb.log',        // uppercase agent
    'steward-f42d3aeb.log.bak',
    'steward-f42d3aeb.txt',
    '',
  ]) {
    assert.equal(parseLaunchLogName(bad), null, `should reject: ${bad}`);
  }
});

test('parseRunId rejects anything path-shaped', () => {
  // The route id must never be usable as a path. This is the first of the two
  // barriers; resolveAllowedPath is the second.
  for (const bad of [
    '../../../etc/passwd',
    '../../.secrets/forge',
    'steward-f42d3aeb/../../etc/passwd',
    '/etc/passwd',
    'steward-f42d3aeb ',
    '..',
    '.',
  ]) {
    assert.equal(parseRunId(bad), null, `should reject: ${bad}`);
  }
});

// ── first_line ────────────────────────────────────────────────────────

test('firstLine returns the first non-empty line, trimmed', () => {
  assert.equal(firstLine('\n\n   Both memory checkpoints are written.  \nnext\n'),
    'Both memory checkpoints are written.');
});

test('firstLine returns empty string for blank or empty input', () => {
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('\n \n\t\n'), '');
});

test('firstLine truncates with an ellipsis at the cap', () => {
  const out = firstLine('x'.repeat(500), 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
});

// ── Fenced-block extraction ───────────────────────────────────────────

test('extractFencedBlocks pulls the body of each fence, dropping the info string', () => {
  const text = [
    'Run this:', '```bash', 'pm2 restart cloudcli', '```',
    'and then:', '```', './deploy.sh', '```', 'done',
  ].join('\n');
  assert.deepEqual(extractFencedBlocks(text), ['pm2 restart cloudcli', './deploy.sh']);
});

test('extractFencedBlocks keeps a multi-line block intact', () => {
  const text = '```\ncd ~/repos\ngit status\n```';
  assert.deepEqual(extractFencedBlocks(text), ['cd ~/repos\ngit status']);
});

test('extractFencedBlocks returns an empty array when there are no fences', () => {
  // Every one of the 26 logs migrated on 2026-08-27 is in this state — the Commands
  // block must be omitted entirely rather than rendered empty.
  assert.deepEqual(extractFencedBlocks('Task b32e75e2 is done, nothing to run.'), []);
});

test('extractFencedBlocks skips an empty fence', () => {
  assert.deepEqual(extractFencedBlocks('```\n\n```'), []);
});

test('extractFencedBlocks DROPS an unterminated fence', () => {
  // These strings are handed to the operator with a copy button. A fence with no
  // closing delimiter has no known end, and half a command is worse than none.
  assert.deepEqual(extractFencedBlocks('```bash\nrm -rf /tmp/x --exclude=keep'), []);
  assert.deepEqual(
    extractFencedBlocks('```\nfirst\n```\ntext\n```\ntruncated here'),
    ['first'],
  );
});

test('extractFencedBlocks handles an indented fence', () => {
  assert.deepEqual(extractFencedBlocks('  ```sh\n  echo hi\n  ```'), ['echo hi']);
});

// ── Run timestamps ────────────────────────────────────────────────────

test('runTimes uses birthtime when it precedes mtime', () => {
  const start = Date.UTC(2026, 7, 23, 20, 34, 2);
  const end = Date.UTC(2026, 7, 23, 20, 35, 29);
  const t = runTimes({ birthtimeMs: start, mtimeMs: end });
  assert.equal(t.started, new Date(start).toISOString());
  assert.equal(t.ended, new Date(end).toISOString());
  assert.equal(t.duration_s, 87);
});

test('runTimes falls back to mtime when birthtime is AFTER mtime', () => {
  // The copy-migration case, and the reason this guard exists: cp -p preserves mtime
  // but resets birthtime to the copy time, so every migrated log has birthtime in the
  // future relative to mtime. Reporting that verbatim would show a run that started
  // "just now" and lasted a negative number of seconds.
  const written = Date.UTC(2026, 7, 23, 20, 35, 29);
  const copied = Date.UTC(2026, 7, 27, 17, 9, 34);
  const t = runTimes({ birthtimeMs: copied, mtimeMs: written });
  assert.equal(t.started, new Date(written).toISOString());
  assert.equal(t.ended, new Date(written).toISOString());
  assert.equal(t.duration_s, null, 'duration must be unknown, never negative');
});

test('runTimes falls back to mtime when birthtime is unavailable', () => {
  const end = Date.UTC(2026, 7, 23, 20, 35, 29);
  for (const birthtimeMs of [0, NaN]) {
    const t = runTimes({ birthtimeMs, mtimeMs: end });
    assert.equal(t.started, new Date(end).toISOString());
    assert.equal(t.duration_s, null);
  }
});

test('runTimes reports a zero-second run as 0, not as unknown', () => {
  // birthtime === mtime is a legitimately fast run, distinct from an unusable one.
  const at = Date.UTC(2026, 7, 23, 20, 35, 29);
  assert.equal(runTimes({ birthtimeMs: at, mtimeMs: at }).duration_s, 0);
});
