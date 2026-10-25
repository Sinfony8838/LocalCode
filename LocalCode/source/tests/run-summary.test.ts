import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/main/store';
import { getChanges, undoChange, writeWorkspaceText } from '../src/core/workspace';
import { reduceAgentEvent } from '../src/shared/session-events';
import type { AgentEvent } from '../src/shared/contracts';

const base = path.resolve('../cache/tests');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('run-summary-')) throw new Error('Unexpected cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

const baselinePath = (f: Awaited<ReturnType<typeof fixture>>, runId: string) => path.join(f.store.dataDir, 'changes', f.session.id, 'runs', `${runId}.json`);
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-summary-')); roots.push(root);
  const projectPath = path.join(root, 'project'); await fs.mkdir(projectPath);
  const store = new Store(path.join(root, 'data')); await store.init();
  const project = await store.addProject(projectPath); const session = await store.createSession(project.id);
  const begin = async () => {
    const started = await store.beginRun(session.id, '处理文件并验证', 'local');
    const identity = { sessionId: session.id, runId: started.runId! };
    const write = (relativePath: string, content: string) => writeWorkspaceText({ ...identity, projectPath, dataDir: store.dataDir, relativePath, content });
    const event = (body: Record<string, unknown>) => store.event({ ...identity, ...body } as AgentEvent);
    const finish = async (status: 'completed' | 'failed' | 'interrupted' = 'completed') => {
      const settled = await event({ type: 'settled', status });
      return { summary: store.session(session.id).runs!.at(-1)!, settled };
    };
    return { ...identity, write, event, finish };
  };
  return { root, projectPath, store, session, begin };
}

describe('whole-run completion boundaries', () => {
  it('never completes on copyable intermediate messages or tools and only associates a final post-tool message', async () => {
    const f = await fixture(); const run = await f.begin();
    await run.event({ type: 'message_start', messageId: 'stage' });
    await run.event({ type: 'message_end', messageId: 'stage', text: '我先查看文件。' });
    expect(f.store.session(f.session.id).runs![0].status).toBe('running');
    await run.event({ type: 'tool_start', toolCallId: 'write', name: 'write_file', args: {} });
    expect(f.store.session(f.session.id).runs![0].finalMessageId).toBeUndefined();
    await run.event({ type: 'tool_result', toolCallId: 'write', result: 'ok', isError: false });
    expect(f.store.session(f.session.id).runs![0].status).toBe('running');
    await run.event({ type: 'message_start', messageId: 'final' });
    await run.event({ type: 'message_end', messageId: 'final', text: '已完成修改，检查通过。' });
    expect(f.store.session(f.session.id).runs![0].status).toBe('running');
    const { summary, settled } = await run.finish();
    expect(summary).toMatchObject({ runId: run.runId, status: 'completed', finalMessageId: 'final', changes: [] });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(settled).toMatchObject({ type: 'settled', summary });
    expect(f.store.session(f.session.id).messages.every(message => message.runId === run.runId)).toBe(true);
  });

  it('does not promote pre-tool commentary to final prose when a run settles without a final assistant reply', async () => {
    const f = await fixture(); const run = await f.begin();
    await run.event({ type: 'message_end', messageId: 'stage', text: '现在执行检查。' });
    await run.event({ type: 'tool_start', toolCallId: 'check', name: 'powershell', args: {} });
    await run.event({ type: 'tool_result', toolCallId: 'check', result: 'ok', isError: false });
    expect((await run.finish()).summary.finalMessageId).toBeUndefined();
  });

  it.each(['failed', 'interrupted'] as const)('keeps %s distinct from completion and freezes duplicate or late events', async status => {
    const f = await fixture(); const run = await f.begin();
    await run.event({ type: 'message_end', messageId: 'stage', text: '准备执行。' });
    await run.write('partial.txt', '已写入的内容\n');
    const { summary } = await run.finish(status);
    expect(summary.status).toBe(status); expect(summary.finalMessageId).toBeUndefined();
    expect(summary.changes).toHaveLength(1);
    const before = structuredClone(f.store.session(f.session.id));
    await run.event({ type: 'settled', status: 'completed' });
    await run.event({ type: 'message_end', messageId: 'late', text: '不应追加' });
    expect(f.store.session(f.session.id)).toEqual(before);
    expect(reduceAgentEvent(before, { type: 'status', runId: run.runId, sessionId: f.session.id, status: 'running' })).toEqual(before);
  });
});

describe('per-run file evidence', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)('retires only the %s round snapshot after saving the summary and preserves undo', async status => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, 'dirty.txt'), 'original\n');
    const run = await f.begin(); const baseline = baselinePath(f, run.runId);
    await run.write('dirty.txt', 'changed\n');
    expect(JSON.parse(await fs.readFile(baseline, 'utf8')).files['dirty.txt']).toBe('original\n');
    const unlink = fs.unlink.bind(fs);
    const observed: string[] = [];
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === baseline) {
        const persisted = JSON.parse(await fs.readFile(f.store.indexFile, 'utf8'));
        expect(persisted.sessions[0].runs[0]).toMatchObject({ runId: run.runId, status, changes: [expect.objectContaining({ path: 'dirty.txt' })] });
        observed.push(String(file));
      }
      return unlink(file);
    });
    const { summary } = await run.finish(status);
    expect(observed).toEqual([baseline]);
    await expect(fs.access(baseline)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await getChanges(f.store.dataDir, f.session.id)).toEqual([expect.objectContaining({ path: 'dirty.txt', before: 'original\n', after: 'changed\n' })]);
    await undoChange(f.store.dataDir, f.session.id, 'dirty.txt');
    expect(await fs.readFile(path.join(f.projectPath, 'dirty.txt'), 'utf8')).toBe('original\n');
    const reopened = new Store(f.store.dataDir); await reopened.init();
    expect(reopened.session(f.session.id).runs![0]).toEqual(summary);
  });

  it('retains the baseline when summary persistence fails and cleans it only after a successful retry', async () => {
    const f = await fixture(); const run = await f.begin();
    await run.write('tool.txt', 'saved\n');
    const baseline = baselinePath(f, run.runId);
    const rename = fs.rename.bind(fs);
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === f.store.indexFile) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
      return rename(from, to);
    });
    await expect(run.finish()).rejects.toThrow('simulated disk failure');
    await expect(fs.access(baseline)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(f.store.indexFile, 'utf8')).sessions[0].runs[0].status).toBe('running');
    fail.mockRestore();
    await f.store.persist();
    expect(JSON.parse(await fs.readFile(f.store.indexFile, 'utf8')).sessions[0].runs[0].status).toBe('completed');
    await expect(fs.access(baseline)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains interrupted recovery evidence until its index is saved and retries leftover cleanup after restart', async () => {
    const f = await fixture(); const run = await f.begin(); await run.write('known.txt', 'known\n');
    const baseline = baselinePath(f, run.runId);
    const rename = fs.rename.bind(fs);
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === f.store.indexFile) throw Object.assign(new Error('recovery write failed'), { code: 'EIO' });
      return rename(from, to);
    });
    await expect(new Store(f.store.dataDir).init()).rejects.toThrow('recovery write failed');
    await expect(fs.access(baseline)).resolves.toBeUndefined();
    fail.mockRestore();
    const unlink = fs.unlink.bind(fs);
    const blockedCleanup = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === baseline) throw Object.assign(new Error('scanner holds baseline'), { code: 'EBUSY' });
      return unlink(file);
    });
    const recovered = new Store(f.store.dataDir); await recovered.init();
    const summary = recovered.session(f.session.id).runs![0];
    expect(summary.status).toBe('interrupted');
    expect(summary.changes).toEqual([expect.objectContaining({ path: 'known.txt' })]);
    await expect(fs.access(baseline)).resolves.toBeUndefined();
    blockedCleanup.mockRestore();
    const reopened = new Store(f.store.dataDir); await reopened.init();
    expect(reopened.session(f.session.id).runs![0]).toEqual(summary);
    await expect(fs.access(baseline)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await getChanges(f.store.dataDir, f.session.id)).toHaveLength(1);
  });

  it('retires replaced rounds without deleting the new active baseline or either tool journal', async () => {
    const f = await fixture(); const first = await f.begin(); await first.write('first.txt', 'first\n');
    const second = await f.begin();
    expect(f.store.session(f.session.id).runs![0].status).toBe('interrupted');
    await expect(fs.access(baselinePath(f, first.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(baselinePath(f, second.runId))).resolves.toBeUndefined();
    const unrelated = path.join(f.store.dataDir, 'changes', f.session.id, 'runs', 'unknown-run.json');
    await fs.writeFile(unrelated, 'unsettled evidence');
    await second.finish();
    await expect(fs.access(baselinePath(f, second.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('unsettled evidence');
    await undoChange(f.store.dataDir, f.session.id, 'first.txt');
    await expect(fs.access(path.join(f.projectPath, 'first.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains tool baselines for existing files outside automatic scan scope and excludes their net-zero edits', async () => {
    const f = await fixture();
    const excluded = ['.env', 'dist/compiled.txt', 'node_modules/dependency.txt', '.aws/credentials'];
    for (const relative of excluded) {
      await fs.mkdir(path.dirname(path.join(f.projectPath, relative)), { recursive: true });
      await fs.writeFile(path.join(f.projectPath, relative), 'original\n');
    }
    const unchanged = await f.begin();
    for (const relative of excluded) { await unchanged.write(relative, 'temporary\n'); await unchanged.write(relative, 'original\n'); }
    expect((await unchanged.finish()).summary.changes).toEqual([]);
    const modified = await f.begin();
    for (const relative of excluded) await modified.write(relative, 'updated\n');
    const { summary } = await modified.finish();
    expect(summary.changes).toHaveLength(excluded.length);
    expect(summary.changes.every(change => change.kind === 'modified' && change.additions === 1 && change.deletions === 1)).toBe(true);
    expect(summary.changes.map(change => change.path).sort()).toEqual(excluded.sort());
  });

  it.skipIf(process.platform !== 'win32')('treats case variants as one Windows file across snapshots, tool journals, rounds, and undo', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, 'Readme.md'), 'original\n');
    const first = await f.begin();
    await first.write('README.md', 'original\nsecond\n');
    await first.write('readme.MD', 'original\nsecond\nthird\n');
    await first.write('New.txt', 'first\n'); await first.write('NEW.TXT', 'final\n');
    const firstSummary = (await first.finish()).summary;
    expect(firstSummary.changes).toHaveLength(2);
    expect(firstSummary.changes.find(change => change.path.toLowerCase() === 'readme.md')).toMatchObject({ kind: 'modified', additions: 2, deletions: 0 });
    expect(firstSummary.changes.find(change => change.path.toLowerCase() === 'new.txt')).toMatchObject({ kind: 'created', additions: 1, deletions: 0 });
    expect(await getChanges(f.store.dataDir, f.session.id)).toHaveLength(2);
    const second = await f.begin(); await second.write('rEaDmE.mD', 'original\nsecond\nthird\nfourth\n');
    expect((await second.finish()).summary.changes).toEqual([expect.objectContaining({ kind: 'modified', additions: 1, deletions: 0 })]);
    expect(f.store.session(f.session.id).runs![0]).toEqual(firstSummary);
    await undoChange(f.store.dataDir, f.session.id, 'rEaDmE.Md');
    expect(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8')).toBe('original\n');
    await undoChange(f.store.dataDir, f.session.id, 'new.TXT');
    await expect(fs.stat(path.join(f.projectPath, 'NEW.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await getChanges(f.store.dataDir, f.session.id)).toEqual([]);
  });

  it('deduplicates repeated writes and compares the next round to its own starting bytes without changing cumulative undo', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.projectPath, 'dirty.txt'), '用户未提交的内容\n');
    const first = await f.begin();
    await first.write('dirty.txt', 'first\n'); await first.write('dirty.txt', 'first\nsecond\n');
    await first.write('new.html', '<h1>hello</h1>\n');
    const original = (await first.finish()).summary;
    expect(original.changes).toHaveLength(2);
    expect(original.changes.find(change => change.path === 'dirty.txt')).toMatchObject({ kind: 'modified', additions: 2, deletions: 1 });
    const second = await f.begin();
    await second.write('dirty.txt', 'first\nsecond\nthird\n');
    const next = (await second.finish()).summary;
    expect(next.changes).toEqual([expect.objectContaining({ path: 'dirty.txt', kind: 'modified', additions: 1, deletions: 0 })]);
    expect(f.store.session(f.session.id).runs![0]).toEqual(original);
    expect((await getChanges(f.store.dataDir, f.session.id)).find(change => change.path === 'dirty.txt')?.before).toBe('用户未提交的内容\n');
    const reopened = new Store(f.store.dataDir); await reopened.init();
    expect(reopened.session(f.session.id).runs).toEqual([original, next]);
  });

  it('includes terminal-style creations/modifications/deletions and excludes net-zero writes and ignored files', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.projectPath, 'keep.txt'), 'one\n');
    await fs.writeFile(path.join(f.projectPath, 'delete.txt'), 'gone\n');
    await fs.writeFile(path.join(f.projectPath, '.env'), 'secret');
    await fs.mkdir(path.join(f.projectPath, 'node_modules')); await fs.writeFile(path.join(f.projectPath, 'node_modules', 'ignored.txt'), 'old');
    const run = await f.begin();
    await run.write('keep.txt', 'two\n'); await run.write('keep.txt', 'one\n');
    await fs.unlink(path.join(f.projectPath, 'delete.txt'));
    await fs.writeFile(path.join(f.projectPath, 'command.html'), '<p>created by command</p>\n');
    await fs.writeFile(path.join(f.projectPath, '.env'), 'changed secret');
    await fs.writeFile(path.join(f.projectPath, 'node_modules', 'ignored.txt'), 'new');
    const { summary } = await run.finish();
    expect(summary.changeScope).toBe('workspace_snapshot');
    expect(summary.changes).toEqual([
      expect.objectContaining({ path: 'command.html', kind: 'created', source: 'workspace', additions: 1 }),
      expect.objectContaining({ path: 'delete.txt', kind: 'deleted', source: 'workspace', deletions: 1 }),
    ]);
    expect(summary.coverageNote).toContain('外部编辑');
  });

  it('does not falsely call preexisting binary files new after replacement and records only bounded known evidence', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, 'binary.dat'), Buffer.from([0, 1, 2]));
    const run = await f.begin(); await fs.writeFile(path.join(f.projectPath, 'binary.dat'), 'now text');
    const { summary } = await run.finish();
    expect(summary.changes).toEqual([]); expect(summary.changesError).toBeUndefined();
    expect(summary.coverageNote).toContain('统计范围');
  });

  it('excludes ordinary images without warning while preserving failed reads of previously tracked text', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.projectPath, 'image.png'), Buffer.from([137, 80, 78, 71, 0]));
    await fs.writeFile(path.join(f.projectPath, 'tracked.txt'), 'known text\n');
    const first = await f.begin();
    const unchanged = (await first.finish()).summary;
    expect(unchanged.changes).toEqual([]); expect(unchanged.changesError).toBeUndefined();
    const second = await f.begin();
    await fs.writeFile(path.join(f.projectPath, 'tracked.txt'), Buffer.from([0, 1, 2]));
    const unreadable = (await second.finish()).summary;
    expect(unreadable.changesError).toContain('无法读取');
  });

  it('keeps terminal-created then tool-edited files created and uses the run baseline for terminal edits followed by tool no-ops', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.projectPath, 'existing.txt'), 'baseline\n');
    const run = await f.begin();
    await fs.writeFile(path.join(f.projectPath, 'created.html'), '<p>terminal</p>\n');
    await run.write('created.html', '<p>tool</p>\n<p>final</p>\n');
    await fs.writeFile(path.join(f.projectPath, 'existing.txt'), 'terminal\n');
    await run.write('existing.txt', 'temporary\n'); await run.write('existing.txt', 'terminal\n');
    const { summary } = await run.finish();
    expect(summary.changes).toEqual([
      expect.objectContaining({ path: 'created.html', kind: 'created', additions: 2, deletions: 0 }),
      expect.objectContaining({ path: 'existing.txt', kind: 'modified', additions: 1, deletions: 1 }),
    ]);
  });

  it('reports unavailable baseline explicitly and still preserves exact file tool edits', async () => {
    const f = await fixture(); const run = await f.begin();
    await run.write('tool.txt', 'kept\n');
    const snapshot = path.join(f.store.dataDir, 'changes', f.session.id, 'runs', run.runId + '.json');
    await fs.writeFile(snapshot, '{corrupt');
    const { summary } = await run.finish();
    expect(summary.changeScope).toBe('file_tools'); expect(summary.changesError).toContain('快照不可用');
    expect(summary.changes).toEqual([expect.objectContaining({ path: 'tool.txt', kind: 'created', additions: 1 })]);
  });

  it('recovers an active round as interrupted without fabricating completion or scanning post-crash edits', async () => {
    const f = await fixture(); const run = await f.begin(); await run.write('known.txt', 'known\n');
    await run.event({ type: 'message_end', messageId: 'stage', text: '仍在工作。' });
    await fs.writeFile(path.join(f.projectPath, 'after-crash.txt'), 'not this run');
    const recovered = new Store(f.store.dataDir); await recovered.init();
    const summary = recovered.session(f.session.id).runs![0];
    expect(summary.status).toBe('interrupted'); expect(summary.finalMessageId).toBeUndefined();
    expect(summary.changes.map(change => change.path)).toEqual(['known.txt']); expect(summary.coverageNote).toContain('未确认');
  });

  it('leaves legacy history without invented round summaries', async () => {
    const f = await fixture();
    const legacy = JSON.parse(await fs.readFile(f.store.indexFile, 'utf8'));
    legacy.sessions[0].status = 'completed';
    legacy.sessions[0].messages = [{ id: 'legacy', role: 'assistant', text: '旧回复', createdAt: new Date().toISOString() }];
    delete legacy.sessions[0].runs;
    await fs.writeFile(f.store.indexFile, JSON.stringify(legacy));
    const reopened = new Store(f.store.dataDir); await reopened.init();
    expect(reopened.session(f.session.id).runs).toBeUndefined();
    expect(reopened.session(f.session.id).messages[0].text).toBe('旧回复');
  });
});
