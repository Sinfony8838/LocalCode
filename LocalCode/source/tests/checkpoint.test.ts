import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceTools } from '../src/agent/tools';
import { checkpointChange, getChanges, getRunToolChanges, MAX_CHECKPOINT_BYTES, MAX_FILE_BYTES, previewChangeCheckpoint, readWorkspaceText, undoChange, writeWorkspaceText } from '../src/core/workspace';

const roots: string[] = [];
const testBase = path.resolve('tests');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== testBase || !path.basename(root).startsWith('.checkpoint-')) throw new Error('Unexpected cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(original: string | null = 'const value=1;\n') {
  const root = await fs.mkdtemp(path.join(testBase, '.checkpoint-')); roots.push(root);
  const projectPath = path.join(root, 'project'); const dataDir = path.join(root, 'data');
  await fs.mkdir(projectPath);
  const context = { ...workspaceContext(projectPath, dataDir), sessionId: 'checkpoint-session', runId: 'first-run' };
  const file = path.join(projectPath, 'code.ts');
  if (original !== null) await fs.writeFile(file, original);
  await writeWorkspaceText({ ...context, relativePath: 'code.ts', content: 'const value=2;\n' });
  const formatted = '\ufeffconst value = 2;\r\n'; await fs.writeFile(file, formatted);
  const journalPath = path.join(dataDir, 'changes', context.sessionId, 'index.json');
  const journal = async () => JSON.parse(await fs.readFile(journalPath, 'utf8'));
  const preview = () => previewChangeCheckpoint(context, context.sessionId, 'code.ts');
  const checkpoint = (review: Awaited<ReturnType<typeof preview>>) => checkpointChange(context, context.sessionId, 'code.ts', review.currentHash, review.recordHash);
  return { ...context, root, file, formatted, journalPath, journal, preview, checkpoint };
}

describe('explicit external-edit checkpoints', () => {
  it.each(['const value=1;\n', null])('requires approval after rereading; undo preserves formatted bytes and archives old evidence (%s)', async original => {
    const f = await fixture(original);
    const beforeJournal = await f.journal(); const beforeRun = await getRunToolChanges(f, f.sessionId, f.runId);
    expect((await getChanges(f, f.sessionId))[0].conflict).toBe(true);
    const current = await readWorkspaceText(f, 'code.ts');
    await expect(writeWorkspaceText({ ...f, runId: 'second-run', relativePath: 'code.ts', expectedText: current, content: 'const value = 3;\n' })).rejects.toThrow(/新修改/);
    await expect(undoChange(f, f.sessionId, 'code.ts')).rejects.toThrow(/撤销冲突/);
    const preview = await f.preview();
    expect(preview).toEqual({ path: 'code.ts', content: f.formatted, byteLength: Buffer.byteLength(f.formatted), currentHash: createHash('sha256').update(f.formatted).digest('hex'), recordHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await f.journal()).toEqual(beforeJournal); // Merely previewing/canceling is read-only.
    await f.checkpoint(preview);
    expect(await fs.readFile(f.file, 'utf8')).toBe(f.formatted);
    const checkpointed = await f.journal();
    expect(checkpointed.checkpoints).toHaveLength(1);
    expect(checkpointed.checkpoints[0]).toMatchObject({ previous: beforeJournal.records[0], approved: Buffer.from(f.formatted).toString('base64'), approvedHash: preview.currentHash });
    expect(checkpointed.runRecords).toEqual(beforeJournal.runRecords);
    expect(await getRunToolChanges(f, f.sessionId, f.runId)).toEqual(beforeRun);
    expect((await getChanges(f, f.sessionId))[0]).toMatchObject({ before: f.formatted, after: f.formatted, created: false, conflict: false });
    await writeWorkspaceText({ ...f, runId: 'second-run', relativePath: 'code.ts', expectedText: f.formatted, content: 'const value = 3;\n' });
    await undoChange(f, f.sessionId, 'code.ts');
    expect(await fs.readFile(f.file)).toEqual(Buffer.from(f.formatted));
    expect(await getChanges(f, f.sessionId)).toEqual([]);
    const afterUndo = await f.journal();
    expect(afterUndo.checkpoints).toEqual(checkpointed.checkpoints);
    expect(await getRunToolChanges(f, f.sessionId, f.runId)).toEqual(beforeRun);
    expect(afterUndo.runRecords).toHaveLength(2);
  });

  it('rejects changes since the displayed hash and rejects a new external edit after approval', async () => {
    const f = await fixture(); const originalJournal = await f.journal(); const preview = await f.preview();
    await fs.writeFile(f.file, 'newer manual edit');
    await expect(f.checkpoint(preview)).rejects.toThrow(/预览后已再次修改/);
    expect(await f.journal()).toEqual(originalJournal);
    const newer = await f.preview(); await f.checkpoint(newer);
    await expect(f.checkpoint(newer)).rejects.toThrow(/修改记录在预览后已变化/);
    await fs.writeFile(f.file, 'even newer manual edit');
    await expect(writeWorkspaceText({ ...f, runId: 'second-run', relativePath: 'code.ts', content: 'BAD' })).rejects.toThrow(/新修改/);
    await expect(undoChange(f, f.sessionId, 'code.ts')).rejects.toThrow(/撤销冲突/);
    expect(await fs.readFile(f.file, 'utf8')).toBe('even newer manual edit');
  });

  it('rejects a stale journal approval even when the displayed file bytes are unchanged', async () => {
    const f = await fixture(); const preview = await f.preview(); const journal = await f.journal();
    journal.records[0].runId = 'different-round'; await fs.writeFile(f.journalPath, JSON.stringify(journal));
    await expect(f.checkpoint(preview)).rejects.toThrow(/修改记录在预览后已变化/);
    expect(await f.journal()).toEqual(journal);
    expect(await fs.readFile(f.file, 'utf8')).toBe(f.formatted);
  });

  it('rechecks pending state under the lock, including after preview', async () => {
    const f = await fixture(); const preview = await f.preview(); const journal = await f.journal();
    journal.records[0].pending = true; await fs.writeFile(f.journalPath, JSON.stringify(journal));
    await expect(f.checkpoint(preview)).rejects.toThrow(/写入未完成/);
    await expect(f.preview()).rejects.toThrow(/写入未完成/);
    expect(await f.journal()).toEqual(journal);
    expect(await fs.readFile(f.file, 'utf8')).toBe(f.formatted);
  });

  it('rejects deleted, binary, invalid UTF-8, oversized and outside-linked current files without rewriting evidence', async () => {
    const f = await fixture(); const preview = await f.preview();
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(MAX_FILE_BYTES + 1, 65)]) {
      await fs.writeFile(f.file, bytes);
      await expect(f.preview()).rejects.toThrow(); await expect(f.checkpoint(preview)).rejects.toThrow();
      expect((await fs.readFile(f.file)).equals(bytes)).toBe(true);
    }
    await fs.unlink(f.file);
    await expect(f.preview()).rejects.toThrow(); await expect(f.checkpoint(preview)).rejects.toThrow();
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'code.ts'), f.formatted);
    // Junctions work on Windows without Developer Mode; swap a parent after preview.
    const nested = path.join(f.projectPath, 'nested'); await fs.mkdir(nested);
    await writeWorkspaceText({ ...f, relativePath: 'nested/code.ts', content: 'tool result' });
    await fs.writeFile(path.join(nested, 'code.ts'), f.formatted);
    const nestedPreview = await previewChangeCheckpoint(f, f.sessionId, 'nested/code.ts');
    const beforeLink = await f.journal();
    await fs.unlink(path.join(nested, 'code.ts')); await fs.rmdir(nested); await fs.symlink(outside, nested, 'junction');
    await expect(checkpointChange(f, f.sessionId, 'nested/code.ts', nestedPreview.currentHash, nestedPreview.recordHash)).rejects.toThrow(/链接/);
    expect(await fs.readFile(path.join(outside, 'code.ts'), 'utf8')).toBe(f.formatted);
    expect(await f.journal()).toEqual(beforeLink);
    expect(beforeLink.checkpoints).toBeUndefined();
  });

  it('keeps the old journal intact when the atomic checkpoint commit fails', async () => {
    const f = await fixture(); const preview = await f.preview(); const before = await fs.readFile(f.journalPath);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk rename failed'));
    await expect(f.checkpoint(preview)).rejects.toThrow('disk rename failed');
    expect(await fs.readFile(f.journalPath)).toEqual(before);
    expect(await fs.readdir(path.dirname(f.journalPath))).toEqual(['index.json']);
    expect(await fs.readFile(f.file, 'utf8')).toBe(f.formatted);
    await f.checkpoint(preview); expect((await f.journal()).checkpoints).toHaveLength(1);
  });

  it('rejects approval above 128KiB instead of hiding truncated text; no agent checkpoint tool exists', async () => {
    const f = await fixture(); const preview = await f.preview();
    const limit = 'x'.repeat(MAX_CHECKPOINT_BYTES); await fs.writeFile(f.file, limit);
    expect((await f.preview()).content).toBe(limit);
    await fs.writeFile(f.file, limit + 'x');
    await expect(f.preview()).rejects.toThrow(/128KiB/);
    await expect(f.checkpoint(preview)).rejects.toThrow(/128KiB/);
    expect((await f.journal()).checkpoints).toBeUndefined();
    const tools = createWorkspaceTools({ ...f, maxResultChars: 500, emit: () => {}, requestApproval: async () => true });
    expect(tools.map(tool => tool.name)).not.toContain('checkpoint');
    expect(tools.map(tool => tool.name).some(name => /checkpoint|rebase/i.test(name))).toBe(false);
    await expect(f.checkpoint({ ...preview, currentHash: 'not-a-hash' })).rejects.toThrow(/校验值/);
  });
});
