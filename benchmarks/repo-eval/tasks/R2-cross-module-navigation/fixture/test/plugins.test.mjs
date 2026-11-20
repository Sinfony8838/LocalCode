import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/bus.mjs';
import { OrderMachine } from '../core/machine.mjs';
import { OrderStore } from '../store/orders.mjs';
import { registerPaidSync } from '../plugins/paid-sync.mjs';
import { registerAudit } from '../plugins/audit.mjs';
import { registerNotify } from '../plugins/notify.mjs';

test('paid-sync bridges payment:settled into a pay transition', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const bus = new EventBus();
  registerPaidSync({ bus, machine });
  const order = store.create();
  await bus.emit('payment:settled', { id: order.id });
  assert.equal(store.get(order.id).state, 'paid');
});

test('audit records paid and shipped traffic without mutating the store', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const bus = new EventBus();
  const sink = [];
  registerAudit({ bus, sink });
  const order = store.create();
  await machine.transition(order.id, 'pay');
  await bus.emit('order:paid', { id: order.id });
  await bus.emit('order:shipped', { id: order.id });
  assert.deepEqual(sink.map(entry => entry.type), ['order:paid', 'order:shipped']);
  assert.equal(store.get(order.id).state, 'paid');
  assert.equal(store.versionOf(order.id), 1);
});

test('notify forwards shipped traffic to the gateway', async () => {
  const bus = new EventBus();
  const gateway = { sent: [] };
  registerNotify({ bus, gateway });
  await bus.emit('order:shipped', { id: 'ord-0001' });
  assert.deepEqual(gateway.sent, [{ template: 'order-shipped', id: 'ord-0001' }]);
});
