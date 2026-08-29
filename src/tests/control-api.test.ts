import assert from 'node:assert/strict';
import test from 'node:test';

import { callControlApi } from '../control-api.ts';

// A fetch spy: records calls and returns a canned Response-like object.
function spyFetch(status = 200, json: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('missing secret returns 500 and never attempts fetch', async () => {
  const fetchSpy = spyFetch();
  const result = await callControlApi('task-abc', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    secret: '',
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { ok: false, error: 'TASK_QUEUE_API_SECRET not configured' });
  assert.equal(fetchSpy.calls.length, 0, 'fetch must not be called when the secret is missing');
});

test('invalid task id returns 400 and never attempts fetch', async () => {
  const fetchSpy = spyFetch();
  const result = await callControlApi('bad id!', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    secret: 'synthetic-not-a-real-secret',
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 400);
  assert.equal(fetchSpy.calls.length, 0);
});

test('a configured secret is sent as X-Task-Queue-Secret and status passes through', async () => {
  const fetchSpy = spyFetch(200, { ok: true, status: 'approved' });
  const result = await callControlApi('task-abc', 'approve', {}, {
    apiBase: 'http://127.0.0.1:8485',
    secret: 'synthetic-not-a-real-secret',
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 200);
  assert.equal(fetchSpy.calls.length, 1);
  const { url, init } = fetchSpy.calls[0];
  assert.equal(url, 'http://127.0.0.1:8485/tasks/task-abc/approve');
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['X-Task-Queue-Secret'], 'synthetic-not-a-real-secret');
  // actor defaults to operator; caller body is merged in
  assert.deepEqual(JSON.parse(init.body as string), { actor: 'operator' });
});

test('a transport failure is mapped to 502', async () => {
  const failingFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const result = await callControlApi('task-abc', 'cancel', { note: 'nope' }, {
    apiBase: 'http://127.0.0.1:8485',
    secret: 'synthetic-not-a-real-secret',
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
      secret: 'synthetic-not-a-real-secret',
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
    secret: 'synthetic-not-a-real-secret',
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
      secret: 'synthetic-not-a-real-secret',
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
    secret: 'synthetic-not-a-real-secret',
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
    secret: 'synthetic-not-a-real-secret',
    fetchImpl: fetchSpy.impl,
  });

  assert.equal(result.status, 200);
  assert.equal(fetchSpy.calls[0].url, 'http://127.0.0.1:8485/tasks/task-abc/requeue');
  assert.deepEqual(JSON.parse(fetchSpy.calls[0].init.body as string), {
    actor: 'operator',
    note: 'Requeued via CloudCLI',
  });
});

test('requeue fails closed without the secret, like every other mutation', async () => {
  // Requeue puts work back in front of an agent. It must not be the one action that
  // slipped past the gate.
  const fetchSpy = spyFetch();
  const result = await callControlApi('task-abc', 'requeue', {}, {
    apiBase: 'http://127.0.0.1:8485',
    secret: '',
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
    secret: 'synthetic-not-a-real-secret',
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
