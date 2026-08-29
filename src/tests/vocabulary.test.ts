import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VALID_STATUSES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  VALID_WORKFLOW_MODES,
  STATUS_ORDER,
  STATUS_COLOR,
  WORKFLOW_MODE_DISPLAY,
  isTerminal,
  isWorkflowMode,
} from '../vocabulary.ts';
import { statusColor } from '../panels/styles.ts';
import { sortTasks } from '../panels/task-list.ts';
import { toWorkflowMode, buildLaunchArgv, type AgentLaunch } from '../launch-policy.ts';
import type { ThemeColors, Task } from '../types.ts';

// Distinguishable sentinels, so an assertion can say WHICH theme slot was chosen rather
// than only that two colours differ.
const C: ThemeColors = {
  bg: 'BG', surface: 'SURFACE', border: 'BORDER', text: 'TEXT', muted: 'MUTED',
  accent: 'ACCENT', dim: 'DIM', ok: 'OK', warn: 'WARN', error: 'ERROR',
};

// ── The four sites that missed `routing-failed` (vikunja#558) ────────────────

test('every valid status has a sort position and a colour', () => {
  // These are Record<Status, …>, so a gap is already a tsc error. Asserted at runtime too
  // because the type only binds while the keys stay literal — a future refactor to
  // Record<string, …> would silently restore the `?? 9` / `default: muted` fallthrough
  // that is the whole of #558.
  for (const s of VALID_STATUSES) {
    assert.equal(typeof STATUS_ORDER[s], 'number', `${s} has no STATUS_ORDER position`);
    assert.ok(STATUS_COLOR[s], `${s} has no STATUS_COLOR entry`);
  }
});

test('routing-failed sorts above in-progress, and above every terminal status', () => {
  assert.ok(STATUS_ORDER['routing-failed'] < STATUS_ORDER['in-progress']);
  for (const s of TERMINAL_STATUSES) {
    assert.ok(STATUS_ORDER['routing-failed'] < STATUS_ORDER[s], `sorts below ${s}`);
  }
});

test('routing-failed does not render as muted', () => {
  // The defect was not "no colour" — it was `default: return c.muted`, which is
  // indistinguishable from `parked` and `cancelled`, i.e. "nothing to do here".
  assert.notEqual(statusColor('routing-failed', C), C.muted);
  assert.equal(statusColor('routing-failed', C), C.error);
  assert.equal(statusColor('cancelled', C), C.muted);
});

test('a status this build has never heard of still renders, muted', () => {
  assert.equal(statusColor('some-future-status', C), C.muted);
});

test('the operator status-change control offers routing-failed', () => {
  // The detail panel builds its dropdown from NON_TERMINAL_STATUSES. The old hand-written
  // copy omitted routing-failed, so a task could never be moved into it and the list's
  // status filter never offered the value.
  assert.ok(NON_TERMINAL_STATUSES.includes('routing-failed'));
  assert.equal(isTerminal('routing-failed'), false);
});

test('NON_TERMINAL_STATUSES is exactly VALID_STATUSES minus TERMINAL_STATUSES', () => {
  assert.deepEqual(
    [...NON_TERMINAL_STATUSES].sort(),
    VALID_STATUSES.filter(s => !(TERMINAL_STATUSES as readonly string[]).includes(s)).sort(),
  );
  assert.equal(NON_TERMINAL_STATUSES.length + TERMINAL_STATUSES.length, VALID_STATUSES.length);
});

// The end-to-end version of the above: the sort, not the table it reads.
test('a routing-failed task sorts to the top of its group, not the bottom', () => {
  const task = (status: string, id: string): Task => ({
    id, created: '2026-08-01T00:00:00Z', source_agent: 'research', target_agent: 'developer',
    task_type: 'build', risk_level: 'low', requires_approval: false, status,
    summary: id, ttl_days: 30, payload: { description: '' },
    result: { output: null, completed_by: null, completed_at: null }, history: [],
  });

  const sorted = sortTasks([
    task('cancelled', 'c'),
    task('completed', 'd'),
    task('in-progress', 'p'),
    task('routing-failed', 'r'),
  ]);
  assert.deepEqual(sorted.map(t => t.id), ['r', 'p', 'd', 'c']);
});

// ── manual-then-auto (vikunja#543) ───────────────────────────────────────────

test('every workflow mode has a display entry', () => {
  for (const m of VALID_WORKFLOW_MODES) {
    assert.ok(WORKFLOW_MODE_DISPLAY[m], `${m} has no display entry`);
    assert.ok(WORKFLOW_MODE_DISPLAY[m].hint.length > 0);
  }
});

test('manual-then-auto renders distinctly from both other modes', () => {
  const tone = (m: 'semi-auto' | 'auto' | 'manual-then-auto') => WORKFLOW_MODE_DISPLAY[m].tone;
  assert.notEqual(tone('manual-then-auto'), tone('auto'));
  assert.notEqual(tone('manual-then-auto'), tone('semi-auto'));
});

test('isWorkflowMode accepts the vocabulary and nothing else', () => {
  for (const m of VALID_WORKFLOW_MODES) assert.equal(isWorkflowMode(m), true);
  assert.equal(isWorkflowMode('review'), false); // the UI word, not a queue value
  assert.equal(isWorkflowMode(undefined), false);
});

test('a review Start preserves a queued manual-then-auto instead of flattening it', () => {
  // Flattening it to `semi-auto` pins every task the session spawns back to `semi-auto`,
  // which is exactly what vikunja#533 added the mode to stop.
  assert.equal(toWorkflowMode('review', 'manual-then-auto'), 'manual-then-auto');
  assert.equal(toWorkflowMode('review', 'semi-auto'), 'semi-auto');
  assert.equal(toWorkflowMode('review', undefined), 'semi-auto');
  assert.equal(toWorkflowMode('review'), 'semi-auto');
});

test('an explicit auto Start still wins over the queued mode', () => {
  assert.equal(toWorkflowMode('auto', 'manual-then-auto'), 'auto');
  assert.equal(toWorkflowMode('auto', 'semi-auto'), 'auto');
});

test('the queued mode reaches the launcher argv, and is explained in the note', () => {
  const entry: AgentLaunch = {
    projectDir: '/home/testuser/.claude/projects/steward',
    runAsUser: 'agent-steward',
    launcher: '/usr/local/sbin/forge/run-steward.sh',
  };
  const { argv, note } = buildLaunchArgv(entry, 'review', 'do the thing', '', 'manual-then-auto');
  assert.deepEqual(argv, [
    'sudo', '-n', '-u', 'agent-steward',
    '/usr/local/sbin/forge/run-steward.sh',
    '--workflow-mode', 'manual-then-auto',
    '--', 'do the thing',
  ]);
  assert.match(note ?? '', /manual-then-auto/);
});
