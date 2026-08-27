import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateUpgrade, allowedOrigins } from '../ws-guard.ts';

const ALLOWED = ['http://cloudcli.example:3001', 'http://localhost:3001', 'http://127.0.0.1:3001'];

// ── The regression this suite exists for ─────────────────────────────────
// v0.4.0 rejected a loopback peer that sent no Origin. That is exactly what
// CloudCLI's own plugin WS proxy sends (the `ws` client omits Origin by
// default), so every connect was 403'd for three weeks. If this test ever
// goes red, the tab has gone dead again.

test('loopback peer with no Origin is accepted — this is CloudCLI\'s own proxy', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const d = evaluateUpgrade(peer, undefined, ALLOWED);
    assert.equal(d.allow, true, `peer ${peer} must be accepted with no Origin`);
  }
});

test('loopback peer with an empty-string Origin is accepted', () => {
  // Node gives undefined for an absent header, but a header present-and-empty
  // must not be treated as a mismatch against a non-empty allowlist.
  assert.equal(evaluateUpgrade('127.0.0.1', '', ALLOWED).allow, true);
});

test('loopback peer with an allowed Origin is accepted', () => {
  for (const origin of ALLOWED) {
    assert.equal(evaluateUpgrade('127.0.0.1', origin, ALLOWED).allow, true, origin);
  }
});

test('loopback peer with a present-but-wrong Origin is refused', () => {
  const d = evaluateUpgrade('127.0.0.1', 'http://evil.example', ALLOWED);
  assert.equal(d.allow, false);
  assert.match(d.reason ?? '', /origin not allowed/);
});

test('a wrong Origin is refused even when it is a prefix of an allowed one', () => {
  // Guards against a startsWith/includes-style relaxation.
  const d = evaluateUpgrade('127.0.0.1', 'http://localhost:3001.evil.example', ALLOWED);
  assert.equal(d.allow, false);
});

test('non-loopback peer is refused outright, even with a good Origin', () => {
  for (const peer of ['192.168.1.50', '10.0.0.1', '::ffff:192.168.1.50', '2001:db8::1']) {
    const d = evaluateUpgrade(peer, 'http://localhost:3001', ALLOWED);
    assert.equal(d.allow, false, `peer ${peer} must be refused`);
    assert.match(d.reason ?? '', /non-loopback peer/);
  }
});

test('non-loopback peer with no Origin is refused', () => {
  // The peer check must run first — otherwise the missing-Origin acceptance
  // above would hand a remote client an open socket.
  const d = evaluateUpgrade('192.168.1.50', undefined, ALLOWED);
  assert.equal(d.allow, false);
  assert.match(d.reason ?? '', /non-loopback peer/);
});

test('an unknown peer address is refused', () => {
  // req.socket.remoteAddress is optional in Node's types; a destroyed socket
  // reports undefined. Fail closed.
  const d = evaluateUpgrade(undefined, undefined, ALLOWED);
  assert.equal(d.allow, false);
  assert.match(d.reason ?? '', /non-loopback peer/);
});

test('allowedOrigins includes CLOUDCLI_ORIGIN when set and drops it when not', () => {
  assert.deepEqual(
    allowedOrigins({ CLOUDCLI_ORIGIN: 'http://forge.example:3001' } as NodeJS.ProcessEnv),
    ['http://forge.example:3001', 'http://localhost:3001', 'http://127.0.0.1:3001'],
  );
  assert.deepEqual(
    allowedOrigins({} as NodeJS.ProcessEnv),
    ['http://localhost:3001', 'http://127.0.0.1:3001'],
  );
  // An empty value must not enter the list — '' would then match a header
  // that is present and empty on a *non*-loopback... and more practically it
  // is a meaningless allowlist entry.
  assert.deepEqual(
    allowedOrigins({ CLOUDCLI_ORIGIN: '' } as NodeJS.ProcessEnv),
    ['http://localhost:3001', 'http://127.0.0.1:3001'],
  );
});
