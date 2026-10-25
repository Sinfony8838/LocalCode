import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ChangeCheckpointDialog from '../src/renderer/ChangeCheckpointDialog';

const preview = { path: 'code.ts', content: '<script>not executable</script>\r\n', currentHash: 'a'.repeat(64), recordHash: 'b'.repeat(64), byteLength: 36 };
describe('explicit checkpoint confirmation', () => {
  it('shows the complete current text and its hash with a cancel-first native dialog', () => {
    const html = renderToStaticMarkup(<ChangeCheckpointDialog preview={preview} pending={false} error="" onCancel={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('<dialog'); expect(html).toContain('aria-labelledby="checkpoint-title"');
    expect(html).toContain('aria-label="当前文件完整内容"'); expect(html).toContain('&lt;script&gt;not executable&lt;/script&gt;');
    expect(html).toContain(preview.currentHash); expect(html).toContain('不会撤回格式化或其他外部修改');
    expect(html.indexOf('取消')).toBeLessThan(html.indexOf('确认并保留当前内容'));
  });
  it('keeps a stale approval disabled and exposes its error in the dialog', () => {
    const html = renderToStaticMarkup(<ChangeCheckpointDialog preview={preview} pending={false} error="请取消后重新预览" onCancel={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('role="alert"'); expect(html).toContain('disabled="">确认并保留当前内容');
  });
});
