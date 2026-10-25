import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalClock, canContinueGoal, DEFAULT_GOAL_BUDGET_MS } from '../src/core/goals';
import type { GoalState } from '../src/shared/contracts';
afterEach(() => vi.useRealTimers());
const goal: GoalState = { id: 'goal-a', objective: 'fix the test', status: 'active', budgetMs: DEFAULT_GOAL_BUDGET_MS, activeMs: 0, updatedAt: '' };
describe('goal budget and safe continuation (Codex adaptation)', () => {
  it('expires a running operation at two hours, without waiting for settlement', () => {
    vi.useFakeTimers(); let now = 0; const expired = vi.fn();
    const clock = new GoalClock(DEFAULT_GOAL_BUDGET_MS, 0, expired, () => now);
    clock.setActive(true); now = DEFAULT_GOAL_BUDGET_MS; vi.advanceTimersByTime(now);
    expect(expired).toHaveBeenCalledTimes(1); expect(clock.used()).toBe(DEFAULT_GOAL_BUDGET_MS);
    clock.setActive(true); vi.advanceTimersByTime(500); expect(expired).toHaveBeenCalledTimes(1);
  });
  it('excludes approval, questions and queued time; resumes with the remaining budget', () => {
    vi.useFakeTimers(); let now = 0; const expired = vi.fn(); const clock = new GoalClock(1000, 100, expired, () => now);
    clock.setActive(true); now = 200; clock.setActive(false);
    now = 10000; vi.advanceTimersByTime(10000); expect(clock.used()).toBe(300); expect(expired).not.toHaveBeenCalled();
    clock.setActive(true); now += 700; vi.advanceTimersByTime(700); expect(expired).toHaveBeenCalledOnce();
  });
  it('stopping removes the deadline and records the elapsed interval only once', () => {
    vi.useFakeTimers(); let now = 0; const expired = vi.fn(); const clock = new GoalClock(1000, 0, expired, () => now);
    clock.setActive(true); now = 40; expect(clock.stop()).toBe(40); now = 5000;
    vi.advanceTimersByTime(5000); expect(clock.used()).toBe(40); expect(expired).not.toHaveBeenCalled();
  });
  it('refuses old goals, plan mode, budget limits, failure and tool-free automatic loops', () => {
    const input = { goal, goalId: goal.id, mode: 'execute' as const, automatic: true, workCalls: 1, status: 'completed' };
    expect(canContinueGoal(input)).toBe(true);
    expect(canContinueGoal({ ...input, goalId: 'old' })).toBe(false);
    expect(canContinueGoal({ ...input, mode: 'plan' })).toBe(false);
    expect(canContinueGoal({ ...input, workCalls: 0 })).toBe(false);
    expect(canContinueGoal({ ...input, status: 'failed' })).toBe(false);
    expect(canContinueGoal({ ...input, goal: { ...goal, status: 'budget_limited' } })).toBe(false);
    expect(canContinueGoal({ ...input, goal: { ...goal, activeMs: goal.budgetMs } })).toBe(false);
  });
});
