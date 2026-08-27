import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAllowedPath } from '../path-guard.ts';

// Real files and real symlinks. The property under test is that realpath runs BEFORE
// the prefix compare, and a mocked fs cannot demonstrate that.
function fixture(): { root: string; allowed: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
  const allowed = path.join(root, 'comms');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(allowed, 'ok.log'), 'inside\n');
  fs.writeFileSync(path.join(root, 'secrets', 'forge.env'), 'TOKEN=hunter2\n');
  return { root, allowed, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('resolveAllowedPath accepts a real file inside an allowed prefix', () => {
  const f = fixture();
  try {
    const target = path.join(f.allowed, 'ok.log');
    assert.equal(resolveAllowedPath(target, [f.allowed]), fs.realpathSync(target));
  } finally { f.cleanup(); }
});

test('resolveAllowedPath refuses a symlink that escapes the allowed prefix', () => {
  const f = fixture();
  try {
    // The classic escape: the link itself sits inside the allowed prefix, so a
    // resolve-only check would pass it. Its target does not.
    const link = path.join(f.allowed, 'evil-deadbeef.log');
    fs.symlinkSync(path.join(f.root, 'secrets', 'forge.env'), link);
    assert.equal(resolveAllowedPath(link, [f.allowed]), null);
  } finally { f.cleanup(); }
});

test('resolveAllowedPath refuses traversal out of the prefix', () => {
  const f = fixture();
  try {
    const escape = path.join(f.allowed, '..', 'secrets', 'forge.env');
    assert.equal(resolveAllowedPath(escape, [f.allowed]), null);
  } finally { f.cleanup(); }
});

test('resolveAllowedPath refuses a sibling directory sharing the prefix string', () => {
  const f = fixture();
  try {
    // Without the trailing separator, `/comms-other` startsWith `/comms`.
    const sibling = path.join(f.root, 'comms-other');
    fs.mkdirSync(sibling, { recursive: true });
    const target = path.join(sibling, 'ok.log');
    fs.writeFileSync(target, 'outside\n');
    assert.equal(resolveAllowedPath(target, [f.allowed]), null);
  } finally { f.cleanup(); }
});

test('resolveAllowedPath returns null for a file that does not exist', () => {
  const f = fixture();
  try {
    assert.equal(resolveAllowedPath(path.join(f.allowed, 'nope.log'), [f.allowed]), null);
  } finally { f.cleanup(); }
});

test('resolveAllowedPath accepts a file under any one of several prefixes', () => {
  const f = fixture();
  try {
    const second = path.join(f.root, 'queue');
    fs.mkdirSync(second, { recursive: true });
    const target = path.join(second, 'a.yml');
    fs.writeFileSync(target, 'x\n');
    assert.equal(resolveAllowedPath(target, [f.allowed, second]), fs.realpathSync(target));
  } finally { f.cleanup(); }
});

test('resolveAllowedPath refuses the allowed directory itself', () => {
  const f = fixture();
  try {
    // The prefix compare requires something AFTER the separator, so the bare
    // directory is not a readable member of itself.
    assert.equal(resolveAllowedPath(f.allowed, [f.allowed]), null);
  } finally { f.cleanup(); }
});
