// Records every firing for inspection and tests.
export function createFireLog() {
  const entries = [];
  return {
    record(job, scheduledAtUtcMs, firedAtUtcMs) {
      entries.push({ id: job.id, scheduledAt: scheduledAtUtcMs, firedAt: firedAtUtcMs });
    },
    all() { return [...entries]; },
    forJob(id) { return entries.filter(entry => entry.id === id); },
  };
}
