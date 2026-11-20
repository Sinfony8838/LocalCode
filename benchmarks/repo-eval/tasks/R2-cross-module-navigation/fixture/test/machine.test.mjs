import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderMachine } from '../core/machine.mjs';
import { OrderStore } from '../store/orders.mjs';

function makeMetrics() {
  const counts = {};
  return { counts, count: name => { counts[name] = (counts[name] ?? 0) + 1; }, snapshot: () => ({ ...counts }) };
}

test('happy path pays an order once', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const order = store.create();
  const result = await machine.transition(order.id, 'pay');
  assert.equal(result.ok, true);
  assert.equal(store.get(order.id).state, 'paid');
});

test('unknown order reports unknown-order', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const result = await machine.transition('missing', 'pay');
  assert.deepEqual(result, { ok: false, reason: 'unknown-order' });
});

// INCIDENT repro 1: duplicate webhooks in the same tick must apply once.
test('duplicate pay in the same tick applies exactly once', async () => {
  const store = new OrderStore();
  const metrics = makeMetrics();
  const machine = new OrderMachine({ store, metrics });
  const order = store.create();
  const [r1, r2] = await Promise.all([
    machine.transition(order.id, 'pay'),
    machine.transition(order.id, 'pay'),
  ]);
  const okResults = [r1, r2].filter(result => result.ok);
  assert.equal(okResults.length, 1, `expected exactly one ok result, got ${JSON.stringify([r1, r2])}`);
  assert.equal(store.versionOf(order.id), 1);
  assert.equal(metrics.snapshot().transition, 1);
  assert.equal(store.get(order.id).history.length, 1);
});

// INCIDENT repro 2: pay+ship in the same tick must both land, in order.
test('pay then ship in the same tick applies both in order', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const order = store.create();
  const [r1, r2] = await Promise.all([
    machine.transition(order.id, 'pay'),
    machine.transition(order.id, 'ship'),
  ]);
  assert.equal(r1.ok, true, `pay failed: ${JSON.stringify(r1)}`);
  assert.equal(r2.ok, true, `ship failed: ${JSON.stringify(r2)}`);
  assert.equal(store.get(order.id).state, 'shipped');
  assert.equal(store.versionOf(order.id), 2);
});
