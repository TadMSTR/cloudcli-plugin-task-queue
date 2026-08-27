import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateLaunchPolicy,
  loadLaunchPolicy,
  policyPath,
  buildLaunchArgv,
  launchLogName,
  toWorkflowMode,
  LaunchPolicyError,
  lookupAgent,
  type AgentLaunch,
} from '../launch-policy.ts';

// A synthetic HOME. Nothing here touches the real one, and no directory needs to
// exist — validation is about shape, not about the filesystem.
const HOME = '/home/testuser';
const PROJECTS = `${HOME}/.claude/projects`;

function doc(extra: Record<string, unknown> = {}) {
  return { developer: { project_dir: '~/.claude/projects/developer' }, ...extra };
}

const STEWARD = {
  project_dir: '~/.claude/projects/steward',
  run_as_user: 'agent-steward',
  launcher: '/usr/local/sbin/forge/run-steward.sh',
};

function rejects(raw: unknown, label: string) {
  assert.throws(
    () => validateLaunchPolicy(raw, HOME),
    LaunchPolicyError,
    `${label} — must be rejected as a LaunchPolicyError`,
  );
}

// ── The failure this whole module exists to prevent ─────────────────────────

test('a malformed document throws — it never degrades to an empty policy', () => {
  // An empty policy leaves runAsUser absent for every agent, and an absent runAsUser
  // is how steward gets spawned as `claude` under the plugin's own user: a session
  // that appears as steward in every log and holds none of its credentials.
  for (const [raw, label] of [
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'empty mapping'],
    [[], 'a list'],
    ['developer', 'a bare string'],
    [42, 'a number'],
  ] as Array<[unknown, string]>) {
    rejects(raw, label);
  }
});

test('one bad entry rejects the whole document, even alongside a valid steward', () => {
  // A loader that skipped bad entries would pass every other test in this file:
  // steward would launch correctly and sysadmin would silently vanish.
  rejects({ steward: STEWARD, sysadmin: { project_dir: '/etc/passwd' } },
    'valid steward + one bad entry');
});

// ── project_dir ─────────────────────────────────────────────────────────────

test('project_dir is constrained to ~/.claude/projects', () => {
  rejects(doc({ x: { project_dir: '/tmp/evil' } }), 'outside the projects root');
  rejects(doc({ x: { project_dir: '~/.claude/projects/../../evil' } }), 'escaping via ..');
  rejects(doc({ x: { project_dir: 'relative/path' } }), 'relative');
  rejects(doc({ x: { project_dir: '' } }), 'empty');
  rejects(doc({ x: { project_dir: 42 } }), 'non-string');
  rejects({ developer: {} }, 'missing');
  // Must not pass a naive startsWith check.
  rejects(doc({ x: { project_dir: '~/.claude/projectsX/evil' } }), 'sibling sharing the prefix');
});

test('a valid project_dir expands ~ and comes back absolute', () => {
  const p = validateLaunchPolicy(doc(), HOME);
  assert.equal(p.developer.projectDir, `${PROJECTS}/developer`);
  assert.equal(p.developer.runAsUser, null);
  assert.equal(p.developer.launcher, null);
});

test('the projects root itself is accepted, not treated as an escape', () => {
  const p = validateLaunchPolicy({ x: { project_dir: '~/.claude/projects' } }, HOME);
  assert.equal(p.x.projectDir, PROJECTS);
});

// ── run_as_user / launcher ──────────────────────────────────────────────────

test('run_as_user and launcher must be given together', () => {
  rejects(doc({ x: { project_dir: '~/.claude/projects/steward', run_as_user: 'agent-steward' } }),
    'run_as_user alone');
  rejects(doc({ x: { project_dir: '~/.claude/projects/steward', launcher: '/usr/local/sbin/forge/run-steward.sh' } }),
    'launcher alone');
});

test('run_as_user is constrained to agent-* — root and ted are refused', () => {
  for (const user of ['root', 'ted', 'agent-steward; rm -rf /', 'AGENT-STEWARD', 'agent_steward', '', 'agent-']) {
    rejects(doc({ x: { ...STEWARD, run_as_user: user } }), `run_as_user ${JSON.stringify(user)}`);
  }
});

test('launcher is constrained to /usr/local/sbin/forge/', () => {
  for (const l of [
    '/usr/bin/env',
    '/usr/local/sbin/forge/../../../bin/sh',
    'run-steward.sh',
    '/usr/local/sbin/forgery/run-steward.sh',
    '',
  ]) {
    rejects(doc({ x: { ...STEWARD, launcher: l } }), `launcher ${JSON.stringify(l)}`);
  }
});

test('a nonexistent but well-shaped launcher validates — existence is a launch-time check', () => {
  // Validating existence here would make an undeployed launcher break the whole
  // policy load, disabling Start for every other agent too. server.ts checks X_OK
  // per launch and reports it by name.
  const p = validateLaunchPolicy(
    doc({ x: { ...STEWARD, launcher: '/usr/local/sbin/forge/does-not-exist.sh' } }), HOME);
  assert.equal(p.x.launcher, '/usr/local/sbin/forge/does-not-exist.sh');
});

// ── names and keys ──────────────────────────────────────────────────────────

test('agent names and keys are constrained', () => {
  for (const name of ['Developer', '9developer', 'dev eloper', '../developer', '', 'dev/eloper']) {
    rejects({ [name]: { project_dir: '~/.claude/projects/developer' } }, `agent name ${JSON.stringify(name)}`);
  }
  rejects(doc({ x: { project_dir: '~/.claude/projects/developer', extra: 'x' } }), 'unknown key');
  rejects({ developer: 'not-a-mapping' }, 'entry is not a mapping');
  rejects({ developer: ['a'] }, 'entry is an array');
});

// ── argv ────────────────────────────────────────────────────────────────────

test('a run-as agent produces a sudo argv through its launcher, never a claude argv', () => {
  const steward: AgentLaunch = {
    projectDir: `${PROJECTS}/steward`,
    runAsUser: 'agent-steward',
    launcher: '/usr/local/sbin/forge/run-steward.sh',
  };
  const { argv } = buildLaunchArgv(steward, 'auto', 'do the thing', '/usr/bin/claude');
  assert.deepEqual(argv, [
    'sudo', '-n', '-u', 'agent-steward',
    '/usr/local/sbin/forge/run-steward.sh',
    '--workflow-mode', 'auto',
    '--', 'do the thing',
  ]);
  // The regression guard: the claude binary must not appear anywhere in a run-as argv.
  assert.ok(!argv.includes('/usr/bin/claude'), 'claude must not be spawned for a run-as agent');
  assert.equal(argv[0], 'sudo');
});

test('the prompt sits after -- so a prompt cannot be read as a launcher flag', () => {
  const steward: AgentLaunch = {
    projectDir: `${PROJECTS}/steward`,
    runAsUser: 'agent-steward',
    launcher: '/usr/local/sbin/forge/run-steward.sh',
  };
  const { argv } = buildLaunchArgv(steward, 'auto', '--workflow-mode auto', '/usr/bin/claude');
  const sep = argv.indexOf('--');
  assert.ok(sep > 0, 'a -- separator must be present');
  assert.deepEqual(argv.slice(sep + 1), ['--workflow-mode auto']);
});

test('a normal agent produces a claude argv with the permission mode', () => {
  const dev: AgentLaunch = { projectDir: `${PROJECTS}/developer`, runAsUser: null, launcher: null };
  assert.deepEqual(
    buildLaunchArgv(dev, 'auto', 'go', '/usr/bin/claude').argv,
    ['/usr/bin/claude', '-p', 'go', '--permission-mode', 'default'],
  );
  assert.deepEqual(
    buildLaunchArgv(dev, 'review', 'go', '/usr/bin/claude').argv,
    ['/usr/bin/claude', '-p', 'go', '--permission-mode', 'plan'],
  );
  assert.equal(buildLaunchArgv(dev, 'review', 'go', '/usr/bin/claude').note, undefined);
});

test('review on a run-as agent maps to semi-auto and says it is prompt-enforced', () => {
  const steward: AgentLaunch = {
    projectDir: `${PROJECTS}/steward`,
    runAsUser: 'agent-steward',
    launcher: '/usr/local/sbin/forge/run-steward.sh',
  };
  const { argv, note } = buildLaunchArgv(steward, 'review', 'go', '/usr/bin/claude');
  assert.deepEqual(argv.slice(-4), ['--workflow-mode', 'semi-auto', '--', 'go']);
  // run-steward.sh sets --dangerously-skip-permissions itself, so `plan` is not
  // reachable for this agent. The operator must be told, not reassured.
  assert.ok(note && /prompt-enforced/.test(note), 'a caveat must be returned for review');
  assert.ok(!argv.includes('--permission-mode'), 'the launcher accepts no permission mode');
});

// ── mode vocabulary ─────────────────────────────────────────────────────────

test('the Start vocabulary maps onto the queue vocabulary, never passing review through', () => {
  assert.equal(toWorkflowMode('review'), 'semi-auto');
  assert.equal(toWorkflowMode('auto'), 'auto');
  // `review` is not a value task-queue-mcp or run-steward.sh accepts. Passing it
  // through would be rejected by name at the launcher.
  const VALID = new Set(['semi-auto', 'auto', 'manual-then-auto']);
  for (const m of ['review', 'auto'] as const) {
    assert.ok(VALID.has(toWorkflowMode(m)), `${m} must map into the queue vocabulary`);
  }
});

// ── log naming ──────────────────────────────────────────────────────────────

test('launch log names match the dispatcher: <agent>-<task8>.log', () => {
  assert.equal(
    launchLogName('steward', 'e17c99ee-d727-442a-80d3-2ca1a1c751d0'),
    'steward-e17c99ee.log',
  );
  // Short ids must not throw or pad.
  assert.equal(launchLogName('developer', 'abc'), 'developer-abc.log');
});

// ── path resolution ─────────────────────────────────────────────────────────

test('policyPath defaults beside the dispatcher and honours the env override', () => {
  assert.equal(policyPath({} as NodeJS.ProcessEnv, HOME), `${HOME}/scripts/agent-launch.yml`);
  assert.equal(
    policyPath({ AGENT_LAUNCH_POLICY: '/tmp/other.yml' } as NodeJS.ProcessEnv, HOME),
    '/tmp/other.yml',
  );
});

// ── file loading ────────────────────────────────────────────────────────────

test('loadLaunchPolicy throws by name on a missing or unparseable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-policy-'));
  try {
    assert.throws(
      () => loadLaunchPolicy(path.join(dir, 'nope.yml'), HOME),
      (e: Error) => e instanceof LaunchPolicyError && /cannot read launch policy/.test(e.message),
    );

    const bad = path.join(dir, 'bad.yml');
    fs.writeFileSync(bad, 'developer: {project_dir: [unclosed\n');
    assert.throws(
      () => loadLaunchPolicy(bad, HOME),
      (e: Error) => e instanceof LaunchPolicyError && /cannot parse launch policy/.test(e.message),
    );

    const ok = path.join(dir, 'ok.yml');
    fs.writeFileSync(ok, 'steward:\n  project_dir: ~/.claude/projects/steward\n'
      + '  run_as_user: agent-steward\n  launcher: /usr/local/sbin/forge/run-steward.sh\n');
    const policy = loadLaunchPolicy(ok, HOME);
    assert.equal(policy.steward.runAsUser, 'agent-steward');
    assert.equal(policy.steward.projectDir, `${PROJECTS}/steward`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── IV-01: target_agent comes from a queue YAML, not from the policy ────────

test('a prototype-chain name does not resolve as a policy entry', () => {
  // `policy['constructor']` on a plain object is Object itself — truthy, so a bare
  // `if (!entry)` guard would accept it and carry a non-entry into the launch path.
  const policy = validateLaunchPolicy(doc({ steward: STEWARD }), HOME);
  for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(lookupAgent(policy, name), null, `${name} must not resolve`);
  }
  assert.notEqual(lookupAgent(policy, 'developer'), null, 'a real agent still resolves');
  assert.equal(lookupAgent(policy, 'steward')?.runAsUser, 'agent-steward');
});

test('the policy object itself carries no prototype', () => {
  const policy = validateLaunchPolicy(doc(), HOME);
  assert.equal(Object.getPrototypeOf(policy), null);
});
