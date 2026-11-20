# orderbus

Event-driven order pipeline used by the storefront and the warehouse bridge.

## Module map

- `core/bus.mjs` — `EventBus`, sequential async dispatch per event.
- `core/machine.mjs` — `OrderMachine`, the order state machine
  (`created → paid → shipped → delivered`). All state changes go through it.
- `store/orders.mjs` — `OrderStore`, in-memory persistence with a `version`
  stamp per order.
- `plugins/` — bus integrations: `paid-sync` (domain event → machine), `auto-ship`
  (paid → ship via the machine), `audit` and `notify` (pure observers).
- `tools/` — `clock`, `ids` helpers.
- `reporting/`, `compat/` — read-only analytics and legacy shims. Not part of
  the order state path; do not modify them.

## Where things stand

`docs/INCIDENT.md` tracks the open incident on same-tick transitions. The
machine currently reads a snapshot and applies through `store.apply` without
any coordination, so two transitions submitted in the same tick interleave at
the store's persist hook.
