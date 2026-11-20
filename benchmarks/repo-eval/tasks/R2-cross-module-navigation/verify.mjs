import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run } from '../../../lib/common.mjs';

// Acceptance suite for docs/INCIDENT.md. Drives the store, machine and
// auto-ship plugin through their public entries; no real time passes.
// Hidden from the workspace.
const HIDDEN_CASES = `
import { OrderStore } from STORE;
import { OrderMachine } from MACHINE;
import { EventBus } from BUS;
import { registerAutoShip } from AUTOSHIP;
import { weeklySummary, laneTotals } from AGGREGATE;
import { columnCount } from EXPORTCSV;
import { resolveRoute } from LEGACY;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const out = {};
const t_ = (name, fn) => { try { out[name] = Promise.resolve(fn()).then(v => v === true).catch(e => 'threw: ' + ((e && e.message) || e)); } catch (e) { out[name] = 'threw: ' + ((e && e.message) || e); } };
const fail = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const metrics = () => { const c = {}; return { count: n => { c[n] = (c[n] ?? 0) + 1; }, snapshot: () => ({ ...c }) }; };

t_('storeVersionedApply', async () => {
  const store = new OrderStore();
  const order = store.create();
  await store.apply(order.id, o => { o.state = 'paid'; }, 0);
  const stale = await fail(() => store.apply(order.id, o => { o.state = 'shipped'; }, 999));
  if (!stale || stale.code !== 'STALE_VERSION') return 'expected STALE_VERSION, got ' + stale;
  const after = store.get(order.id);
  if (after.state !== 'paid' || store.versionOf(order.id) !== 1) return 'stale apply mutated the order';
  await store.apply(order.id, o => { o.state = 'shipped'; }, 1);
  return store.versionOf(order.id) === 2 && store.get(order.id).state === 'shipped';
});

t_('storeSnapshotIsolation', () => {
  const store = new OrderStore();
  const order = store.create();
  const snapshot = store.get(order.id);
  snapshot.state = 'shipped';
  snapshot.history.push({ event: 'forged' });
  const fresh = store.get(order.id);
  return fresh.state === 'created' && fresh.history.length === 0 && store.versionOf(order.id) === 0;
});

t_('machineSerialSameTick', async () => {
  const store = new OrderStore();
  const m = metrics();
  const machine = new OrderMachine({ store, metrics: m });
  const order = store.create();
  const [r1, r2] = await Promise.all([
    machine.transition(order.id, 'pay'),
    machine.transition(order.id, 'pay'),
  ]);
  if (r1.ok + r2.ok !== 1) return 'duplicate pay: ' + eq([r1, r2], [r1, r2]);
  if (store.versionOf(order.id) !== 1 || m.snapshot().transition !== 1) return 'duplicate pay applied twice';
  const [s1, s2] = await Promise.all([
    machine.transition(order.id, 'pay'),
    machine.transition(order.id, 'ship'),
  ]);
  if (!s2.ok) return 'ship lost in same tick: ' + JSON.stringify(s2);
  return store.get(order.id).state === 'shipped' && store.versionOf(order.id) === 2 && s1.ok === false;
});

t_('versionMonotonicUnderLoad', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const order = store.create();
  await Promise.all([
    machine.transition(order.id, 'pay'),
    machine.transition(order.id, 'ship'),
    machine.transition(order.id, 'deliver'),
    machine.transition(order.id, 'pay'),
  ]);
  return store.get(order.id).state === 'delivered' && store.versionOf(order.id) === 3;
});

t_('autoShipChain', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const bus = new EventBus();
  registerAutoShip({ bus, machine, store });
  const order = store.create();
  await machine.transition(order.id, 'pay');
  const broadcasts = [];
  bus.on('order:shipped', payload => broadcasts.push(payload));
  await bus.emit('order:paid', { id: order.id });
  return store.get(order.id).state === 'shipped' && store.versionOf(order.id) === 2
    && broadcasts.length === 1 && broadcasts[0].id === order.id;
});

t_('autoShipDeclinesWhenNotOk', async () => {
  const store = new OrderStore();
  const machine = new OrderMachine({ store });
  const bus = new EventBus();
  registerAutoShip({ bus, machine, store });
  const order = store.create();
  await machine.transition(order.id, 'pay');
  await bus.emit('order:paid', { id: order.id });          // ships the order
  const broadcasts = [];
  bus.on('order:shipped', payload => broadcasts.push(payload));
  await bus.emit('order:paid', { id: order.id });          // already shipped: must stay silent
  return store.get(order.id).state === 'shipped' && store.versionOf(order.id) === 2 && broadcasts.length === 0;
});

t_('unrelatedModulesRegressed', () => {
  const summary = weeklySummary();
  if (summary.totalLoad !== laneTotals().reduce((total, lane) => total + lane.totalLoad, 0)) return 'weeklySummary inconsistent';
  if (columnCount() !== 96) return 'export layout changed';
  const route = resolveRoute('GET', '/v1/orders/ord-0001');
  return !!route && route.handler === 'getOrder' && route.params.id === 'ord-0001';
});

await Promise.all(Object.entries(out).map(async ([name, value]) => { out[name] = await value; }));
console.log(JSON.stringify(out));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];

  const visible = nodeTest(dir, ['test/bus.test.mjs', 'test/machine.test.mjs', 'test/plugins.test.mjs', 'test/reporting.test.mjs'], 90_000);
  checks.push(check('visible tests (12)', 20, Math.round((visible.pass / 12) * 20), `pass ${visible.pass}/12, fail ${visible.fail}${visible.timedOut ? ', timed out' : ''}: ${(visible.stderr || visible.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES
    .replace('STORE', JSON.stringify(pathToFileURL(path.join(dir, 'store', 'orders.mjs')).href))
    .replace('MACHINE', JSON.stringify(pathToFileURL(path.join(dir, 'core', 'machine.mjs')).href))
    .replace('BUS', JSON.stringify(pathToFileURL(path.join(dir, 'core', 'bus.mjs')).href))
    .replace('AUTOSHIP', JSON.stringify(pathToFileURL(path.join(dir, 'plugins', 'auto-ship.mjs')).href))
    .replace('AGGREGATE', JSON.stringify(pathToFileURL(path.join(dir, 'reporting', 'aggregate.mjs')).href))
    .replace('EXPORTCSV', JSON.stringify(pathToFileURL(path.join(dir, 'reporting', 'export-csv.mjs')).href))
    .replace('LEGACY', JSON.stringify(pathToFileURL(path.join(dir, 'compat', 'legacy-orders.mjs')).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 60_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'acceptance suite produced no output').slice(0, 400) }; }
  const detail = key => (typeof r[key] === 'string' ? r[key] : '');

  checks.push(check('hidden: store apply validates expectedVersion and increments version', 14, r.storeVersionedApply === true, detail('storeVersionedApply')));
  checks.push(check('hidden: store.get returns an isolated snapshot', 6, r.storeSnapshotIsolation === true, detail('storeSnapshotIsolation')));
  checks.push(check('hidden: same-tick transitions serialize per order', 20, r.machineSerialSameTick === true, detail('machineSerialSameTick')));
  checks.push(check('hidden: version advances once per applied transition under load', 6, r.versionMonotonicUnderLoad === true, detail('versionMonotonicUnderLoad')));
  checks.push(check('hidden: auto-ship drives the machine and broadcasts only on ok', 14, r.autoShipChain === true, detail('autoShipChain')));
  checks.push(check('hidden: auto-ship stays silent when the transition fails', 6, r.autoShipDeclinesWhenNotOk === true, detail('autoShipDeclinesWhenNotOk')));
  checks.push(check('hidden: reporting/compat modules unchanged (regression gate)', 4, r.unrelatedModulesRegressed === true, detail('unrelatedModulesRegressed')));
  return { checks };
}
