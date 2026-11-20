// orderbus event bus — sequential async dispatch, one queue per event name.

export class EventBus {
  #handlers = new Map();
  #deadLetters = [];

  /** Subscribe to an event. Handlers run in subscription order. */
  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const list = this.#handlers.get(event);
    if (!list) return false;
    const index = list.indexOf(handler);
    if (index === -1) return false;
    list.splice(index, 1);
    return true;
  }

  listenerCount(event) {
    return this.#handlers.get(event)?.length ?? 0;
  }

  /**
   * Dispatch an event: handlers run sequentially; an async handler is awaited
   * before the next one starts. A throwing handler does not stop the chain —
   * the error is parked in the dead-letter list.
   */
  async emit(event, payload) {
    const list = [...(this.#handlers.get(event) ?? [])];
    const errors = [];
    for (const handler of list) {
      try {
        await handler(payload, { event });
      } catch (error) {
        errors.push(error);
        this.#deadLetters.push({ event, error, at: Date.now() });
      }
    }
    return { event, delivered: list.length, errors };
  }

  deadLetters() {
    return [...this.#deadLetters];
  }
}
