// orderbus state machine — the only component allowed to change order state.
//
// Lifecycle: created → paid → shipped → delivered (see docs/INCIDENT.md for
// the open same-tick race).

const TRANSITIONS = {
  created: { pay: 'paid' },
  paid: { ship: 'shipped' },
  shipped: { deliver: 'delivered' },
};

export class OrderMachine {
  // Wireable collaborators, matching the constructor the plugins use.
  constructor({ store, clock, metrics } = {}) {
    if (!store) throw new TypeError('OrderMachine requires a store');
    this.#store = store;
    this.#clock = clock ?? { now: () => Date.now() };
    this.#metrics = metrics ?? null;
  }

  #store;
  #clock;
  #metrics;

  allowedEvents(orderId) {
    const snapshot = this.#store.get(orderId);
    return snapshot ? Object.keys(TRANSITIONS[snapshot.state] ?? {}) : [];
  }

  /**
   * Validate against the current snapshot, then apply through the store.
   * Returns a result object instead of throwing for expected outcomes.
   */
  async transition(orderId, event, payload = {}) {
    const snapshot = this.#store.get(orderId);
    if (!snapshot) return { ok: false, reason: 'unknown-order' };
    const next = TRANSITIONS[snapshot.state]?.[event];
    if (!next) return { ok: false, reason: 'invalid-transition' };
    try {
      const result = await this.#store.apply(orderId, order => {
        order.state = next;
        order.history.push({ event, at: this.#clock.now(), payload });
        this.#metrics?.count('transition');
      });
      return { ok: true, state: result.state, version: result.version };
    } catch (error) {
      if (error?.code === 'STALE_VERSION') return { ok: false, reason: 'stale' };
      throw error;
    }
  }
}
