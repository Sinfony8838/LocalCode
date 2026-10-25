interface Waiter { owner: string; id: string; grant(): void }
interface Group { active?: Waiter; queue: Waiter[]; nextAt: number; timer?: ReturnType<typeof setTimeout> }
/** Main-process request leases; a worker cannot release another worker's request. */
export class RequestScheduler {
  private groups = new Map<string, Group>();
  constructor(private gapMs = 1000) {}
  acquire(groupId: string, owner: string, id: string, grant: () => void) {
    const group = this.groups.get(groupId) ?? { queue: [], nextAt: 0 };
    this.groups.set(groupId, group);
    if (group.active?.id === id || group.queue.some(w => w.id === id)) return;
    group.queue.push({ owner, id, grant }); this.pump(group);
  }
  release(groupId: string, owner: string, id: string, cooldownUntil = 0) {
    const group = this.groups.get(groupId); if (!group || group.active?.owner !== owner || group.active.id !== id) return;
    group.nextAt = Math.max(group.nextAt, cooldownUntil); group.active = undefined; this.pump(group);
  }
  cancel(owner: string, id?: string) {
    for (const group of this.groups.values()) {
      group.queue = group.queue.filter(w => w.owner !== owner || (id !== undefined && w.id !== id));
      if (group.active?.owner === owner && (id === undefined || group.active.id === id)) group.active = undefined;
      this.pump(group);
    }
  }
  private pump(group: Group) {
    if (group.timer) { clearTimeout(group.timer); group.timer = undefined; }
    if (group.active || !group.queue.length) return;
    const delay = group.nextAt - Date.now();
    if (delay > 0) { group.timer = setTimeout(() => this.pump(group), Math.min(delay, 2147483647)); return; }
    group.active = group.queue.shift()!; group.nextAt = Date.now() + this.gapMs;
    group.active.grant();
  }
}
