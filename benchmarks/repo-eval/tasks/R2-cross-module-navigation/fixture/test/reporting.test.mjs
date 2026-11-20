import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklySummary, laneTotals } from '../reporting/aggregate.mjs';
import { selfCheck, columnCount } from '../reporting/export-csv.mjs';
import { resolveRoute, ROUTE_TABLE } from '../compat/legacy-orders.mjs';

test('aggregate weekly summary is deterministic', () => {
  const summary = weeklySummary();
  assert.equal(summary.regions, 20);
  assert.equal(summary.cells, 140);
  assert.equal(summary.totalLoad, laneTotals().reduce((total, lane) => total + lane.totalLoad, 0));
});

test('exporter self-check and legacy route table stay stable', () => {
  const check = selfCheck();
  assert.equal(check.roundTrip, true);
  assert.equal(columnCount(), 96);
  assert.equal(ROUTE_TABLE.length, 45);
  assert.deepEqual(resolveRoute('GET', '/v1/orders/ord-0001'), { handler: 'getOrder', params: { id: 'ord-0001' } });
});
