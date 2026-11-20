import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'logpulse.js');

test('stats reports line and byte counts', () => {
  const sample = path.join(root, 'samples', 'sample.log');
  const out = execFileSync(process.execPath, [bin, 'stats', sample], { encoding: 'utf8', input: '' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.lines, 4);
  assert.equal(parsed.bytes, statSync(sample).size);
  assert.equal(parsed.file, sample);
});

test('stats exits 64 with a stderr hint for a missing file', () => {
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [bin, 'stats', path.join(root, 'samples', 'nope.log')], { encoding: 'utf8', input: '' });
  } catch (error) {
    code = error.status;
    stderr = error.stderr;
  }
  assert.equal(code, 64);
  assert.ok(stderr.includes('not found'));
});
