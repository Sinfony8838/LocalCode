// orderbus state machine — the only component allowed to change order state.
//
// Lifecycle: created → paid → shipped → delivered. Same-tick transitions are
// serialized per order (docs/INCIDENT.md): each transition reads the store
// only after every earlier transition for the same order has fully applied.

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
  #chains = new Map();

  allowedEvents(orderId) {
    const snapshot = this.#store.get(orderId);
    return snapshot ? Object.keys(TRANSITIONS[snapshot.state] ?? {}) : [];
  }

  /**
   * Serialize per order, then validate against the fresh snapshot and apply
   * with an expected-version check. Expected outcomes come back as result
   * objects; only unexpected store failures reject.
   */
  transition(orderId, event, payload = {}) {
    const last = this.#chains.get(orderId) ?? Promise.resolve();
    const run = last.then(() => this.#runTransition(orderId, event, payload));
    this.#chains.set(orderId, run.then(() => undefined, () => undefined));
    return run;
  }

  async #runTransition(orderId, event, payload) {
    const snapshot = this.#store.get(orderId);
    if (!snapshot) return { ok: false, reason: 'unknown-order' };
    const next = TRANSITIONS[snapshot.state]?.[event];
    if (!next) return { ok: false, reason: 'invalid-transition' };
    try {
      const result = await this.#store.apply(orderId, order => {
        order.state = next;
        order.history.push({ event, at: this.#clock.now(), payload });
        this.#metrics?.count('transition');
      }, snapshot.version);
      return { ok: true, state: result.state, version: result.version };
    } catch (error) {
      if (error?.code === 'STALE_VERSION') return { ok: false, reason: 'stale' };
      throw error;
    }
  }
}
