import assert from 'node:assert/strict';
import test from 'node:test';

import { toDeadLetter, groupByReason, UNKNOWN_REASON } from '../dead-letters.ts';
import type { DeadLetter } from '../types.ts';

// A record shaped the way task-dispatcher's move_to_dead_letter actually writes one.
// `created` is a Date because js-yaml parses an unquoted timestamp into one, which is how
// every real file in dead-letters/ stores it — verified against
// 20260529-115542-96e8d44f.yml.
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '96e8d44f-f584-4afc-a3de-aa6882466924',
    created: new Date('2026-05-29T11:55:42.804Z'),
    source_agent: 'developer',
    target_agent: 'security',
    task_type: 'audit',
    summary: 'Security audit requested: forge-build-workflow-skills-2026-05',
    status: 'failed',
    failed_reason: {
      timestamp: '2026-05-29T12:34:00.126757+00:00',
      reason: "Invalid or missing build_name in payload: 'unknown'",
      retry_count: 3,
    },
    ...over,
  };
}

function letter(over: Partial<DeadLetter> = {}): DeadLetter {
  return {
    id: 'a'.repeat(36),
    created: '2026-06-01T00:00:00.000Z',
    source_agent: 'developer',
    target_agent: 'security',
    task_type: 'audit',
    summary: 's',
    reason: 'r',
    failed_at: '2026-06-01T01:00:00.000Z',
    retry_count: 3,
    ...over,
  };
}

// ── toDeadLetter ──────────────────────────────────────────────────────

test('a real dispatcher record is shaped intact', () => {
  const dl = toDeadLetter(raw())!;

  assert.equal(dl.id, '96e8d44f-f584-4afc-a3de-aa6882466924');
  assert.equal(dl.target_agent, 'security');
  assert.equal(dl.task_type, 'audit');
  assert.equal(dl.reason, "Invalid or missing build_name in payload: 'unknown'");
  assert.equal(dl.retry_count, 3);
  assert.equal(dl.failed_at, '2026-05-29T12:34:00.126757+00:00');
});

test('a Date-valued created is serialised, not stringified to [object Object]', () => {
  // js-yaml hands back a Date for every real record. String(date) would render a
  // locale-dependent blob the age helper cannot parse.
  assert.equal(toDeadLetter(raw())!.created, '2026-05-29T11:55:42.804Z');
});

test('a record with no id is dropped', () => {
  // A row we cannot address is a row whose Requeue button could not work.
  assert.equal(toDeadLetter(raw({ id: undefined })), null);
  assert.equal(toDeadLetter(raw({ id: '' })), null);
});

test('a missing failed_reason yields a named unknown reason, not an empty group key', () => {
  const dl = toDeadLetter(raw({ failed_reason: undefined }))!;

  assert.equal(dl.reason, UNKNOWN_REASON);
  assert.equal(dl.retry_count, 0);
  assert.equal(dl.failed_at, '');
});

test('a non-numeric retry_count falls back to 0 rather than rendering undefined', () => {
  const dl = toDeadLetter(raw({ failed_reason: { reason: 'r', retry_count: 'three' } }))!;

  assert.equal(dl.retry_count, 0);
});

test('missing agent and summary fields render as placeholders', () => {
  const dl = toDeadLetter(raw({ target_agent: undefined, summary: undefined }))!;

  assert.equal(dl.target_agent, 'unknown');
  assert.equal(dl.summary, '(no summary)');
});

// ── groupByReason ─────────────────────────────────────────────────────

test('seventeen identical reasons read as one problem, not seventeen', () => {
  // The live case this shipped for: every one of the 17 records in dead-letters/ carries
  // the same failed_reason. A flat list of 17 sibling rows is the reading that let them sit
  // for three months.
  const reason = "Invalid or missing build_name in payload: 'unknown'";
  const groups = groupByReason(
    Array.from({ length: 17 }, (_, i) => letter({ id: `id-${i}`, reason })),
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 17);
  assert.equal(groups[0].reason, reason);
  assert.equal(groups[0].letters.length, 17);
});

test('groups are ordered by size, largest first', () => {
  const groups = groupByReason([
    letter({ id: '1', reason: 'rare' }),
    letter({ id: '2', reason: 'common' }),
    letter({ id: '3', reason: 'common' }),
    letter({ id: '4', reason: 'common' }),
  ]);

  assert.deepEqual(groups.map(g => [g.reason, g.count]), [['common', 3], ['rare', 1]]);
});

test('equal-sized groups are ordered by reason so the render is stable', () => {
  const groups = groupByReason([letter({ id: '1', reason: 'b' }), letter({ id: '2', reason: 'a' })]);

  assert.deepEqual(groups.map(g => g.reason), ['a', 'b']);
});

test('within a group the newest failure sorts first', () => {
  const groups = groupByReason([
    letter({ id: 'old', failed_at: '2026-05-01T00:00:00.000Z' }),
    letter({ id: 'new', failed_at: '2026-07-01T00:00:00.000Z' }),
    letter({ id: 'mid', failed_at: '2026-06-01T00:00:00.000Z' }),
  ]);

  assert.deepEqual(groups[0].letters.map(l => l.id), ['new', 'mid', 'old']);
});

test('a record with no failure timestamp falls back to created for ordering', () => {
  const groups = groupByReason([
    letter({ id: 'no-stamp', failed_at: '', created: '2026-07-01T00:00:00.000Z' }),
    letter({ id: 'stamped', failed_at: '2026-05-01T00:00:00.000Z' }),
  ]);

  assert.deepEqual(groups[0].letters.map(l => l.id), ['no-stamp', 'stamped']);
});

test('an unparseable timestamp does not throw or reorder everything ahead of it', () => {
  const groups = groupByReason([
    letter({ id: 'good', failed_at: '2026-05-01T00:00:00.000Z' }),
    letter({ id: 'junk', failed_at: 'not-a-date', created: 'also-not-a-date' }),
  ]);

  assert.deepEqual(groups[0].letters.map(l => l.id), ['good', 'junk']);
});

test('an empty list is an empty grouping, not a crash', () => {
  assert.deepEqual(groupByReason([]), []);
});

test('grouping does not mutate the input array order', () => {
  const input = [
    letter({ id: 'a', failed_at: '2026-05-01T00:00:00.000Z' }),
    letter({ id: 'b', failed_at: '2026-07-01T00:00:00.000Z' }),
  ];

  groupByReason(input);

  assert.deepEqual(input.map(l => l.id), ['a', 'b']);
});
