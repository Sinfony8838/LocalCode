import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceTools } from '../src/agent/tools.js';
import { getChanges, listWorkspaceFiles, MAX_FILE_BYTES, readWorkspaceFile, readWorkspaceText, resolveWorkspacePath, undoChange, writeWorkspaceText } from '../src/core/workspace.js';
import { beginRunChanges, finishRunChanges } from '../src/core/run-changes.js';

const testBase = path.resolve('tests');
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== testBase || !path.basename(root).startsWith('.workspace-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(testBase, '.workspace-')); roots.push(root);
  const projectPath = path.join(root, 'project'); const dataDir = path.join(root, 'data'); const outside = path.join(root, 'outside');
  await Promise.all([fs.mkdir(projectPath), fs.mkdir(outside)]);
  const context = { projectPath, dataDir, sessionId: 'test-session', runId: 'run-one' };
  const write = (relativePath: string, content: string, expectedText?: string) => writeWorkspaceText({ ...context, relativePath, content, expectedText });
  return { ...context, root, outside, write };
}

describe('workspace containment', () => {
  it('rejects traversal, absolute paths, ADS, reserved names and .git before writing', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.outside, 'keep.txt'), 'outside');
    for (const invalid of ['../outside/keep.txt', '..\\outside\\keep.txt', f.outside, 'C:\\any.txt', '\\\\server\\share', 'keep.txt:stream', '.git/config', 'NUL.txt', 'name.']) {
      await expect(f.write(invalid, 'BAD')).rejects.toThrow();
    }
    expect(await fs.readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('outside');
    expect(await getChanges(f.dataDir, f.sessionId)).toEqual([]);
  });

  it('rejects outside junctions, including a dangling junction used as a new-file parent', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.outside, 'keep.txt'), 'outside');
    await fs.symlink(f.outside, path.join(f.projectPath, 'escape'), 'junction');
    await expect(readWorkspaceText(f.projectPath, 'escape/keep.txt')).rejects.toThrow(/链接/);
    await expect(f.write('escape/keep.txt', 'BAD')).rejects.toThrow(/链接/);
    await expect(f.write('escape/new/deep.txt', 'BAD')).rejects.toThrow(/链接/);
    const absentOutside = path.join(f.root, 'not-created-outside');
    await fs.symlink(absentOutside, path.join(f.projectPath, 'dangling'), 'junction');
    await expect(f.write('dangling/new.txt', 'BAD')).rejects.toThrow(/链接/);
    await expect(fs.stat(absentOutside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listWorkspaceFiles(f.projectPath)).toEqual([]);
    expect(await fs.readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('outside');
  });

  it('refuses hard-linked writes and links into .git', async () => {
    const f = await fixture(); const outsideFile = path.join(f.outside, 'keep.txt');
    await fs.writeFile(outsideFile, 'outside'); await fs.link(outsideFile, path.join(f.projectPath, 'linked.txt'));
    await expect(f.write('linked.txt', 'BAD')).rejects.toThrow(/硬链接/);
    await fs.mkdir(path.join(f.projectPath, '.git')); await fs.writeFile(path.join(f.projectPath, '.git/config'), 'git');
    await fs.symlink(path.join(f.projectPath, '.git'), path.join(f.projectPath, 'alias'), 'junction');
    await expect(readWorkspaceText(f.projectPath, 'alias/config')).rejects.toThrow(/\.git/);
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside');
  });

  it('excludes dependencies, model weights and .env from bulk browsing', async () => {
    const f = await fixture();
    for (const name of ['node_modules', '.git', 'models', 'runtime']) await fs.mkdir(path.join(f.projectPath, name));
    await fs.writeFile(path.join(f.projectPath, '.env'), 'secret');
    await fs.writeFile(path.join(f.projectPath, 'hello.ts'), 'export const hello = 1;');
    expect((await listWorkspaceFiles(f.projectPath)).map(e => e.path)).toEqual(['hello.ts']);
    expect((await resolveWorkspacePath(f.projectPath, '', { directory: true })).absolute).toBe(await fs.realpath(f.projectPath));
  });

  it('rejects binary, invalid UTF-8 and oversized source files without mutation', async () => {
    const f = await fixture();
    for (const [name, bytes] of [['binary', Buffer.from([1, 0, 3])], ['invalid', Buffer.from([0xff, 0xfe])], ['large', Buffer.alloc(MAX_FILE_BYTES + 1, 65)]] as const) {
      await fs.writeFile(path.join(f.projectPath, name), bytes);
      await expect(readWorkspaceFile(f.projectPath, name)).rejects.toThrow();
      await expect(f.write(name, 'BAD')).rejects.toThrow();
      expect((await fs.readFile(path.join(f.projectPath, name))).equals(bytes)).toBe(true);
    }
  });
});

describe('journal and safe undo', () => {
  it('snapshots the actual dirty bytes and restores BOM and CRLF across repeated edits', async () => {
    const f = await fixture(); const file = path.join(f.projectPath, 'dirty.ts');
    const original = Buffer.from('\ufeff// 用户尚未提交的修改\r\nexport const value = 1;\r\n');
    await fs.writeFile(file, original); await f.write('dirty.ts', '// first\n'); await f.write('dirty.ts', '// second\n');
    const changes = await getChanges(f.dataDir, f.sessionId);
    expect(changes).toHaveLength(1); expect(changes[0]).toMatchObject({ before: original.toString(), after: '// second\n', conflict: false, created: false });
    await undoChange(f.dataDir, f.sessionId, 'dirty.ts');
    expect(await fs.readFile(file)).toEqual(original); expect(await getChanges(f.dataDir, f.sessionId)).toEqual([]);
  });

  it('preserves both the agent result and newer user edits when undo conflicts', async () => {
    const f = await fixture(); const file = path.join(f.projectPath, 'code.ts'); await fs.writeFile(file, 'original');
    await f.write('code.ts', 'agent'); await fs.writeFile(file, 'user after agent');
    await expect(undoChange(f.dataDir, f.sessionId, 'code.ts')).rejects.toThrow(/撤销冲突/);
    await expect(f.write('code.ts', 'second agent')).rejects.toThrow(/新修改/);
    expect(await fs.readFile(file, 'utf8')).toBe('user after agent');
    expect((await getChanges(f.dataDir, f.sessionId))[0]).toMatchObject({ before: 'original', after: 'agent', conflict: true });
  });

  it('checks an expected read value before mutation and safely undoes created nested files', async () => {
    const f = await fixture(); const file = path.join(f.projectPath, 'file.txt'); await fs.writeFile(file, 'newer user value');
    await expect(f.write('file.txt', 'BAD', 'stale read')).rejects.toThrow(/读取后已变化/);
    expect(await fs.readFile(file, 'utf8')).toBe('newer user value');
    await f.write('new/nested/code.ts', 'export const x = 1;');
    expect((await getChanges(f.dataDir, f.sessionId))[0].created).toBe(true);
    await undoChange(f.dataDir, f.sessionId, 'new/nested/code.ts');
    await expect(fs.stat(path.join(f.projectPath, 'new/nested/code.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed after a journaled write is interrupted and retains recoverable original content', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, 'code.ts'), 'original'); await f.write('code.ts', 'agent');
    const journalFile = path.join(f.dataDir, 'changes', f.sessionId, 'index.json');
    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8')); journal.records[0].pending = true;
    await fs.writeFile(journalFile, JSON.stringify(journal));
    expect((await getChanges(f.dataDir, f.sessionId))[0]).toMatchObject({ conflict: true, before: 'original' });
    await undoChange(f.dataDir, f.sessionId, 'code.ts');
    expect(await fs.readFile(path.join(f.projectPath, 'code.ts'), 'utf8')).toBe('original');
  });
});

describe('tool validation and context budget', () => {
  it('rejects invalid parameters and ambiguous replacement without side effects', async () => {
    const f = await fixture(); const tools = createWorkspaceTools({ ...f, maxResultChars: 500, emit: () => {}, requestApproval: async () => true });
    const write = tools.find(t => t.name === 'write_file')!;
    await expect(write.execute('bad', { path: 'bad.txt', content: 5 }, undefined, undefined, {} as never)).rejects.toThrow(/参数无效/);
    await expect(write.execute('bad', { path: 'bad.txt', content: 'x', extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/参数无效/);
    await fs.writeFile(path.join(f.projectPath, 'same.txt'), 'same same');
    await expect(tools.find(t => t.name === 'edit_file')!.execute('edit', { path: 'same.txt', oldText: 'same', newText: 'changed' }, undefined, undefined, {} as never)).rejects.toThrow(/出现多次/);
    expect(await fs.readFile(path.join(f.projectPath, 'same.txt'), 'utf8')).toBe('same same');
    await fs.writeFile(path.join(f.projectPath, 'overlap.txt'), 'aaa');
    await expect(tools.find(t => t.name === 'edit_file')!.execute('overlap', { path: 'overlap.txt', oldText: 'aa', newText: 'changed' }, undefined, undefined, {} as never)).rejects.toThrow(/出现多次/);
    expect(await fs.readFile(path.join(f.projectPath, 'overlap.txt'), 'utf8')).toBe('aaa');
    await expect(fs.stat(path.join(f.projectPath, 'bad.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('budgets model output while retaining the full page for the UI and emits changes', async () => {
    const f = await fixture(); const events: unknown[] = []; let starts = 0;
    const tools = createWorkspaceTools({ ...f, maxResultChars: 400, emit: e => events.push(e), requestApproval: async () => true, beforeTool: () => { starts++; } });
    const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}: 中文内容${'x'.repeat(50)}`).join('\n');
    await fs.writeFile(path.join(f.projectPath, 'long.ts'), content);
    const response = await tools.find(t => t.name === 'read_file')!.execute('read', { path: 'long.ts', maxLines: 200 }, undefined, undefined, {} as never);
    expect((response.content[0] as { text: string }).text.length).toBeLessThanOrEqual(400);
    expect((response.content[0] as { text: string }).text).toContain('截断');
    expect((response.details as { fullOutput: string }).fullOutput).toContain('下一页从 201 行');
    await tools.find(t => t.name === 'write_file')!.execute('write', { path: 'created.ts', content: '中文' }, undefined, undefined, {} as never);
    expect(starts).toBe(2); expect(events).toEqual([{ type: 'changes_updated', runId: f.runId, sessionId: f.sessionId }]);
  });
});

describe('authorized external resources and read-only attachments', () => {
  it('asks for external writes and independently journals same-named external and project files', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.outside, 'same.txt'), 'outside original'); await fs.writeFile(path.join(f.projectPath, 'same.txt'), 'project original');
    await fs.mkdir(f.dataDir, { recursive: true });
    await beginRunChanges(f.dataDir, f.sessionId, f.runId, f.projectPath);
    const approvals: any[] = []; const tools = createWorkspaceTools({ ...f, approvalMode: 'auto', maxResultChars: 1000, emit: () => {}, requestApproval: async a => { approvals.push(a); return true; } });
    const write = tools.find(t => t.name === 'write_file')!;
    await write.execute('external', { path: path.join(f.outside, 'same.txt'), content: 'outside agent' }, undefined, undefined, {} as never);
    await write.execute('project', { path: 'same.txt', content: 'project agent' }, undefined, undefined, {} as never);
    expect(approvals).toHaveLength(1); expect(approvals[0]).toMatchObject({ kind: 'write', resource: path.join(f.outside, 'same.txt'), toolCallId: 'external' });
    const changes = await getChanges(f.dataDir, f.sessionId); expect(changes).toHaveLength(2);
    expect(changes.find(c => path.isAbsolute(c.path))).toMatchObject({ before: 'outside original', after: 'outside agent', conflict: false });
    const summary = await finishRunChanges(f.dataDir, f.sessionId, f.runId, f.projectPath);
    const external = summary.changes.find(c => path.isAbsolute(c.path)); expect(external).toMatchObject({ kind: 'modified' }); expect(external?.conflict).toBeFalsy();
    await undoChange(f.dataDir, f.sessionId, path.join(f.outside, 'same.txt'));
    expect(await fs.readFile(path.join(f.outside, 'same.txt'), 'utf8')).toBe('outside original');
    expect(await fs.readFile(path.join(f.projectPath, 'same.txt'), 'utf8')).toBe('project agent');
    await expect(undoChange(f.dataDir, f.sessionId, path.join(f.outside, 'unknown.txt'))).rejects.toThrow('没有找到');
  });
  it('denies an external write before changing files and full access avoids prompts', async () => {
    const f = await fixture(); const target = path.join(f.outside, 'new.txt'); let calls = 0;
    const denied = createWorkspaceTools({ ...f, maxResultChars: 500, emit: () => {}, requestApproval: async () => { calls++; return false; } }).find(t => t.name === 'write_file')!;
    await expect(denied.execute('denied', { path: target, content: 'bad' }, undefined, undefined, {} as never)).rejects.toThrow('拒绝'); expect(calls).toBe(1);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const allowed = createWorkspaceTools({ ...f, approvalMode: 'full', maxResultChars: 500, emit: () => {}, requestApproval: async () => { throw new Error('must not ask'); } }).find(t => t.name === 'write_file')!;
    await allowed.execute('allowed', { path: target, content: 'ok' }, undefined, undefined, {} as never); expect(await fs.readFile(target, 'utf8')).toBe('ok');
  });
  it('reads projectless attachments but exposes no mutation tools and rejects attachment escapes', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.outside, 'reference.txt'), 'reference material');
    const attachments = [{ id: 'folder', name: 'reference', kind: 'folder' as const, size: 0, storagePath: f.outside }];
    const ctx = { ...f, projectPath: '', attachments, maxResultChars: 1000, emit: () => {}, requestApproval: async () => { throw new Error('attachment must not ask'); } };
    const tools = createWorkspaceTools(ctx); expect(tools.some(t => ['write_file', 'edit_file', 'powershell'].includes(t.name))).toBe(false);
    const read = tools.find(t => t.name === 'read_file')!;
    const output = await read.execute('read', { path: 'attachment:folder/reference.txt' }, undefined, undefined, {} as never); expect(JSON.stringify(output)).toContain('reference material');
    await expect(read.execute('escape', { path: 'attachment:folder/../project/a.txt' }, undefined, undefined, {} as never)).rejects.toThrow('路径穿越');
    await expect(read.execute('absolute', { path: path.join(f.outside, 'reference.txt') }, undefined, undefined, {} as never)).rejects.toThrow('未指定工作区');
    const full = createWorkspaceTools({ ...ctx, projectPath: f.projectPath, approvalMode: 'full' });
    for (const pathname of ['attachment:folder/reference.txt', path.join(f.outside, 'reference.txt')]) await expect(full.find(t => t.name === 'write_file')!.execute('write', { path: pathname, content: 'bad' }, undefined, undefined, {} as never)).rejects.toThrow('只读');
  });
  it('keeps private app data inaccessible even in full access and omits writes in plan mode', async () => {
    const f = await fixture(); const dataDir = path.join(f.projectPath, 'private-data'); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'key.txt'), 'private-secret');
    const ctx = { ...f, dataDir, approvalMode: 'full' as const, maxResultChars: 1000, emit: () => {}, requestApproval: async () => true };
    const tools = createWorkspaceTools(ctx); const read = tools.find(t => t.name === 'read_file')!;
    await expect(read.execute('private', { path: 'private-data/key.txt' }, undefined, undefined, {} as never)).rejects.toThrow('私有数据');
    const search = await tools.find(t => t.name === 'search')!.execute('search', { query: 'private-secret' }, undefined, undefined, {} as never); expect(JSON.stringify(search)).not.toContain('private-secret');
    const plan = createWorkspaceTools({ ...ctx, workMode: 'plan' }); expect(plan.some(t => ['write_file', 'edit_file', 'powershell'].includes(t.name))).toBe(false); expect(plan.some(t => t.name === 'ask_question')).toBe(true); expect(plan.some(t => t.name === 'propose_plan')).toBe(true);
  });
});
