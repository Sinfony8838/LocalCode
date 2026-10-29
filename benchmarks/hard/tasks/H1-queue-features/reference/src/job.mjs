// Job records and the legal status transitions between them.
export const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead'];

export const TRANSITIONS = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['queued', 'dead'],
  cancelled: [],
  dead: [],
};

export function createJob({ id, payload, priority = 0, maxAttempts = 1, createdAt }) {
  if (!id) throw new TypeError('id is required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be an integer >= 1');
  return {
    id,
    payload,
    priority,
    maxAttempts,
    status: 'queued',
    attempts: 0,
    error: null,
    createdAt: createdAt ?? 0,
    updatedAt: createdAt ?? 0,
  };
}

export function transition(job, status, now = 0) {
  const allowed = TRANSITIONS[job.status] ?? [];
  if (!allowed.includes(status)) {
    throw new Error(`illegal transition ${job.status} -> ${status} for job ${job.id}`);
  }
  job.status = status;
  job.updatedAt = now;
  return job;
}
