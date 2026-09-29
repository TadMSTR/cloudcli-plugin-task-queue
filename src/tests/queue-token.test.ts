import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadToken, tokenPath } from '../queue-token.ts';

// Real files in a tmpdir, not a mocked fs: the checks under test are the kernel's answers
// to stat(), and a mock can only restate what the test already assumes.

const SECRET_SHAPED = 'synthetic-token-value-0123456789abcdef';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tq-token-'));
}

function write(dir: string, content: string, mode = 0o600): string {
  const f = path.join(dir, 'token');
  fs.writeFileSync(f, content, { mode });
  fs.chmodSync(f, mode); // writeFileSync's mode is masked by umask; set it exactly
  return f;
}

test('the token path is fixed under HOME', () => {
  assert.equal(tokenPath('/home/x'), '/home/x/.config/cloudcli-plugin-task-queue/token');
});

test('a 0600 file with a token loads, trailing newline trimmed', () => {
  const f = write(tmp(), `${SECRET_SHAPED}\n`);
  assert.deepEqual(loadToken(f), { ok: true, token: SECRET_SHAPED });
});

test('a missing file fails closed and names the path', () => {
  const f = path.join(tmp(), 'token');
  const r = loadToken(f);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /is missing/);
  assert.ok(!r.ok && r.error.includes(f));
});

for (const content of ['', '\n', '   \n\t']) {
  test(`an empty file (${JSON.stringify(content)}) fails closed`, () => {
    const r = loadToken(write(tmp(), content));
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error, /is empty/);
  });
}

for (const mode of [0o640, 0o604, 0o644, 0o660, 0o610]) {
  test(`mode ${mode.toString(8)} fails closed without revealing the content`, () => {
    const r = loadToken(write(tmp(), SECRET_SHAPED, mode));
    assert.equal(r.ok, false);
    const error = r.ok ? '' : r.error;
    assert.match(error, /group or others/);
    assert.match(error, /chmod 600/);
    assert.ok(!error.includes(SECRET_SHAPED), 'the error must not carry the token');
  });
}

test('mode 0400 is accepted', () => {
  assert.equal(loadToken(write(tmp(), SECRET_SHAPED, 0o400)).ok, true);
});

test('a directory at the path fails closed', () => {
  const d = tmp();
  const f = path.join(d, 'token');
  fs.mkdirSync(f, { mode: 0o700 });
  const r = loadToken(f);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /not a regular file/);
});
