import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValidJobInput } from '../src/validate.mjs';

const ok = { payload: {}, handler: async () => {}, priority: 0 };

test('accepts valid input', () => {
  assert.doesNotThrow(() => assertValidJobInput(ok));
});

test('rejects missing payload, non-function handler, non-integer priority', () => {
  assert.throws(() => assertValidJobInput({ ...ok, payload: undefined }), TypeError);
  assert.throws(() => assertValidJobInput({ ...ok, handler: 'x' }), TypeError);
  assert.throws(() => assertValidJobInput({ ...ok, priority: 1.5 }), TypeError);
});
