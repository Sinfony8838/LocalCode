// Job registry with stable iteration order (insertion order).
export function createRegistry() {
  const jobs = new Map();
  return {
    add(job) {
      if (!job.id) throw new TypeError('job id is required');
      if (jobs.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
      jobs.set(job.id, job);
      return job;
    },
    get(id) { return jobs.get(id) ?? null; },
    all() { return [...jobs.values()]; },
    get size() { return jobs.size; },
  };
}
