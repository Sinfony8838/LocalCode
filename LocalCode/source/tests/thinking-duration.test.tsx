import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationTimeline, ThinkingPart } from '../src/renderer/App';
import type { ChatMessage, MessagePart, ToolRecord } from '../src/shared/contracts';

const thinking = (startedAt: string, endedAt: string): MessagePart =>
  ({ index: 0, type: 'thinking', text: '简短推理', startedAt, endedAt, state: 'completed' });

const assistant = (id: string, createdAt: string, parts: MessagePart[], text = ''): ChatMessage =>
  ({ id, role: 'assistant', text, createdAt, partial: false, parts });

const tool = (id: string, createdAt: string): ToolRecord =>
  ({ id, runId: 'run', name: 'list_files', args: { path: 'sample.txt' }, createdAt, status: 'completed' });

describe('thinking duration labels', () => {
  it('labels sub-second blocks as under one second instead of zero', () => {
    const html = renderToStaticMarkup(<ThinkingPart part={thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.810Z')} />);
    expect(html).toContain('不足 1 秒');
    expect(html).not.toContain('0 秒');
  });

  it('keeps whole-second labels for longer blocks', () => {
    const html = renderToStaticMarkup(<ThinkingPart part={thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:41.110Z')} />);
    expect(html).toContain('41');
    expect(html).not.toContain('不足 1 秒');
  });
});

describe('folding short thinking into tool cards', () => {
  it('folds a short thinking-only turn into the following tool card', () => {
    const html = renderToStaticMarkup(<ConversationTimeline status="completed" runs={[]}
      messages={[assistant('m1', '2026-01-01T00:00:00.000Z', [thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.600Z')])]}
      tools={[tool('t1', '2026-01-01T00:00:01.000Z')]} />);
    expect(html).toContain('浏览目录');
    expect(html).toContain('tool-thinking');
    expect(html).toContain('不足 1 秒');
    expect(html).not.toContain('thinking-part');
  });

  it('merges consecutive thinking-only turns into one expander on the tool card', () => {
    const html = renderToStaticMarkup(<ConversationTimeline status="completed" runs={[]}
      messages={[
        assistant('m1', '2026-01-01T00:00:00.000Z', [thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.400Z')]),
        assistant('m2', '2026-01-01T00:00:00.500Z', [thinking('2026-01-01T00:00:00.500Z', '2026-01-01T00:00:00.900Z')]),
      ]}
      tools={[tool('t1', '2026-01-01T00:00:01.000Z')]} />);
    expect(html.match(/tool-thinking/g)).toHaveLength(1);
    expect(html).not.toContain('thinking-part');
  });

  it('keeps longer thinking-only turns as standalone sections', () => {
    const html = renderToStaticMarkup(<ConversationTimeline status="completed" runs={[]}
      messages={[assistant('m1', '2026-01-01T00:00:00.000Z', [thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.500Z')])]}
      tools={[tool('t1', '2026-01-01T00:00:03.000Z')]} />);
    expect(html).toContain('thinking-part');
    expect(html).not.toContain('tool-thinking');
  });

  it('keeps thinking attached to a reply standalone even when a tool follows', () => {
    const html = renderToStaticMarkup(<ConversationTimeline status="completed" runs={[]}
      messages={[assistant('m1', '2026-01-01T00:00:00.000Z', [thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.600Z')], '正文回答')]}
      tools={[tool('t1', '2026-01-01T00:00:01.000Z')]} />);
    expect(html).toContain('thinking-part');
    expect(html).not.toContain('tool-thinking');
  });

  it('keeps a thinking-only turn standalone when no tool card follows', () => {
    const html = renderToStaticMarkup(<ConversationTimeline status="completed" runs={[]}
      messages={[
        assistant('m1', '2026-01-01T00:00:00.000Z', [thinking('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.600Z')]),
        assistant('m2', '2026-01-01T00:00:02.000Z', [], '收尾回答'),
      ]}
      tools={[]} />);
    expect(html).toContain('thinking-part');
    expect(html).not.toContain('tool-thinking');
  });
});
