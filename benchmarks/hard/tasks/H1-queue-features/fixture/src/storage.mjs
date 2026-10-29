// Pluggable job persistence. TaskQueue only talks to this interface.
export class MemoryStorage {
  #jobs = new Map();

  async save(job) { this.#jobs.set(job.id, { ...job }); return job; }
  async get(id) { return this.#jobs.get(id) ?? null; }
  async delete(id) { return this.#jobs.delete(id); }
  async list() { return [...this.#jobs.values()]; }
  async countByStatus() {
    const counts = {};
    for (const job of this.#jobs.values()) counts[job.status] = (counts[job.status] ?? 0) + 1;
    return counts;
  }
}
