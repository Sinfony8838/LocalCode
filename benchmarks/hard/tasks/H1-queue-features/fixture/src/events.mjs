// Minimal synchronous event emitter.
export class Emitter {
  #listeners = new Map();

  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(fn);
    return () => this.off(type, fn);
  }
  once(type, fn) {
    const off = this.on(type, (...args) => { off(); fn(...args); });
    return off;
  }
  off(type, fn) {
    const list = this.#listeners.get(type);
    const index = list ? list.indexOf(fn) : -1;
    if (index !== -1) list.splice(index, 1);
  }
  emit(type, ...args) {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(...args);
  }
}
