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
