import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RunSummary from '../src/renderer/RunSummary';
import type { RunSummary as Summary } from '../src/shared/contracts';

const summary: Summary = { runId: 'run', startedAt: '2026-01-01T00:00:00Z', status: 'completed',
  changes: [], changeScope: 'file_tools', durationMs: 1500 };

describe('runtime summary does not certify task verification', () => {
  it('shows elapsed time without claiming that a task or test passed', () => {
    const html = renderToStaticMarkup(<RunSummary run={summary} />);
    expect(html).toContain('用时 1秒');
    expect(html).toContain('aria-label="本轮运行记录"');
    expect(html).not.toContain('不代表测试或任务验收通过');
    expect(html).not.toContain('本轮已完成');
    expect(html).not.toContain('本轮完成总结');
    expect(html).not.toContain('lucide-check');
  });

  it.each([['failed', '本轮运行失败'], ['interrupted', '本轮已停止']] as const)('keeps %s visible', (status, label) => {
    const html = renderToStaticMarkup(<RunSummary run={{ ...summary, status }} />);
    expect(html).toContain(label);
    expect(html).not.toContain('本轮运行结束');
  });

  it('does not show an end record while the runtime is active', () => {
    expect(renderToStaticMarkup(<RunSummary run={{ ...summary, status: 'running' }} />)).toBe('');
  });
});
