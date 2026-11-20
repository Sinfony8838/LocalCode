import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/bus.mjs';

test('bus dispatches handlers in subscription order', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('ping', () => { seen.push('a'); });
  bus.on('ping', () => { seen.push('b'); });
  const result = await bus.emit('ping', {});
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(result.delivered, 2);
  assert.equal(result.errors.length, 0);
});

test('a throwing handler parks a dead letter but does not stop the chain', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('ping', () => { throw new Error('boom'); });
  bus.on('ping', () => { seen.push('b'); });
  const result = await bus.emit('ping', {});
  assert.deepEqual(seen, ['b']);
  assert.equal(result.errors.length, 1);
  assert.equal(bus.deadLetters().length, 1);
});

test('off removes exactly the requested handler', async () => {
  const bus = new EventBus();
  const seen = [];
  const handler = () => { seen.push('x'); };
  bus.on('ping', handler);
  bus.on('ping', () => { seen.push('y'); });
  assert.equal(bus.off('ping', handler), true);
  assert.equal(bus.off('ping', handler), false);
  await bus.emit('ping', {});
  assert.deepEqual(seen, ['y']);
});
