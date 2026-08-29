import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseEnvFile,
  loadAgentEnv,
  anthropicCredsUsable,
  preLaunchEnv,
} from '../launch-guards.ts';

/**
 * The property under test is not "these functions parse files". It is that a Start which
 * cannot authenticate is refused HERE, by name, instead of becoming a session that 401s
 * deep inside — and that the one agent whose isolation works correctly is not refused
 * along with it.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'launch-guards-'));
}

function withAgentEnv(agent: string, contents: string): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, agent), { recursive: true });
  fs.writeFileSync(path.join(root, agent, '.env'), contents);
  return root;
}

function oauthFile(body: unknown): string {
  const f = path.join(tmpdir(), '.credentials.json');
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
}

const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

// ── parseEnvFile ─────────────────────────────────────────────────────────────

test('parses flat KEY=VALUE lines', () => {
  const env = parseEnvFile('A=1\nB=two\n');
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two');
});

test('skips comments, blank lines, and lines with no =', () => {
  const env = parseEnvFile('# comment\n\nnot-an-assignment\nA=1\n');
  assert.deepEqual(Object.keys(env), ['A']);
});

test('a value containing = keeps everything after the first one', () => {
  // Base64 and JWT-shaped secrets end in `=` padding; splitting on every `=` would
  // truncate exactly the values this guard exists to check.
  assert.equal(parseEnvFile('TOKEN=abc=def==\n').TOKEN, 'abc=def==');
});

test('surrounding quotes are stripped', () => {
  assert.equal(parseEnvFile('A="quoted"\n').A, 'quoted');
  assert.equal(parseEnvFile("A='quoted'\n").A, 'quoted');
});

test('$VAR is NOT expanded', () => {
  // Deliberate deviation from `source` semantics, matching the dispatcher's parser. A
  // side that expanded would resolve a token the other side left literal.
  assert.equal(parseEnvFile('A=$HOME\n').A, '$HOME');
});

// ── loadAgentEnv ─────────────────────────────────────────────────────────────

test('reads the agent env file', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=tok\n');
  assert.equal(loadAgentEnv('developer', root).SCOPED_MCP_BEARER_TOKEN, 'tok');
});

test('a missing env file is empty, not an error', () => {
  assert.deepEqual(loadAgentEnv('nobody', tmpdir()), {});
});

test('an agent name outside the roster shape reads nothing', () => {
  // The name becomes a path segment and reaches here from a queue YAML. Traversal is
  // refused rather than sanitised: there is no legitimate agent named `../../etc`.
  //
  // THE TARGET FILE IS PLANTED ON PURPOSE. An earlier version of this test pointed the
  // traversal at a path that did not exist, so `readFileSync` threw and the function
  // returned {} whether or not the name check ran — it asserted the right outcome for
  // the wrong reason, and deleting the guard left it green. Removing AGENT_NAME_RE must
  // now change the RESULT, not just the route to it.
  const base = tmpdir();
  const root = path.join(base, 'agents');
  fs.mkdirSync(path.join(root, 'developer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'developer', '.env'), 'SCOPED_MCP_BEARER_TOKEN=tok\n');

  // `<root>/../reachable/.env` exists, so an unguarded join would read it.
  fs.mkdirSync(path.join(base, 'reachable'), { recursive: true });
  fs.writeFileSync(path.join(base, 'reachable', '.env'), 'SCOPED_MCP_BEARER_TOKEN=stolen\n');

  assert.deepEqual(loadAgentEnv('../reachable', root), {});
  assert.deepEqual(loadAgentEnv('/etc/shadow', root), {});
  assert.deepEqual(loadAgentEnv('Developer', root), {});
  // The sanity half: a name that IS in shape still reads its file, so the assertions
  // above are about the name check rather than about the fixture being unreadable.
  assert.equal(loadAgentEnv('developer', root).SCOPED_MCP_BEARER_TOKEN, 'tok');
});

// ── anthropicCredsUsable ─────────────────────────────────────────────────────

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  test(`${key} alone is sufficient`, () => {
    // SMCP-32: all three short-circuit the same way, so any one of them is enough.
    assert.equal(anthropicCredsUsable({ [key]: 'x' }, '/nonexistent'), true);
  });
}

test('an unexpired OAuth file is sufficient', () => {
  const f = oauthFile({ claudeAiOauth: { accessToken: 'a', expiresAt: FUTURE } });
  assert.equal(anthropicCredsUsable({}, f), true);
});

test('an EXPIRED OAuth token is not usable', () => {
  // Headless mode does not interactively refresh — it prints the login prompt and the
  // session never reads the task. So expiry is a usability answer, not a staleness one.
  const f = oauthFile({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST } });
  assert.equal(anthropicCredsUsable({}, f), false);
});

test('an OAuth file with no accessToken is not usable', () => {
  assert.equal(anthropicCredsUsable({}, oauthFile({ claudeAiOauth: { expiresAt: FUTURE } })), false);
});

test('a missing or malformed OAuth file is not usable, and does not throw', () => {
  assert.equal(anthropicCredsUsable({}, '/nonexistent/creds.json'), false);
  const bad = path.join(tmpdir(), 'bad.json');
  fs.writeFileSync(bad, 'not json');
  assert.equal(anthropicCredsUsable({}, bad), false);
});

// ── preLaunchEnv: the guard itself ───────────────────────────────────────────

test('a directly-launched agent with no bearer token is refused BY NAME', () => {
  const root = withAgentEnv('developer', '# no token here\n');
  const r = preLaunchEnv('developer', null, {}, { envRoot: root, oauthPath: '/nonexistent' });

  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /SCOPED_MCP_BEARER_TOKEN/);
  assert.match((r as { error: string }).error, /developer/);
});

test('a directly-launched agent with no usable Anthropic credential is refused BY NAME', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=tok\n');
  const r = preLaunchEnv('developer', null, {}, { envRoot: root, oauthPath: '/nonexistent' });

  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Anthropic credential/);
});

test('the agent env file is layered in — this is what makes the guard passable at all', () => {
  // Measured on forge: the CloudCLI process env has CLAUDE_CODE_OAUTH_TOKEN but NO
  // SCOPED_MCP_BEARER_TOKEN. Without this layering the guard would refuse every
  // non-run-as Start, and the sessions it did allow would 401 anyway.
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=from-agent-env\n');
  const r = preLaunchEnv('developer', null, { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, {
    envRoot: root,
    oauthPath: '/nonexistent',
  });

  assert.equal(r.ok, true);
  assert.equal((r as { env: Record<string, string> }).env.SCOPED_MCP_BEARER_TOKEN, 'from-agent-env');
});

test('the agent env overrides the parent env, as the dispatcher does', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=agents-own\n');
  const r = preLaunchEnv('developer', null, { SCOPED_MCP_BEARER_TOKEN: 'cloudclis', CLAUDE_CODE_OAUTH_TOKEN: 'x' }, {
    envRoot: root,
    oauthPath: '/nonexistent',
  });

  // Layering order matters: a session must run with the identity of the agent it is,
  // not with whatever token the launching process happened to be holding.
  assert.equal((r as { env: Record<string, string> }).env.SCOPED_MCP_BEARER_TOKEN, 'agents-own');
});

test('the parent env is otherwise preserved', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=tok\n');
  const r = preLaunchEnv('developer', null, { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x' }, {
    envRoot: root,
    oauthPath: '/nonexistent',
  });

  assert.equal((r as { env: Record<string, string> }).env.PATH, '/usr/bin');
});

// ── the asymmetry that must be preserved ─────────────────────────────────────

test('a RUN-AS agent is not subjected to either check', () => {
  // THE REGRESSION THIS GUARDS. For a run-as agent the credentials are not in this
  // process's env by design — they are in a file only the target user can read, sourced
  // by the launcher as that user. Running these checks here would fail every launch for
  // the one agent whose isolation is working correctly. An empty env and no OAuth file
  // is exactly the state a correctly-isolated steward launch presents.
  const r = preLaunchEnv('steward', 'agent-steward', {}, {
    envRoot: tmpdir(),
    oauthPath: '/nonexistent',
  });

  assert.equal(r.ok, true);
});

test('a run-as agent gets the parent env untouched, with no agent env layered in', () => {
  // sudo scrubs the environment anyway, and reading the agent's file from here would be
  // this process reading a credential it has no business holding.
  const root = withAgentEnv('steward', 'SCOPED_MCP_BEARER_TOKEN=should-not-be-read\n');
  const r = preLaunchEnv('steward', 'agent-steward', { PATH: '/usr/bin' }, {
    envRoot: root,
    oauthPath: '/nonexistent',
  });

  assert.equal(r.ok, true);
  const env = (r as { env: Record<string, string | undefined> }).env;
  // Named explicitly and BEFORE the deepEqual: assert.deepEqual narrows `env` to the
  // expected object's type, so a subsequent lookup of an absent key is a compile error
  // rather than the assertion it is meant to be.
  assert.equal(env.SCOPED_MCP_BEARER_TOKEN, undefined, 'the agent env must not be read here');
  assert.deepEqual(env, { PATH: '/usr/bin' });
});

test('a fully-credentialled direct launch is allowed', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=tok\n');
  const f = oauthFile({ claudeAiOauth: { accessToken: 'a', expiresAt: FUTURE } });

  assert.equal(preLaunchEnv('developer', null, {}, { envRoot: root, oauthPath: f }).ok, true);
});

test('an expired OAuth blocks a direct launch even with a bearer token', () => {
  const root = withAgentEnv('developer', 'SCOPED_MCP_BEARER_TOKEN=tok\n');
  const f = oauthFile({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST } });

  assert.equal(preLaunchEnv('developer', null, {}, { envRoot: root, oauthPath: f }).ok, false);
});
