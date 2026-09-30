import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import url from 'node:url';

import { SharedRead, invalidatingWrite } from '../shared-read.ts';
import { callControlApi, queueGet, tasksQuery, LIST_PAGE_MAX, type ControlApiOptions } from '../control-api.ts';

/** A promise you resolve or reject from outside, to hold a read on the wire. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A stand-in task-queue API: one task whose status a POST .../park changes, and a count of
 * GET /tasks requests. Each GET is held until the test releases it, so "in flight" is a
 * state the test controls rather than a timing it hopes for.
 */
function fakeApi() {
  let status = 'approved';
  const gets: Array<{ release: () => void }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (init?.method === 'POST' && u.endsWith('/park')) {
      status = 'parked';
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // Snapshot at the moment the request arrives: that is what a real read returns.
    const body = JSON.stringify({ tasks: [{ id: 'abc12345-0000', status }], count: 1, truncated: false });
    const held = deferred<void>();
    gets.push({ release: () => held.resolve() });
    await held.promise;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const opts: ControlApiOptions = {
    apiBase: 'http://127.0.0.1:8485',
    token: { ok: true, token: 't' },
    fetchImpl,
  };
  const read = async () => {
    const r = await queueGet(tasksQuery({ limit: LIST_PAGE_MAX }), opts);
    return (r.data as { tasks: Array<{ status: string }> }).tasks[0].status;
  };
  return { opts, gets, read };
}

/** Let queued microtasks (the fetch mock reaching its hold) run. */
const tick = () => new Promise<void>(r => setImmediate(r));

test('concurrent callers share ONE upstream GET /tasks', async () => {
  const api = fakeApi();
  const shared = new SharedRead(api.read);
  // What the UI's parallel /tasks + /headless-runs do to the backend.
  const a = shared.get();
  const b = shared.get();
  await tick();
  assert.equal(api.gets.length, 1);
  api.gets[0].release();
  assert.deepEqual(await Promise.all([a, b]), ['approved', 'approved']);
});

test('nothing is reused once a read settles: the next caller reads again', async () => {
  const api = fakeApi();
  const shared = new SharedRead(api.read);
  const a = shared.get();
  await tick();
  api.gets[0].release();
  await a;
  const b = shared.get();
  await tick();
  assert.equal(api.gets.length, 2, 'a settled read must not be served from memory');
  api.gets[1].release();
  await b;
});

test('a mutation followed by a list read returns the post-mutation state', async () => {
  // The hard constraint: a read begun BEFORE the park is still on the wire when the park
  // returns. A list requested after the park must not join it.
  const api = fakeApi();
  const shared = new SharedRead(api.read);
  const before = shared.get();
  await tick();

  const res = await invalidatingWrite(shared, () =>
    callControlApi('abc12345-0000', 'park', {}, api.opts));
  assert.equal(res.status, 200);

  const after = shared.get();
  await tick();
  assert.equal(api.gets.length, 2, 'the post-mutation read must be a new upstream GET');
  api.gets[0].release();
  api.gets[1].release();
  // The early caller asked before the park returned; an answer from before it is its answer.
  assert.equal(await before, 'approved');
  assert.equal(await after, 'parked');
});

test('a refused or failed write still invalidates', async () => {
  for (const failure of ['refused', 'transport'] as const) {
    const api = fakeApi();
    const shared = new SharedRead(api.read);
    shared.get();
    await tick();
    const write = failure === 'refused'
      ? () => Promise.resolve({ status: 409, data: { ok: false } })
      : () => Promise.reject(new Error('socket hang up'));
    await invalidatingWrite(shared, write).catch(() => undefined);
    shared.get();
    await tick();
    assert.equal(api.gets.length, 2, `${failure}: a lost response does not prove the write did not land`);
    for (const g of api.gets) g.release();
  }
});

test('an older read settling after invalidate() does not detach the newer one', async () => {
  const api = fakeApi();
  const shared = new SharedRead(api.read);
  const old = shared.get();
  await tick();
  shared.invalidate();
  const fresh = shared.get();
  await tick();
  api.gets[0].release();
  await old;
  // The old read's cleanup ran. A caller now must still join `fresh`, not start a third.
  const joiner = shared.get();
  await tick();
  assert.equal(api.gets.length, 2);
  api.gets[1].release();
  assert.equal(await joiner, await fresh);
});

test('a failed read is shared only with callers already waiting, never cached', async () => {
  let calls = 0;
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const shared = new SharedRead(() => {
    calls++;
    const d = deferred<string>();
    pending.push(d);
    return d.promise;
  });
  const a = shared.get();
  const b = shared.get();
  pending[0].reject(new Error('502'));
  await assert.rejects(a, /502/);
  await assert.rejects(b, /502/);
  assert.equal(calls, 1);
  const c = shared.get();
  assert.equal(calls, 2, 'the next caller after a failure retries');
  pending[1].resolve('ok');
  assert.equal(await c, 'ok');
});

// ── Source-level pins on server.ts ──────────────────────────────────────
// server.ts calls listen() at import time, so its routes cannot be imported into a test.
// These pin the wiring the behaviour tests above rely on. The failure they catch is a new
// mutation path added with a direct callControlApi call, which compiles and quietly serves
// a pre-mutation list after it.

const serverSrc = fs.readFileSync(url.fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf-8');
// Comments name these functions too; only code counts.
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('server.ts has exactly one callControlApi call, inside invalidatingWrite', () => {
  const calls = serverCode.match(/callControlApi\(/g) ?? [];
  assert.equal(calls.length, 1, 'every mutation must go through mutate()');
  assert.match(serverCode, /invalidatingWrite\(unfilteredList, \(\) => callControlApi\(/);
});

test('both mutation paths (the action routes and a Start) go through mutate()', () => {
  assert.match(serverCode, /await mutate\(mTaskId, action, body\)/);
  assert.match(serverCode, /await mutate\(taskId, 'status',/);
});

test('the watcher invalidates the shared list on the raw event, before its debounce', () => {
  const watcher = serverCode.slice(serverCode.indexOf('function startWatcher'));
  const inv = watcher.indexOf('unfilteredList.invalidate()');
  const debounce = watcher.indexOf('setTimeout(');
  assert.ok(inv > 0 && inv < debounce);
});

test('only the unfiltered list is shared; filtered and dead-letter reads are their own', () => {
  assert.match(serverCode, /new SharedRead\(\(\) => listTasks\(\)\)/);
  assert.match(serverCode, /Object\.keys\(filters\)\.length === 0\s*\?\s*await unfilteredList\.get\(\)\s*:\s*await listTasks\(filters\)/);
  assert.match(serverCode, /listTasks\(\{ status: 'failed', include_dead_letters: true \}\)/);
});
