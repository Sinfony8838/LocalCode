import type { GoalState, WorkMode } from '../shared/contracts';

/**
 * Adapted lifecycle/accounting invariants from openai/codex at
 * 970111f6cb62cc02fe36a82ea7d71b37a2889c97, ext/goal/src/{runtime,accounting}.rs.
 * Apache-2.0. Local adaptation: active-time budget, no token/turn-count budget.
 * Persistence and worker admission remain in the authoritative main process.
 */
export const DEFAULT_GOAL_BUDGET_MS = 2 * 60 * 60 * 1000;
export const WORK_TOOLS = new Set(['list_files', 'read_file', 'search', 'write_file', 'edit_file', 'powershell', 'read_attachment', 'search_attachments', 'list_attachment_files']);
export class GoalClock {
  private accumulated: number;
  private since?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  constructor(private budget: number, used: number, private readonly expired: () => void,
    private readonly now: () => number = () => performance.now()) { this.accumulated = used; }
  used() { return Math.max(0, this.accumulated + (this.since === undefined ? 0 : Math.max(0, this.now() - this.since))); }
  setActive(active: boolean) {
    if (this.ended) return;
    this.accumulated = this.used(); this.since = active ? this.now() : undefined;
    this.schedule();
  }
  setBudget(budget: number) { this.budget = budget; this.schedule(); }
  stop() { this.accumulated = this.used(); this.since = undefined; this.ended = true; clearTimeout(this.timer); return this.accumulated; }
  private schedule() {
    clearTimeout(this.timer);
    if (this.ended) return;
    const remaining = this.budget - this.used();
    if (remaining <= 0) {
      this.accumulated = this.used(); this.since = undefined; this.ended = true; this.expired(); return;
    }
    if (this.since !== undefined) this.timer = setTimeout(() => this.schedule(), Math.max(1, remaining));
  }
}

export function canContinueGoal(input: { goal?: GoalState; goalId?: string; mode?: WorkMode; automatic: boolean; workCalls: number; status: string }) {
  const { goal } = input;
  return !!goal && goal.id === input.goalId && goal.status === 'active' && goal.activeMs < goal.budgetMs
    && input.mode !== 'plan' && input.status === 'completed' && (!input.automatic || input.workCalls > 0);
}

export function continuationPrompt(goal: GoalState): string {
  // The objective is user data, never a system instruction. No previous command is replayed.
  return `继续推进当前目标：\n${goal.objective}\n\n先核对已有结果与目标的差距，再进行下一项有依据的工作。不要重放已完成操作。实际达到目标时调用 update_goal 并给出验证依据；需要用户信息或无法继续时说明阻塞。`;
}
