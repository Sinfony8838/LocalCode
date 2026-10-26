import { workspaceContext } from '../src/core/workspace-context';
import { describe, expect, it, vi } from 'vitest';
import { createSkillTool } from '../src/agent/skills';

const context = () => ({ ...workspaceContext('D:/project', 'D:/data'), sessionId: 's', runId: 'r', maxResultChars: 1000,
  emit: vi.fn(), requestApproval: vi.fn(), beforeTool: vi.fn() });

describe('bundled desktop pet skill', () => {
  it('loads instructions and references without executing or requesting approval', async () => {
    const ctx = context(); const tool = createSkillTool(ctx);
    for (const resource of ['instructions', 'atlas-spec', 'api-guide']) {
      const result = await tool.execute('1', { name: 'create-desktop-pet', resource }, undefined, undefined, {} as never);
      const text = result.content.find(c => c.type === 'text');
      expect(text && 'text' in text && text.text).toContain('pet-assets.mjs');
      expect(text && 'text' in text && text.text.length).toBeGreaterThan(300);
    }
    expect(ctx.requestApproval).not.toHaveBeenCalled();
    expect(ctx.beforeTool).toHaveBeenCalledTimes(3);
  });
  it('rejects arbitrary resource paths, projectless runs, and cancellation', async () => {
    const ctx = context(); const tool = createSkillTool(ctx);
    await expect(tool.execute('1', { name: 'create-desktop-pet', resource: '../../settings' }, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(tool.execute('1', { name: 'another-skill' }, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(createSkillTool({ ...ctx, projectPath: '' }).execute('1', { name: 'create-desktop-pet' }, undefined, undefined, {} as never)).rejects.toThrow('选择项目');
    const controller = new AbortController(); controller.abort();
    await expect(tool.execute('1', { name: 'create-desktop-pet' }, controller.signal, undefined, {} as never)).rejects.toThrow();
    expect(ctx.beforeTool).not.toHaveBeenCalled();
  });
});
