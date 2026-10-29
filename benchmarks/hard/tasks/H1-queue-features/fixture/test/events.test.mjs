import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/events.mjs';

test('on/emit/off and once', () => {
  const emitter = new Emitter();
  const seen = [];
  const off = emitter.on('x', value => seen.push(value));
  emitter.emit('x', 1);
  off();
  emitter.emit('x', 2);
  emitter.once('y', value => seen.push(`once:${value}`));
  emitter.emit('y', 3);
  emitter.emit('y', 4);
  assert.deepEqual(seen, [1, 'once:3']);
});

test('rejects non-function listeners', () => {
  const emitter = new Emitter();
  assert.throws(() => emitter.on('x', 'nope'), TypeError);
});
