# INCIDENT: same-tick transitions stomp on each other

Severity: high · Component: order pipeline · Reported by: warehouse bridge on-call

## Symptom

Duplicate payment webhooks and same-tick pipeline events cause:

1. **Double-applies** — two concurrent `pay` transitions both succeed, the
   transition metric counts twice, and the order history records the same
   event twice.
2. **Lost transitions** — `pay` and `ship` submitted in the same tick: `ship`
   is rejected as invalid because it read the pre-`pay` snapshot, so the order
   stays `paid` even though both events arrived.
3. **Version stamp never advances** — `store.versionOf(id)` stays `0` for the
   whole life of an order, so downstream consumers cannot detect races.

## Required semantics (acceptance criteria)

These rules are the single source of truth for the fix. The hidden acceptance
suite checks them verbatim.

### `store/orders.mjs` — `apply(orderId, mutator, expectedVersion?)`

- When `expectedVersion` is provided and the order's current version differs,
  throw an error with `code === 'STALE_VERSION'` **before** running the
  mutator; the order must remain untouched.
- When the mutator runs, increment the order's `version` by exactly `1`.
- `get(orderId)` must return a **snapshot copy**; mutating the returned object
  must never affect stored state.
- `versionOf(orderId)` reflects the incremented counter.

### `core/machine.mjs` — `transition(orderId, event, payload?)`

- Transitions submitted for the same order — even within one event-loop tick —
  must be **serialized in submission order**: the second transition reads the
  store only after the first one has fully applied.
- With serialization, `pay` + `ship` submitted in the same tick both succeed:
  final state `shipped`, version `2`.
- Duplicate `pay` submitted in the same tick: exactly one succeeds; the other
  returns `{ ok: false }` (reason `invalid-transition` once the first has
  applied); the transition metric counts exactly `1`.
- If the store reports a version conflict (`STALE_VERSION`), return
  `{ ok: false, reason: 'stale' }` instead of throwing.
- Unknown order → `{ ok: false, reason: 'unknown-order' }`; transition not
  allowed from the current state → `{ ok: false, reason: 'invalid-transition' }`.

### `plugins/auto-ship.mjs`

- Must drive the machine — call and `await` `machine.transition(orderId, 'ship')`
  when the `order:paid` event arrives.
- Broadcast `order:shipped` on the bus **only if** the transition result is
  `ok`. No broadcast on failure, and the store must remain unchanged.
- The plugin must no longer read the store directly to decide whether to ship.

### Non-goals

- `reporting/` and `compat/` are read-only analytics and legacy shims. They
  are NOT part of the order path — any change there fails the regression gate.
- No new dependencies; no changes to `package.json`.
