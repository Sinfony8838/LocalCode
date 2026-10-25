import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import RunSummary, { runDuration } from '../src/renderer/RunSummary';
import ChangeCheckpointDialog from '../src/renderer/ChangeCheckpointDialog';
import { setLocale } from '../src/renderer/i18n';
import type { RunSummary as Summary } from '../src/shared/contracts';

afterEach(() => setLocale('zh-CN'));

const summary: Summary = {
  runId: 'run', startedAt: '2026-01-01T00:00:00Z', status: 'completed', durationMs: 61000,
  changeScope: 'file_tools', changes: [{ path: '用户代码.ts', kind: 'modified', additions: 1, deletions: 0, source: 'file_tool', conflict: true }],
  coverageNote: '仅统计本轮文件工具记录；终端及其他来源的修改未完整统计。',
};

describe('localized file and run controls', () => {
  it.each([
    ['en', 'Edited 1 file(s)', '1 min 1 s', 'Other changes exist'],
    ['ja', '1 個のファイルを編集', '1 分 1 秒', '他の変更があります'],
    ['ko', '파일 1개 편집됨', '1분 1초', '다른 변경 사항이 있습니다'],
  ] as const)('renders application text in %s while preserving file paths', (locale, heading, duration, changeKind) => {
    setLocale(locale);
    const html = renderToStaticMarkup(<RunSummary run={summary} />);
    expect(html).toContain(heading);
    expect(html).toContain(duration);
    expect(html).toContain(changeKind);
    expect(html).toContain('用户代码.ts');
    expect(html).not.toContain('本轮运行结束');
    expect(html).not.toContain('仅统计本轮文件工具记录');
    expect(html).not.toContain('{count}');
  });

  it('keeps checkpoint file content intact when localizing the dialog', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ChangeCheckpointDialog preview={{ path: '文件.ts', content: 'const 提示 = "保留原文";', currentHash: 'hash', recordHash: 'record', byteLength: 42 }} pending={false} error="" onCancel={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('Use current contents as the new baseline');
    expect(html).toContain('42 bytes');
    expect(html).toContain('文件.ts');
    expect(html).toContain('保留原文');
    expect(html).not.toContain('确认当前内容为新起点');
  });

  it('restores original Chinese duration formatting', () => {
    setLocale('zh-CN');
    expect(runDuration(3_661_000)).toBe('1小时1分钟1秒');
  });

  it('keeps the compact file card and localized expand control', () => {
    setLocale('en');
    const changes = Array.from({ length: 5 }, (_, index) => ({ ...summary.changes[0], path: `文件${index}.ts` }));
    const html = renderToStaticMarkup(<RunSummary run={{ ...summary, changes }} showTiming={false} />);
    expect(html).toContain('Edited 5 file(s)');
    expect(html).toContain('Show 2 more file(s)');
    expect(html).toContain('文件2.ts');
    expect(html).not.toContain('文件3.ts');
    expect(html).not.toContain('run-timing');
    expect(html).not.toContain('仅统计本轮文件工具记录');
    expect(renderToStaticMarkup(<RunSummary run={{ ...summary, changes: [] }} showTiming={false} />)).toBe('');
  });
});
