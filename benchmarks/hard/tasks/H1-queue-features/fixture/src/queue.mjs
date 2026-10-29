import { createClock } from './clock.mjs';
import { createIdGenerator } from './ids.mjs';
import { createJob, transition, STATUSES } from './job.mjs';
import { Emitter } from './events.mjs';
import { assertValidJobInput } from './validate.mjs';
import { compareJobs } from './priority.mjs';
import { MemoryStorage } from './storage.mjs';
import { Metrics } from './metrics.mjs';
import { Semaphore } from './limits.mjs';

// In-memory task queue. Handlers run under the concurrency limit; every state
// change goes through job.mjs transitions and is persisted via storage.
export class TaskQueue {
  #concurrency;
  #storage;
  #clock;
  #metrics;
  #logger;
  #emitter = new Emitter();
  #makeId;
  #waiting = [];
  #active = 0;
  #idleResolvers = [];

  constructor({ concurrency = 1, storage = new MemoryStorage(), clock = createClock(), metrics = new Metrics(), logger = null, idPrefix = 'job' } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be an integer >= 1');
    this.#concurrency = concurrency;
    this.#storage = storage;
    this.#clock = clock;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#makeId = createIdGenerator(idPrefix);
  }

  on(type, fn) { return this.#emitter.on(type, fn); }
  emit(type, ...args) { this.#emitter.emit(type, ...args); }

  async add(payload, { handler, priority = 0, maxAttempts = 1 } = {}) {
    assertValidJobInput({ payload, handler, priority });
    const job = createJob({ id: this.#makeId(), payload, priority, maxAttempts, createdAt: this.#clock.now() });
    await this.#storage.save(job);
    this.#metrics.inc('enqueued');
    this.#insert(job, handler);
    this.#pump();
    return job;
  }

  #insert(job, handler) {
    this.#waiting.push({ job, handler });
    this.#waiting.sort((a, b) => compareJobs(a.job, b.job));
  }

  #pump() {
    while (this.#active < this.#concurrency && this.#waiting.length > 0) {
      const next = this.#waiting.shift();
      this.#active++;
      this.#runOne(next.job, next.handler).finally(() => {
        this.#active--;
        this.#pump();
        this.#resolveIdleIfDone();
      });
    }
    this.#resolveIdleIfDone();
  }

  async #runOne(job, handler) {
    transition(job, 'running', this.#clock.now());
    await this.#storage.save(job);
    this.#metrics.inc('started');
    try {
      await handler(job);
      transition(job, 'succeeded', this.#clock.now());
      this.#metrics.inc('succeeded');
      this.emit('job:succeeded', job);
    } catch (error) {
      transition(job, 'failed', this.#clock.now());
      job.error = String((error && error.message) || error);
      this.#metrics.inc('failed');
      this.emit('job:failed', job, error);
    }
    await this.#storage.save(job);
  }

  #resolveIdleIfDone() {
    if (this.#active === 0 && this.#waiting.length === 0) {
      for (const resolve of this.#idleResolvers.splice(0)) resolve();
    }
  }

  whenIdle() {
    if (this.#active === 0 && this.#waiting.length === 0) return Promise.resolve();
    return new Promise(resolve => this.#idleResolvers.push(resolve));
  }

  async jobs() { return this.#storage.list(); }
  async counts() { return this.#storage.countByStatus(); }
  get metrics() { return this.#metrics; }
}

export { STATUSES };
