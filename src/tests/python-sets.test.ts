import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStringSetBody, literalSets } from '../gates/python-sets.ts';

// A verbatim slice of task-queue-mcp's src/tools/queue.py, comments included. The comments
// are not decoration: the real file interleaves multi-line prose with the values, and a
// parser that only worked on the tidied version would report a vacuous zero on the real one.
const REAL = `VALID_RISK_LEVELS = {"low", "medium", "high"}
VALID_STATUSES = {
    "submitted",
    "approved",
    "pending-approval",
    "in-progress",
    "parked",
    "routing-failed",
    "completed",
    "failed",
    "cancelled",
}
VALID_PRIORITIES = {"normal", "high", "urgent"}
# \`docs\` is the writer's work-list type, introduced when doc-update-queue.jsonl was retired
# (task-queue-lifecycle-and-doc-queue-2026-08 Phase 5).
VALID_TASK_TYPES = {
    "build",  # trailing comment on a value line
    "deploy",
}
VALID_WORKFLOW_MODES = {"semi-auto", "auto", "manual-then-auto"}

SELF_TERMINAL_TASK_TYPES = {"notify"}

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
NON_TERMINAL_STATUSES = VALID_STATUSES - TERMINAL_STATUSES

VALID_TRANSITIONS: dict[str, set[str]] = {
    "in-progress": {"approved"},
    "completed": {"in-progress"},
}
`;

test('parses the real queue.py shape, multi-line and single-line', () => {
  const sets = literalSets(REAL);
  assert.deepEqual(sets.get('VALID_STATUSES'), [
    'submitted', 'approved', 'pending-approval', 'in-progress', 'parked',
    'routing-failed', 'completed', 'failed', 'cancelled',
  ]);
  assert.deepEqual(sets.get('VALID_WORKFLOW_MODES'), ['semi-auto', 'auto', 'manual-then-auto']);
  assert.deepEqual(sets.get('TERMINAL_STATUSES'), ['completed', 'failed', 'cancelled']);
  assert.deepEqual(sets.get('SELF_TERMINAL_TASK_TYPES'), ['notify']);
  assert.deepEqual(sets.get('VALID_RISK_LEVELS'), ['low', 'medium', 'high']);
});

test('comments between and beside values are stripped, not parsed as values', () => {
  assert.deepEqual(literalSets(REAL).get('VALID_TASK_TYPES'), ['build', 'deploy']);
});

// The two upstream constructs that MUST NOT be mistaken for string sets. A derived set
// parsed as empty would make NON_TERMINAL_STATUSES look like it drifted to nothing, and a
// dict parsed loosely would compare its keys against a status list. Both must be absent.
test('a derived set is not parsed as a literal', () => {
  assert.equal(literalSets(REAL).has('NON_TERMINAL_STATUSES'), false);
});

test('an annotated dict assignment is not parsed as a set', () => {
  assert.equal(literalSets(REAL).has('VALID_TRANSITIONS'), false);
});

test('rejects non-string members rather than dropping them', () => {
  assert.equal(parseStringSetBody('"a", 3'), null);
  assert.equal(parseStringSetBody('"a", SOMETHING'), null);
  assert.equal(parseStringSetBody('"k": "v"'), null);
});

test('rejects an escape rather than mis-decoding it', () => {
  assert.equal(parseStringSetBody('"a\\\\nb"'), null);
});

test('rejects an unterminated string', () => {
  assert.equal(parseStringSetBody('"a'), null);
});

test('single and double quotes are both accepted', () => {
  assert.deepEqual(parseStringSetBody(`'a', "b"`), ['a', 'b']);
});

test('a source with no set literals yields an empty map, for the caller to reject', () => {
  // The gate turns this into a hard exit(2). The parser must not decide that itself, and
  // must not invent values: an empty map is the honest answer, and an empty COMPARISON is
  // the failure mode the gate's vacuous-pass guard exists for.
  assert.equal(literalSets('def f():\n    return 1\n').size, 0);
});

test('an unbalanced brace to EOF is skipped, not parsed as far as it got', () => {
  assert.equal(literalSets('VALID_STATUSES = {\n    "submitted",\n').size, 0);
});

test('an indented assignment inside a function is not a module-level set', () => {
  assert.equal(literalSets('def f():\n    VALID_STATUSES = {"x"}\n').size, 0);
});

test('an annotated assignment is skipped even when its body is a valid string set', () => {
  // Two independent layers exclude `VALID_TRANSITIONS: dict[...] = {...}`: the name regex
  // requires a bare ` = `, and the body parser refuses the `:`. Only the second is
  // exercised by the real file, so pin the first here — otherwise loosening the regex is a
  // silent change. Matching the Python gate's behaviour, which handles `ast.Assign` and not
  // `ast.AnnAssign`. If upstream ever annotates one of these sets the gate reports it as
  // missing, which is a loud one-character fix rather than a quiet wrong answer.
  assert.equal(literalSets('VALID_STATUSES: set[str] = {"submitted"}\n').size, 0);
  assert.deepEqual(literalSets('VALID_STATUSES = {"submitted"}\n').get('VALID_STATUSES'), ['submitted']);
});
