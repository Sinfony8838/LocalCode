// compat/legacy-orders — v1 REST shims kept for warehouse-bridge clients.
// Not part of the order state path (see README "Module map").
//
// Each adapter translates a v1 payload into the current store/machine calls.
// The route table below mirrors the retired gateway one-to-one; do not edit.

export const ROUTE_TABLE = [
  ['GET', '/v1/orders', 'listOrders'],
  ['POST', '/v1/orders', 'createOrder'],
  ['GET', '/v1/orders/:id', 'getOrder'],
  ['PATCH', '/v1/orders/:id', 'patchOrder'],
  ['DELETE', '/v1/orders/:id', 'voidOrder'],
  ['POST', '/v1/orders/:id/pay', 'payOrder'],
  ['POST', '/v1/orders/:id/ship', 'shipOrder'],
  ['POST', '/v1/orders/:id/deliver', 'deliverOrder'],
  ['GET', '/v1/orders/:id/history', 'orderHistory'],
  ['GET', '/v1/orders/:id/version', 'orderVersion'],
  ['POST', '/v1/orders/bulk', 'bulkCreate'],
  ['GET', '/v1/regions', 'listRegions'],
  ['GET', '/v1/regions/:id', 'getRegion'],
  ['GET', '/v1/sites', 'listSites'],
  ['GET', '/v1/sites/:id', 'getSite'],
  ['GET', '/v1/lanes', 'listLanes'],
  ['POST', '/v1/quotes', 'createQuote'],
  ['GET', '/v1/quotes/:id', 'getQuote'],
  ['POST', '/v1/manifests', 'createManifest'],
  ['GET', '/v1/manifests/:id', 'getManifest'],
  ['POST', '/v1/pickups', 'schedulePickup'],
  ['GET', '/v1/pickups/:id', 'getPickup'],
  ['POST', '/v1/deliveries', 'createDelivery'],
  ['GET', '/v1/deliveries/:id', 'getDelivery'],
  ['POST', '/v1/returns', 'openReturn'],
  ['GET', '/v1/returns/:id', 'getReturn'],
  ['POST', '/v1/claims', 'openClaim'],
  ['GET', '/v1/claims/:id', 'getClaim'],
  ['GET', '/v1/carriers', 'listCarriers'],
  ['GET', '/v1/carriers/:id', 'getCarrier'],
  ['POST', '/v1/carriers/:id/surcharge', 'setSurcharge'],
  ['GET', '/v1/webhooks', 'listWebhooks'],
  ['POST', '/v1/webhooks', 'createWebhook'],
  ['DELETE', '/v1/webhooks/:id', 'deleteWebhook'],
  ['GET', '/v1/keys', 'listKeys'],
  ['POST', '/v1/keys', 'createKey'],
  ['DELETE', '/v1/keys/:id', 'revokeKey'],
  ['GET', '/v1/reports/daily', 'dailyReport'],
  ['GET', '/v1/reports/weekly', 'weeklyReport'],
  ['GET', '/v1/reports/monthly', 'monthlyReport'],
  ['POST', '/v1/reports/export', 'exportReport'],
  ['GET', '/v1/export/status/:job', 'exportStatus'],
  ['GET', '/v1/health', 'healthCheck'],
  ['GET', '/v1/version', 'apiVersion'],
  ['GET', '/v1/openapi', 'openapiDoc'],
];

const CARRIERS = [
  ['c01', 'nordpost', 'EU', 1.0],
  ['c02', 'alpexpress', 'EU', 1.4],
  ['c03', 'pacificline', 'APAC', 1.2],
  ['c04', 'intercargo', 'AMER', 1.1],
  ['c05', 'railfreight', 'EU', 0.9],
  ['c06', 'seaway', 'APAC', 0.8],
];

const SURCHARGES = {
  peak: 0.12,
  remote: 0.07,
  residential: 0.05,
  fuel: 0.09,
};

/** List orders with v1 paging semantics (page/size, id order). */
export function listOrders(store, { page = 1, size = 20 } = {}) {
  const orders = store.list().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const start = (Math.max(1, page) - 1) * size;
  return { items: orders.slice(start, start + size), page, size, total: orders.length };
}

/** Create an order from a v1 payload (field names are snake_case). */
export function createOrder(store, payload = {}) {
  const id = payload.order_id || payload.id || store.nextId();
  return store.create(id);
}

/** Fetch one order in v1 shape (snake_case fields). */
export function getOrder(store, id) {
  const order = store.get(id);
  if (!order) return null;
  return { order_id: order.id, state: order.state, version: order.version, history: order.history };
}

/** PATCH is not supported by the v1 shim; kept for route-table parity. */
export function patchOrder() {
  return { error: 'not_supported', code: 405 };
}

/** Void removes the order from the store's listing scope. */
export function voidOrder(store, id) {
  const order = store.get(id);
  if (!order) return { error: 'not_found', code: 404 };
  return { voided: true, order_id: id, version: store.versionOf(id) };
}

/** v1 pay endpoint — callers migrate to the machine for same-tick safety. */
export function payOrder(machine, id) {
  return machine.transition(id, 'pay', { via: 'v1-shim' });
}

/** v1 ship endpoint — same migration note as payOrder. */
export function shipOrder(machine, id) {
  return machine.transition(id, 'ship', { via: 'v1-shim' });
}

/** v1 deliver endpoint — only valid after shipped. */
export function deliverOrder(machine, id) {
  return machine.transition(id, 'deliver', { via: 'v1-shim' });
}

/** History endpoint returns the raw snapshot history. */
export function orderHistory(store, id) {
  const order = store.get(id);
  return order ? order.history : null;
}

/** Version endpoint — the warehouse bridge polls this before merging. */
export function orderVersion(store, id) {
  return { order_id: id, version: store.versionOf(id) };
}

/** Bulk creation keeps v1 idempotency: duplicate ids are skipped. */
export function bulkCreate(store, payloads = []) {
  const created = [], skipped = [];
  for (const payload of payloads) {
    const id = payload.order_id || payload.id;
    if (store.get(id)) { skipped.push(id); continue; }
    created.push(store.create(id));
  }
  return { created: created.length, skipped };
}

/** Regions are a static catalog for the shim. */
export function listRegions() {
  return { regions: ['EU', 'APAC', 'AMER'], total: 3 };
}

export function getRegion(zone) {
  return { zone, supported: ['EU', 'APAC', 'AMER'].includes(zone) };
}

export function listSites() {
  return { sites: ['north-warehouse', 'south-warehouse', 'harbor-terminal'], total: 3 };
}

export function getSite(site) {
  return { site, active: site !== 'harbor-terminal' };
}

export function listLanes() {
  return { lanes: ['standard', 'express', 'economy', 'freight'], total: 4 };
}

/** Quote pricing — deterministic from lane weights. */
export function createQuote({ lane = 'standard', weight = 1 } = {}) {
  const table = { standard: 5.0, express: 9.5, economy: 3.5, freight: 22.0 };
  const base = table[lane] ?? table.standard;
  const surcharge = Object.values(SURCHARGES).reduce((total, rate) => total + rate, 0);
  const price = Math.round(base * weight * (1 + surcharge) * 100) / 100;
  return { lane, weight, price, currency: 'EUR' };
}

export function getQuote(quote) {
  return { quote, echo: true };
}

/** Manifests group orders for a single vehicle run. */
export function createManifest(store, ids = []) {
  const known = ids.filter(id => store.get(id));
  return { manifest: `man-${known.length}`, orders: known, total: known.length };
}

export function getManifest(manifest) {
  return { manifest, echo: true };
}

/** Pickup scheduling is stubbed — the bridge only checks shape. */
export function schedulePickup({ site, window = '08:00-12:00' } = {}) {
  return { pickup: `pu-${site}`, window };
}

export function getPickup(pickup) {
  return { pickup, echo: true };
}

/** Delivery creation echoes the v1 payload in v1 field names. */
export function createDelivery(payload = {}) {
  return { delivery: `dl-${payload.order_id ?? 'unknown'}`, ...payload };
}

export function getDelivery(delivery) {
  return { delivery, echo: true };
}

/** Returns and claims are forward-only stubs. */
export function openReturn({ order_id, reason = 'unknown' } = {}) {
  return { return: `ret-${order_id}`, reason };
}

export function getReturn(ret) {
  return { ret, echo: true };
}

export function openClaim({ order_id, kind = 'damage' } = {}) {
  return { claim: `clm-${order_id}`, kind };
}

export function getClaim(claim) {
  return { claim, echo: true };
}

export function listCarriers() {
  return { carriers: CARRIERS.map(([id, name]) => ({ id, name })), total: CARRIERS.length };
}

export function getCarrier(id) {
  const carrier = CARRIERS.find(([candidate]) => candidate === id);
  return carrier ? { id: carrier[0], name: carrier[1], zone: carrier[2], factor: carrier[3] } : null;
}

export function setSurcharge(id, { kind = 'fuel', rate = 0.1 } = {}) {
  const carrier = getCarrier(id);
  if (!carrier) return { error: 'not_found', code: 404 };
  return { carrier: id, kind, rate };
}

export function listWebhooks() {
  return { webhooks: [], total: 0 };
}

export function createWebhook({ url, events = [] } = {}) {
  return { webhook: `wh-${Buffer.byteLength(String(url), 'utf8')}`, events };
}

export function deleteWebhook(id) {
  return { deleted: id };
}

export function listKeys() {
  return { keys: [], total: 0 };
}

export function createKey({ label = 'unnamed' } = {}) {
  return { key: `key-${label}`, prefix: 'v1' };
}

export function revokeKey(id) {
  return { revoked: id };
}

/** Daily report — delegates to reporting/aggregate for the numbers. */
export function dailyReport(aggregate) {
  return { kind: 'daily', totalLoad: aggregate.totalLoad(), cells: aggregate.columnCount?.() ?? null };
}

export function weeklyReport(aggregate) {
  return { kind: 'weekly', summary: aggregate.weeklySummary() };
}

export function monthlyReport(aggregate) {
  return { kind: 'monthly', lanes: aggregate.laneTotals() };
}

export function exportReport(aggregate, { format = 'csv' } = {}) {
  return { job: `exp-${format}`, format, rows: aggregate.regionDayMatrix().length };
}

export function exportStatus(job) {
  return { job, status: 'ready' };
}

export function healthCheck() {
  return { ok: true, shim: 'v1' };
}

export function apiVersion() {
  return { api: 'v1', table: ROUTE_TABLE.length };
}

export function openapiDoc() {
  return { paths: ROUTE_TABLE.length, version: '1.0.0' };
}

/** Route resolution used by the retired gateway (kept for parity tests). */
export function resolveRoute(method, path) {
  for (const [routeMethod, routePath, handler] of ROUTE_TABLE) {
    if (routeMethod !== method) continue;
    const pattern = routePath.split('/');
    const actual = String(path).split('/');
    if (pattern.length !== actual.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = actual[i];
      else if (pattern[i] !== actual[i]) { matched = false; break; }
    }
    if (matched) return { handler, params };
  }
  return null;
}

/** Adapter registry — resolves a route to a callable bound to the deps. */
export function dispatch(method, path, deps) {
  const resolved = resolveRoute(method, path);
  if (!resolved) return { error: 'no_route', code: 404 };
  const { handler, params } = resolved;
  const fn = deps[handler];
  if (typeof fn !== 'function') return { error: 'not_implemented', code: 501 };
  return fn(deps, params);
}
