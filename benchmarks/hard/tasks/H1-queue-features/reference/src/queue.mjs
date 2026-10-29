import { createClock } from './clock.mjs';
import { createIdGenerator } from './ids.mjs';
import { createJob, transition, STATUSES } from './job.mjs';
import { Emitter } from './events.mjs';
import { assertValidJobInput } from './validate.mjs';
import { compareJobs } from './priority.mjs';
import { MemoryStorage } from './storage.mjs';
import { Metrics } from './metrics.mjs';
import { Semaphore } from './limits.mjs';
import { computeDelay } from './backoff.mjs';

// In-memory task queue. Handlers run under the concurrency limit; every state
// change goes through job.mjs transitions and is persisted via storage.
// Failed jobs retry per the queue/job retry config and end in the dead-letter
// list once every attempt is exhausted (maxAttempts > 1 only).
export class TaskQueue {
  #concurrency;
  #storage;
  #clock;
  #metrics;
  #logger;
  #emitter = new Emitter();
  #makeId;
  #defaultRetry;
  #waiting = [];
  #active = 0;
  #pendingRetries = 0;
  #idleResolvers = [];

  constructor({ concurrency = 1, storage = new MemoryStorage(), clock = createClock(), metrics = new Metrics(), logger = null, idPrefix = 'job', retry = null } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be an integer >= 1');
    this.#concurrency = concurrency;
    this.#storage = storage;
    this.#clock = clock;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#makeId = createIdGenerator(idPrefix);
    this.#defaultRetry = normalizeRetry(retry);
  }

  on(type, fn) { return this.#emitter.on(type, fn); }
  emit(type, ...args) { this.#emitter.emit(type, ...args); }

  async add(payload, { handler, priority = 0, maxAttempts, retry = null } = {}) {
    assertValidJobInput({ payload, handler, priority });
    const retryConfig = normalizeRetry(retry, this.#defaultRetry);
    const attempts = maxAttempts ?? retryConfig.maxAttempts;
    const job = createJob({ id: this.#makeId(), payload, priority, maxAttempts: attempts, createdAt: this.#clock.now() });
    await this.#storage.save(job);
    this.#metrics.inc('enqueued');
    this.#insert(job, handler, { ...retryConfig, maxAttempts: attempts });
    this.#pump();
    return job;
  }

  #insert(job, handler, retryConfig) {
    this.#waiting.push({ job, handler, retryConfig });
    this.#waiting.sort((a, b) => compareJobs(a.job, b.job));
  }

  #pump() {
    while (this.#active < this.#concurrency && this.#waiting.length > 0) {
      const next = this.#waiting.shift();
      this.#active++;
      this.#runOne(next.job, next.handler, next.retryConfig).finally(() => {
        this.#active--;
        this.#pump();
        this.#resolveIdleIfDone();
      });
    }
    this.#resolveIdleIfDone();
  }

  async #runOne(job, handler, retryConfig) {
    transition(job, 'running', this.#clock.now());
    await this.#storage.save(job);
    this.#metrics.inc('started');
    job.attempts++;
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
      await this.#handleFailure(job, handler, retryConfig);
      return;
    }
    await this.#storage.save(job);
  }

  async #handleFailure(job, handler, retryConfig) {
    const now = this.#clock.now();
    if (retryConfig.maxAttempts > 1 && job.attempts < retryConfig.maxAttempts) {
      transition(job, 'queued', now);
      await this.#storage.save(job);
      this.#metrics.inc('retries');
      const delayMs = computeDelay(retryConfig.policy, retryConfig.baseDelayMs, job.attempts);
      this.#pendingRetries++;
      this.#clock.delay(delayMs).then(() => {
        this.#pendingRetries--;
        this.#insert(job, handler, retryConfig);
        this.#pump();
      });
      return;
    }
    if (retryConfig.maxAttempts > 1) {
      transition(job, 'dead', now);
      job.deadAt = now;
      await this.#storage.save(job);
      this.#metrics.inc('dead');
      this.emit('job:dead', job);
      return;
    }
    await this.#storage.save(job);
  }

  #resolveIdleIfDone() {
    if (this.#active === 0 && this.#waiting.length === 0 && this.#pendingRetries === 0) {
      for (const resolve of this.#idleResolvers.splice(0)) resolve();
    }
  }

  whenIdle() {
    if (this.#active === 0 && this.#waiting.length === 0 && this.#pendingRetries === 0) return Promise.resolve();
    return new Promise(resolve => this.#idleResolvers.push(resolve));
  }

  async deadLetters() {
    const dead = (await this.#storage.list()).filter(job => job.status === 'dead');
    dead.sort((a, b) => (a.deadAt ?? 0) - (b.deadAt ?? 0));
    return dead;
  }

  async jobs() { return this.#storage.list(); }
  async counts() { return this.#storage.countByStatus(); }
  get metrics() { return this.#metrics; }
}

function normalizeRetry(retry, defaults = { maxAttempts: 1, policy: 'fixed', baseDelayMs: 0 }) {
  const merged = { ...defaults, ...(retry ?? {}) };
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) throw new TypeError('retry.maxAttempts must be an integer >= 1');
  if (!Number.isFinite(merged.baseDelayMs) || merged.baseDelayMs < 0) throw new TypeError('retry.baseDelayMs must be a non-negative finite number');
  return merged;
}

export { STATUSES };
