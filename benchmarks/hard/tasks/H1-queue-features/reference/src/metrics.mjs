// Named counters with a stable snapshot shape.
export class Metrics {
  #counters = new Map();

  inc(name, by = 1) {
    if (!Number.isInteger(by) || by < 1) throw new TypeError('counter increment must be a positive integer');
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  snapshot() {
    return {
      enqueued: this.#counters.get('enqueued') ?? 0,
      started: this.#counters.get('started') ?? 0,
      succeeded: this.#counters.get('succeeded') ?? 0,
      failed: this.#counters.get('failed') ?? 0,
      cancelled: this.#counters.get('cancelled') ?? 0,
      retries: this.#counters.get('retries') ?? 0,
      dead: this.#counters.get('dead') ?? 0,
    };
  }
}
