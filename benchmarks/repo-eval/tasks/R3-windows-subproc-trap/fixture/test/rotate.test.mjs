import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'logpulse.js');

function makeLogs(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logpulse-rotate-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `log ${name}\n`);
  return dir;
}

test('rotate keeps the newest n logs and deletes the rest', () => {
  const dir = makeLogs(['a.log', 'b.log', 'c.log', 'd.log', 'e.log']);
  const out = execFileSync(process.execPath, [bin, 'rotate', '--dir', dir, '--keep', '3'], { encoding: 'utf8', input: '' });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.deleted, ['a.log', 'b.log']);
  assert.deepEqual(parsed.kept, ['c.log', 'd.log', 'e.log']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['c.log', 'd.log', 'e.log']);
});

test('rotate with keep >= count deletes nothing', () => {
  const dir = makeLogs(['a.log', 'b.log']);
  const out = execFileSync(process.execPath, [bin, 'rotate', '--dir', dir, '--keep', '5'], { encoding: 'utf8', input: '' });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.deleted, []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.log', 'b.log']);
});
