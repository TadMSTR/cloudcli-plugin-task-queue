import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchLogName, runRecordFileName } from '../launch-policy.ts';
import { parseLaunchLogName, parseRunRecordName } from '../launch-log.ts';
import { parseRunRecord, recordSpan, outcomeLabel, type RunRecord } from '../run-record.ts';

const TASK = 'f42d3aeb-1c4e-4a77-9b2f-0d5e6a7b8c9d';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'r1', task_id: TASK, agent: 'developer', launched_by: 'dispatcher',
    run_as_user: null, launcher: null, workflow_mode: 'auto',
    started: '2026-08-29T10:00:00.000Z', pid: 4242,
    ended: null, exit_code: null, reaped: null, log_path: '/l.log',
    ...over,
  };
}

// ── The filename contract ─────────────────────────────────────────────
// The record's stem must equal the log's stem. If it ever does not, the union in
// listHeadlessRuns() stops joining them and one run renders as two rows — with the
// metadata on one and the output on the other.

test('the record filename is the log filename with a .json suffix', () => {
  for (const agent of ['sysadmin', 'developer', 'research', 'writer', 'security', 'steward']) {
    const log = launchLogName(agent, TASK);
    const rec = runRecordFileName(agent, TASK);
    assert.equal(rec, log.replace(/\.log$/, '.json'), `stems differ for ${agent}`);
    assert.deepEqual(parseRunRecordName(rec), parseLaunchLogName(log));
  }
});

test('parseRunRecordName does not accept a log, and vice versa', () => {
  // The union keys on a shared stem read from ONE directory listing, so a parser that
  // accepted both suffixes would let a `.log` be looked up as a record.
  assert.equal(parseRunRecordName(launchLogName('developer', TASK)), null);
  assert.equal(parseLaunchLogName(runRecordFileName('developer', TASK)), null);
});

test('an orphan named with a bare task UUID matches neither', () => {
  // Two such files exist in the live directory. A row with an empty agent is worse than
  // no row.
  assert.equal(parseRunRecordName('94e1e015-b8dd-4841-a2ae-03be0742b11f.json'), null);
  assert.equal(parseLaunchLogName('94e1e015-b8dd-4841-a2ae-03be0742b11f.log'), null);
});

// ── Parsing what the other repo writes ────────────────────────────────

test('a record written by the dispatcher parses', () => {
  const raw = {
    run_id: 'abc', task_id: TASK, agent: 'steward', launched_by: 'dispatcher',
    run_as_user: 'agent-steward', launcher: '/usr/local/sbin/forge/run-steward.sh',
    workflow_mode: 'auto', started: '2026-08-29T10:00:00+00:00', pid: 991,
    pid_start_ticks: 12345, ended: null, exit_code: null,
    log_path: '/home/ted/.claude/comms/artifacts/task-launches/steward-f42d3aeb.log',
  };
  const parsed = parseRunRecord(raw);
  assert.equal(parsed?.agent, 'steward');
  assert.equal(parsed?.run_as_user, 'agent-steward');
  assert.equal(parsed?.pid, 991);
  assert.equal(parsed?.exit_code, null);
});

test('an unknown field is ignored rather than rejected', () => {
  // The two writers deploy separately, so a record from a newer dispatcher is a routine
  // state. Refusing it would blank the panel on exactly the newest runs.
  const parsed = parseRunRecord({ task_id: TASK, agent: 'developer', a_field_from_2027: 1 });
  assert.equal(parsed?.agent, 'developer');
});

test('a record with no task_id is rejected', () => {
  // Every consumer joins on it; a record without one cannot be attached to anything.
  assert.equal(parseRunRecord({ agent: 'developer', run_id: 'x' }), null);
});

test('a non-object is not a record', () => {
  for (const raw of [null, undefined, 42, 'x', [1, 2], [{ task_id: TASK }]]) {
    assert.equal(parseRunRecord(raw), null, `accepted ${JSON.stringify(raw)}`);
  }
  // NOTE ON THE TWO ARRAY CASES: they are rejected by the task_id check as much as by
  // the Array.isArray guard, because JSON cannot give an array a `task_id` property.
  // Deleting that guard would not fail this test. It is kept as an explicit statement of
  // intent, not as load-bearing validation — do not read this assertion as proving it.
});

test('a pid of 0 or a non-integer is recorded as no pid', () => {
  // "no pid recorded" and "pid 0" must not be confusable — one is missing data, the
  // other would name the kernel scheduler.
  for (const pid of [0, -1, 1.5, '4242', null, true]) {
    assert.equal(parseRunRecord({ task_id: TASK, pid })?.pid, null, `accepted pid ${pid}`);
  }
  assert.equal(parseRunRecord({ task_id: TASK, pid: 4242 })?.pid, 4242);
});

test('exit_code 0 survives parsing as 0, not as null', () => {
  // A `?? null` or a truthiness test here turns every clean exit into an unknown one.
  assert.equal(parseRunRecord({ task_id: TASK, exit_code: 0 })?.exit_code, 0);
});

// ── Spans ─────────────────────────────────────────────────────────────

test('a closed run has a duration', () => {
  const span = recordSpan(record({ ended: '2026-08-29T10:02:30.000Z' }));
  assert.equal(span?.duration_s, 150);
});

test('an open run has no duration, and it is not zero', () => {
  // Nor is it "now minus started", which would tick upward on every poll for a session
  // that in fact died an hour ago and has not been reaped yet.
  const span = recordSpan(record());
  assert.equal(span?.duration_s, null);
  assert.equal(span?.ended, '');
});

test('an end before its start is an unknown duration, not a negative one', () => {
  const span = recordSpan(record({ started: '2026-08-29T10:05:00.000Z', ended: '2026-08-29T10:00:00.000Z' }));
  assert.equal(span?.duration_s, null);
});

test('an unparseable start time falls back to the caller', () => {
  // null is the signal to use the mtime derivation the 29 pre-record logs depend on.
  assert.equal(recordSpan(record({ started: 'not a date' })), null);
});

// ── Outcomes: the assertion this build exists for ─────────────────────

test('an unrecoverable exit code says so and is never rendered as success', () => {
  const label = outcomeLabel(record({ ended: '2026-08-29T10:01:00.000Z', reaped: 'pid-gone' }));
  assert.equal(label, 'ended, exit code unknown');
  assert.notEqual(label, 'exit 0');
});

test('a real exit code is reported as itself', () => {
  assert.equal(outcomeLabel(record({ ended: '2026-08-29T10:01:00.000Z', exit_code: 0 })), 'exit 0');
  assert.equal(outcomeLabel(record({ ended: '2026-08-29T10:01:00.000Z', exit_code: 137 })), 'exit 137');
});

test('a run whose slot was released while it kept running says both things', () => {
  // max-runtime frees the concurrency slot and deliberately does not end the session or
  // touch the task. Reporting it as finished would be the fabricated failure.
  const label = outcomeLabel(record({ ended: '2026-08-29T16:00:00.000Z', reaped: 'max-runtime' }));
  assert.equal(label, 'slot released — still running');
});

test('an open run has no outcome at all', () => {
  assert.equal(outcomeLabel(record()), null);
});

// ── Assembling a list row ─────────────────────────────────────────────

import { toHeadlessRunView, compareRuns, type RunSources } from '../run-record.ts';

function sources(over: Partial<RunSources> = {}): RunSources {
  return {
    agent: 'developer', taskId8: 'f42d3aeb',
    record: null,
    fileTimes: { started: '2026-08-01T00:00:00.000Z', ended: '2026-08-01T00:01:00.000Z', duration_s: 60 },
    logSize: 100, firstLine: 'hello',
    ...over,
  };
}

test('a log with no record still renders — the 29 that predate run records', () => {
  const view = toHeadlessRunView(sources());
  assert.equal(view.has_record, false);
  assert.equal(view.duration_s, 60, 'must fall back to the mtime derivation');
  assert.equal(view.outcome, null);
  assert.equal(view.exit_code, null);
  assert.equal(view.log_readable, true);
});

test('a record with no readable log still renders — the audit launcher', () => {
  // Its log goes to ~/.pm2/logs, which stays outside the preview allowlist because that
  // prefix covers every PM2 service log on the host. Dropping the row instead would omit
  // the commonest kind of headless session here.
  const view = toHeadlessRunView(sources({
    agent: 'security',
    record: record({ agent: 'security', launched_by: 'dispatcher-audit', ended: '2026-08-29T10:01:00.000Z' }),
    fileTimes: null, logSize: 0, firstLine: '',
  }));
  assert.equal(view.log_readable, false);
  assert.equal(view.has_record, true);
  assert.equal(view.launched_by, 'dispatcher-audit');
  assert.equal(view.outcome, 'ended, exit code unknown');
});

test('the record wins on times over the log file', () => {
  // The 26 logs copy-migrated on 2026-08-27 have a birthtime months after their mtime.
  // A record knows when the process started and needs no such defence.
  const view = toHeadlessRunView(sources({
    record: record({ started: '2026-08-29T10:00:00.000Z', ended: '2026-08-29T10:00:30.000Z' }),
  }));
  assert.equal(view.duration_s, 30);
  assert.equal(view.started, '2026-08-29T10:00:00.000Z');
});

test('an unusable record start time falls back to the file, not to nothing', () => {
  const view = toHeadlessRunView(sources({ record: record({ started: 'garbage' }) }));
  assert.equal(view.duration_s, 60);
  assert.equal(view.has_record, true, 'the record is still there — only its times were unusable');
});

test('status comes from the queue and never from the record', () => {
  // steward-f42d3aeb is a completed run whose task sat at `approved` for four days.
  // Rendering that disagreement is the whole point of the panel.
  const view = toHeadlessRunView(sources({
    record: record({ ended: '2026-08-29T10:01:00.000Z', exit_code: 0 }),
    queue: { status: 'approved', taskId: TASK },
  }));
  assert.equal(view.status, 'approved');
  assert.equal(view.outcome, 'exit 0');
});

test('with no queue match the task id still comes from the record', () => {
  // An archived task has no live queue entry; its run stays identifiable regardless.
  const view = toHeadlessRunView(sources({ record: record() }));
  assert.equal(view.task_id, TASK);
  assert.equal(view.status, 'unknown');
});

test('a finished run with no queue match is `unknown`, never `completed`', () => {
  // The tempting inference — the run ended, so the task must be done — is the exact
  // thing this panel exists to refuse. A run ending says nothing about whether its
  // agent got as far as closing the task, and the four-day-invisible steward run is
  // what happens when the two are conflated.
  const view = toHeadlessRunView(sources({
    record: record({ ended: '2026-08-29T10:01:00.000Z', exit_code: 0 }),
  }));
  assert.equal(view.status, 'unknown');
});

test('with neither a queue match nor a record the task id is null', () => {
  assert.equal(toHeadlessRunView(sources()).task_id, null);
});

test('a zero exit code survives into the view as 0', () => {
  const view = toHeadlessRunView(sources({
    record: record({ ended: '2026-08-29T10:01:00.000Z', exit_code: 0 }),
  }));
  assert.equal(view.exit_code, 0);
});

// ── Order ─────────────────────────────────────────────────────────────

test('open runs sort above finished ones', () => {
  // A descending compare on `ended` puts them at the bottom, under three months of
  // finished runs — which is where nobody looks for the session running right now.
  const open = toHeadlessRunView(sources({ record: record({ started: '2020-01-01T00:00:00.000Z' }), fileTimes: null }));
  const recent = toHeadlessRunView(sources({
    record: record({ started: '2026-08-29T09:00:00.000Z', ended: '2026-08-29T09:30:00.000Z' }),
  }));
  assert.deepEqual([recent, open].sort(compareRuns).map(r => r.ended === ''), [true, false]);
});

test('finished runs sort most-recent first', () => {
  const older = toHeadlessRunView(sources({ record: record({ ended: '2026-08-01T00:00:00.000Z' }) }));
  const newer = toHeadlessRunView(sources({ record: record({ ended: '2026-08-29T00:00:00.000Z' }) }));
  assert.deepEqual([older, newer].sort(compareRuns).map(r => r.ended), [newer.ended, older.ended]);
});

test('two open runs sort most-recently-started first', () => {
  const older = toHeadlessRunView(sources({ record: record({ started: '2026-08-01T00:00:00.000Z' }), fileTimes: null }));
  const newer = toHeadlessRunView(sources({ record: record({ started: '2026-08-29T00:00:00.000Z' }), fileTimes: null }));
  assert.deepEqual([older, newer].sort(compareRuns).map(r => r.started), [newer.started, older.started]);
});
