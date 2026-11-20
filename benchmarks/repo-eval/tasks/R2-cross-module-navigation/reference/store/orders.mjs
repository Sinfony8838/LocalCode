// orderbus order store — in-memory persistence with a per-order version stamp.
//
// The `version` field exists for downstream race detection (warehouse bridge
// reads it to reject out-of-date merges). See docs/INCIDENT.md.

export class OrderStore {
  #orders = new Map();
  #idSeed = 1;

  nextId() {
    return `ord-${String(this.#idSeed++).padStart(4, '0')}`;
  }

  create(id = this.nextId()) {
    if (this.#orders.has(id)) throw new Error(`order ${id} already exists`);
    const order = { id, state: 'created', version: 0, history: [] };
    this.#orders.set(id, order);
    return this.get(id);
  }

  /** Snapshot read. Callers must not be able to mutate stored state through it. */
  get(orderId) {
    const order = this.#orders.get(orderId);
    return order ? { ...order, history: [...order.history] } : null;
  }

  versionOf(orderId) {
    return this.#orders.get(orderId)?.version ?? null;
  }

  /**
   * Apply a mutation through the persist hook with optimistic concurrency:
   * when `expectedVersion` is provided it must match the current version or
   * the mutator is refused with a STALE_VERSION error and the order stays
   * untouched. Every applied mutation increments the version by exactly one.
   * The hook stays async so callers that do not await it still interleave —
   * the version check is what makes that safe.
   */
  async apply(orderId, mutator, expectedVersion) {
    const order = this.#orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    await Promise.resolve(); // persist hook (durable write simulation)
    if (Number.isInteger(expectedVersion) && order.version !== expectedVersion) {
      const error = new Error(`stale version for ${orderId}: expected ${expectedVersion}, current ${order.version}`);
      error.code = 'STALE_VERSION';
      throw error;
    }
    mutator(order);
    order.version += 1;
    return { ...order, history: [...order.history] };
  }

  list() {
    return [...this.#orders.values()].map(order => ({ ...order, history: [...order.history] }));
  }

  count() {
    return this.#orders.size;
  }
}
