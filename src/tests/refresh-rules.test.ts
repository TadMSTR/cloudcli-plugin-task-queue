import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import url from 'node:url';

import { Latest, coveredByRefresh, WATCH_DEBOUNCE_MS } from '../refresh-rules.ts';

test('a stale out-of-order response does not overwrite newer state', async () => {
  // The shape of index.ts's loadTasks: begin, await the reads, apply only if still latest.
  const loads = new Latest();
  const state = { tasks: [] as string[] };
  let releaseOld!: (v: string[]) => void;
  let releaseNew!: (v: string[]) => void;

  const load = async (read: Promise<string[]>) => {
    const isLatest = loads.begin();
    const tasks = await read;
    if (!isLatest()) return;
    state.tasks = tasks;
  };

  const older = load(new Promise(r => { releaseOld = r; }));
  const newer = load(new Promise(r => { releaseNew = r; }));
  // The newer refresh answers first, then the older one arrives late.
  releaseNew(['parked']);
  await newer;
  releaseOld(['approved']);
  await older;
  assert.deepEqual(state.tasks, ['parked']);
});

test('in order, each load applies', async () => {
  const loads = new Latest();
  const first = loads.begin();
  assert.equal(first(), true);
  const second = loads.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
});

test("the tab's own action: a refresh started after the write covers the watcher event", () => {
  // t=0 park written; t=40 mutation returns, refresh starts; the watcher broadcasts at
  // t=1000 (last change + debounce) and the WS event lands at t=1010.
  assert.equal(coveredByRefresh(40, 1010), true);
});

test('a change made elsewhere, with no refresh since, is not covered', () => {
  // Last refresh 30 s ago; an agent writes at t=30000; the event lands at t=31005.
  assert.equal(coveredByRefresh(0, 31005), false);
});

test('a write that lands DURING a refresh is not covered by it', () => {
  // Refresh started at t=100; an agent wrote at t=150, after the refresh read; the event
  // lands at t=1150. The refresh may predate the write, so it must not suppress this.
  assert.equal(coveredByRefresh(100, 1150), false);
});

test('late delivery only errs toward refreshing', () => {
  // Same own-action case as above, but the event is 2 s late. The estimated change time
  // moves later, past the refresh start, so the rule refreshes rather than skipping.
  assert.equal(coveredByRefresh(40, 3010), false);
});

test('the UI rule and the server watcher use the same debounce constant', () => {
  const read = (rel: string) =>
    fs.readFileSync(url.fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
  assert.equal(WATCH_DEBOUNCE_MS, 1000);
  assert.match(read('../server.ts'), /\}, WATCH_DEBOUNCE_MS\);/);
  const index = read('../index.ts');
  assert.match(index, /if \(coveredByRefresh\(lastGoodLoadStartedAt, eventAt\)\) return;/);
  assert.match(index, /debouncedRefresh\(performance\.now\(\)\)/);
  // Only a refresh whose list read succeeded counts as covering an event.
  assert.match(index, /state\.error = null;\s*lastGoodLoadStartedAt = Math\.max\(lastGoodLoadStartedAt, startedAt\);/);
});
