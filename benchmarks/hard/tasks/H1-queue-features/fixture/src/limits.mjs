// Counting semaphore used to cap queue concurrency.
export class Semaphore {
  #permits;
  #waiters = [];

  constructor(permits) {
    if (!Number.isInteger(permits) || permits < 1) throw new TypeError('permits must be an integer >= 1');
    this.#permits = permits;
  }
  async acquire() {
    if (this.#permits > 0) { this.#permits--; return () => this.release(); }
    return new Promise(resolve => this.#waiters.push(resolve));
  }
  release() {
    const next = this.#waiters.shift();
    if (next) next(() => this.release());
    else this.#permits++;
  }
  get available() { return this.#permits; }
}
