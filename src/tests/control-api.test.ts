import assert from 'node:assert/strict';
import test from 'node:test';

import { callControlApi } from '../control-api.ts';
import type { TokenResult } from '../queue-token.ts';

const GOOD: TokenResult = { ok: true, token: 'synthetic-not-a-real-token' };
const MISSING: TokenResult = { ok: false, error: 'task-queue token file /home/x/.config/cloudcli-plugin-task-queue/token is missing' };

// A fetch spy: records calls and returns a canned Response-like object.
function spyFetch(status = 200, json: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('a missing token returns 500 naming the file, and never attempts fetch', async () => {
  const fetchSpy = spyFetch();
  const result = await callControlApi('task-abc', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    token: MISSING,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { ok: false, error: MISSING.ok ? '' : MISSING.error });
  assert.equal(fetchSpy.calls.length, 0, 'fetch must not be called without a token');
});

test('invalid task id returns 400 and never attempts fetch', async () => {
  const fetchSpy = spyFetch();
  const result = await callControlApi('bad id!', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 400);
  assert.equal(fetchSpy.calls.length, 0);
});

test('the token is sent as X-Task-Queue-Token, never Authorization, and status passes through', async () => {
  const fetchSpy = spyFetch(200, { ok: true, status: 'approved' });
  const result = await callControlApi('task-abc', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 200);
  assert.equal(fetchSpy.calls.length, 1);
  const { url, init } = fetchSpy.calls[0];
  assert.equal(url, 'http://127.0.0.1:8485/tasks/task-abc/approve');
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['X-Task-Queue-Token'], 'synthetic-not-a-real-token');
  assert.equal(headers['X-Task-Queue-Secret'], undefined, 'the retired shared-secret header must not be sent');
  assert.equal(headers.Authorization, undefined, 'a client token must never be offered as a bearer');
  // actor defaults to operator; caller body is merged in
  assert.deepEqual(JSON.parse(init.body as string), { actor: 'operator' });
});

test('a transport failure is mapped to 502', async () => {
  const failingFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const result = await callControlApi('task-abc', 'cancel', { note: 'nope' }, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: failingFetch,
  });

  assert.equal(result.status, 502);
  assert.match((result.data as { error: string }).error, /unreachable/);
});

test('park and unpark route to their own control-API paths', async () => {
  for (const action of ['park', 'unpark'] as const) {
    const fetchSpy = spyFetch();
    const result = await callControlApi('task-abc', action, { note: 'via CloudCLI' }, {
      apiBase: 'http://127.0.0.1:8485',
      token: GOOD,
      fetchImpl: fetchSpy.impl,
    });

    assert.equal(result.status, 200);
    assert.equal(fetchSpy.calls[0].url, `http://127.0.0.1:8485/tasks/task-abc/${action}`);
    assert.deepEqual(JSON.parse(fetchSpy.calls[0].init.body as string), {
      actor: 'operator',
      note: 'via CloudCLI',
    });
  }
});

test('unpark can carry an explicit target status', async () => {
  const fetchSpy = spyFetch();
  await callControlApi('task-abc', 'unpark', { status: 'approved' }, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.deepEqual(JSON.parse(fetchSpy.calls[0].init.body as string), {
    actor: 'operator',
    status: 'approved',
  });
});

test('amend sends the amendment text and defaults the actor to operator', async () => {
  const fetchSpy = spyFetch(200, { ok: true, amendment_count: 1 });
  const result = await callControlApi(
    'task-abc',
    'amend',
    { amendment: 'scope narrowed', reason: 'Amended via CloudCLI' },
    {
      apiBase: 'http://127.0.0.1:8485',
      token: GOOD,
      fetchImpl: fetchSpy.impl,
    },
  );

  assert.equal(result.status, 200);
  assert.equal(fetchSpy.calls[0].url, 'http://127.0.0.1:8485/tasks/task-abc/amend');
  // The operator actor is what makes the MCP's source_agent authorization accept this —
  // the plugin is an operator surface, never an agent asserting its own identity.
  assert.deepEqual(JSON.parse(fetchSpy.calls[0].init.body as string), {
    actor: 'operator',
    amendment: 'scope narrowed',
    reason: 'Amended via CloudCLI',
  });
});

test('an authorization rejection from the control API passes through unmodified', async () => {
  // The MCP rejects an amend from a non-permitted actor with a 400. The plugin must
  // surface that verdict rather than swallowing or reinterpreting it.
  const fetchSpy = spyFetch(400, { ok: false, error: "actor 'developer' may not amend this task" });
  const result = await callControlApi('task-abc', 'amend', { amendment: 'x' }, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 400);
  assert.match((result.data as { error: string }).error, /may not amend/);
});

// ── requeue ───────────────────────────────────────────────────────────

test('requeue posts to the requeue route as operator', async () => {
  const fetchSpy = spyFetch(200, { ok: true, task_id: 'x', requeued_from: 'dead-letters' });
  const result = await callControlApi('task-abc', 'requeue', { note: 'Requeued via CloudCLI' }, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 200);
  assert.equal(fetchSpy.calls[0].url, 'http://127.0.0.1:8485/tasks/task-abc/requeue');
  assert.deepEqual(JSON.parse(fetchSpy.calls[0].init.body as string), {
    actor: 'operator',
    note: 'Requeued via CloudCLI',
  });
});

test('requeue fails closed without a token, like every other mutation', async () => {
  // Requeue puts work back in front of an agent. It must not be the one action that
  // slipped past the gate.
  const fetchSpy = spyFetch();
  const result = await callControlApi('task-abc', 'requeue', {}, {
    apiBase: 'http://127.0.0.1:8485',
    token: MISSING,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 500);
  assert.equal(fetchSpy.calls.length, 0);
});

test("the MCP's 404 for a non-dead-lettered task passes through unchanged", async () => {
  // The MCP scopes requeue to dead-letters/ alone; a `failed` task in the live queue is a
  // 404 there. The plugin must surface that, not translate it into a success.
  const fetchSpy = spyFetch(404, { ok: false, error: 'not found' });
  const result = await callControlApi('task-abc', 'requeue', {}, {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 404);
  assert.deepEqual(result.data, { ok: false, error: 'not found' });
});

// ── the three-copies contract ─────────────────────────────────────────

test('the ControlAction union and the server route regex name the same actions', async () => {
  // AGENTS.md: "ControlAction must match the MCP's route set. The union type in
  // control-api.ts, the route regex in server.ts, and the MCP's custom routes are three
  // copies of one contract."
  //
  // Two of those three are in this repo and can be pinned to each other here. Nothing
  // detected the drift before: adding an action to the union alone compiles, and adding it
  // to the regex alone type-errors only if a literal is passed — the failure mode is a
  // button that 404s in the plugin's own backend.
  const fs = await import('node:fs');
  const url = await import('node:url');

  const read = (rel: string) =>
    fs.readFileSync(url.fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

  const union = read('../control-api.ts').match(/export type ControlAction =([\s\S]*?);/);
  assert.ok(union, 'ControlAction union not found — has it been renamed?');
  const unionActions = [...union[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).sort();

  const regex = read('../server.ts').match(/\\\/\(([a-z|]+)\)\$/);
  assert.ok(regex, 'mutation route regex not found in server.ts — has it been rewritten?');
  const routeActions = regex[1].split('|').sort();

  assert.deepEqual(routeActions, unionActions);
  assert.ok(unionActions.includes('requeue'), 'the fixture itself must be non-trivial');
});

// ── reads (v0.11.0) ───────────────────────────────────────────────────

import { queueGet, tasksQuery, apiErrorMessage, LIST_PAGE_MAX } from '../control-api.ts';

test('queueGet sends the token as X-Task-Queue-Token on a GET', async () => {
  const fetchSpy = spyFetch(200, { ok: true, tasks: [], count: 0, truncated: false });
  const result = await queueGet('/tasks?limit=5', {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });
  assert.equal(result.status, 200);
  const { url, init } = fetchSpy.calls[0];
  assert.equal(url, 'http://127.0.0.1:8485/tasks?limit=5');
  assert.equal(init.method, 'GET');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['X-Task-Queue-Token'], 'synthetic-not-a-real-token');
  assert.equal(headers.Authorization, undefined);
});

test('queueGet without a token fails closed and never fetches', async () => {
  const fetchSpy = spyFetch();
  const result = await queueGet('/tasks', {
    apiBase: 'http://127.0.0.1:8485',
    token: MISSING,
    fetchImpl: fetchSpy.impl,
  });
  assert.equal(result.status, 500);
  assert.equal(fetchSpy.calls.length, 0);
});

test('a refused read passes its status and error through', async () => {
  const fetchSpy = spyFetch(403, { ok: false, error: 'scope read required' });
  const result = await queueGet('/tasks', {
    apiBase: 'http://127.0.0.1:8485',
    token: GOOD,
    fetchImpl: fetchSpy.impl,
  });
  assert.equal(result.status, 403);
  assert.equal(apiErrorMessage(result), 'task-queue API 403: scope read required');
});

test('tasksQuery drops empty filters and encodes the rest', () => {
  assert.equal(tasksQuery({}), '/tasks');
  assert.equal(
    tasksQuery({ target_agent: 'developer', status: '', task_type: undefined, limit: LIST_PAGE_MAX }),
    '/tasks?target_agent=developer&limit=1000',
  );
  assert.equal(tasksQuery({ status: 'a b&c' }), '/tasks?status=a+b%26c');
  assert.equal(tasksQuery({ include_dead_letters: true }), '/tasks?include_dead_letters=true');
});

// ── the manifest grants no credential (vikunja#396) ───────────────────

test('the manifest requests no task-queue credential from the host env', async () => {
  // A credential granted through the manifest has to be in the CloudCLI host's own
  // environment, and every agent session CloudCLI launches inherits that environment.
  // That is how the shared secret reached every session. The token is read from a file.
  const fs = await import('node:fs');
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf-8'),
  ) as { permissions?: string[] };
  const env = (manifest.permissions ?? []).filter(p => p.startsWith('env:'));
  assert.deepEqual(env.sort(), ['env:CLOUDCLI_ORIGIN', 'env:TASK_QUEUE_API']);
});
