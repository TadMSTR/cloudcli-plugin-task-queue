import assert from 'node:assert/strict';
import test from 'node:test';

import { reconnectDelayMs, RECONNECT_DELAYS_MS } from '../panels/ws-client.ts';

test('reconnect backoff widens 5s -> 10s -> 30s and caps there', () => {
  assert.equal(reconnectDelayMs(0), 5000);
  assert.equal(reconnectDelayMs(1), 10000);
  assert.equal(reconnectDelayMs(2), 30000);
  // Caps rather than growing or wrapping. A fixed 5s retry against a three-week
  // outage produced 2239 identical error lines; an unbounded one would eventually
  // stop retrying at all in practice.
  for (const attempt of [3, 10, 1000]) {
    assert.equal(reconnectDelayMs(attempt), 30000, `attempt ${attempt}`);
  }
});

test('the schedule is monotonically non-decreasing and never zero', () => {
  let prev = 0;
  for (let i = 0; i < 10; i++) {
    const d = reconnectDelayMs(i);
    assert.ok(d > 0, `delay at ${i} must be positive`);
    assert.ok(d >= prev, `delay must not shrink at attempt ${i}`);
    prev = d;
  }
});

test('a negative attempt clamps to the first step rather than indexing out', () => {
  assert.equal(reconnectDelayMs(-1), 5000);
});

test('the first delay matches the documented 5s so behaviour is unchanged for a blip', () => {
  // A transient disconnect must still recover as fast as it did before the backoff
  // was added — the backoff is for persistent outages only.
  assert.equal(RECONNECT_DELAYS_MS[0], 5000);
});
