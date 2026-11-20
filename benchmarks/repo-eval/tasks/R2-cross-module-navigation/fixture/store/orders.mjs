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
   * Apply a mutation through the persist hook. The hook is async so callers
   * that do not await it can interleave — this mirrors the durable write we
   * run in production.
   */
  async apply(orderId, mutator) {
    const order = this.#orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    await Promise.resolve(); // persist hook (durable write simulation)
    mutator(order);
    return { ...order, history: [...order.history] };
  }

  list() {
    return [...this.#orders.values()].map(order => ({ ...order, history: [...order.history] }));
  }

  count() {
    return this.#orders.size;
  }
}
