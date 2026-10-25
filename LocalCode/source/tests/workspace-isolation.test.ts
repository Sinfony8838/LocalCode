import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceContext, pathKey, WorkspaceAccessError } from '../src/core/workspace-context';
import { getChanges, getRunToolChanges, listWorkspaceFiles, readWorkspaceText, writeWorkspaceText, undoChange, previewChangeCheckpoint, checkpointChange, resolveWorkspacePath } from '../src/core/workspace';
import { ArtifactPreviews } from '../src/core/artifacts';
import { beginRunChanges, finishRunChanges, recoverRunChanges } from '../src/core/run-changes';
import { createWorkspaceTools } from '../src/agent/tools';
import { Store } from '../src/main/store';

const base = path.resolve('tests');
const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('.workspace-isolation-')) throw new Error('Unexpected cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(base, '.workspace-isolation-')); roots.push(root);
  const projectPath = path.join(root, '中文 project');
  const dataDir = path.join(projectPath, 'app-home', 'data');
  const ctx = workspaceContext(projectPath, dataDir);
  for (const folder of ctx.protectedRoots) { await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'private.txt'), 'PRIVATE_SESSION_CONTENT'); }
  await fs.writeFile(path.join(projectPath, 'code.ps1'), 'original');
  const write = (relativePath: string, content: string, sessionId = 'session-a', runId = 'run-a') => writeWorkspaceText({ ...ctx, sessionId, runId, relativePath, content });
  const journal = (id = 'session-a') => path.join(dataDir, 'changes', id, 'index.json');
  return { ...ctx, root, write, journal };
}
function tools(ctx: Awaited<ReturnType<typeof fixture>>) {
  return createWorkspaceTools({ ...ctx, sessionId: 'session-a', runId: 'run-a', maxResultChars: 5000, emit: () => {}, requestApproval: async () => true });
}
async function call(f: Awaited<ReturnType<typeof fixture>>, name: string, args: unknown) {
  return tools(f).find(tool => tool.name === name)!.execute('test-call', args, undefined, undefined, {} as never);
}

describe('application directories are excluded from all workspace capabilities', () => {
  it.each(['data', 'cache', 'logs'])('rejects direct %s reads, writes, edits, listings and searches before content I/O', async folder => {
    const f = await fixture();
    const relative = `app-home/${folder}/private.txt`;
    const read = vi.spyOn(fs, 'readFile'); const write = vi.spyOn(fs, 'writeFile'); const list = vi.spyOn(fs, 'readdir');
    for (const [name, args] of [
      ['read_file', { path: relative }], ['write_file', { path: relative, content: 'BAD' }],
      ['edit_file', { path: relative, oldText: 'PRIVATE', newText: 'BAD' }],
      ['list_files', { path: `app-home/${folder}` }], ['search', { path: `app-home/${folder}`, query: 'PRIVATE' }],
      ['write_file', { path: `app-home/${folder}/missing/deep.txt`, content: 'BAD' }],
    ] as const) await expect(call(f, name, args)).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });

  it('omits protected entries and content from recursive discovery and snapshots but allows sibling prefixes', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.projectPath, 'app-home', 'data-other'));
    await fs.writeFile(path.join(f.projectPath, 'app-home', 'data-other', 'normal.txt'), 'ordinary');
    expect((await listWorkspaceFiles(f, 'app-home')).map(entry => entry.name)).toEqual(['data-other']);
    const read = vi.spyOn(fs, 'readFile');
    const search = await call(f, 'search', { query: 'PRIVATE' }); expect(JSON.stringify(search)).not.toContain('PRIVATE_SESSION_CONTENT');
    await beginRunChanges(f, 'session-a', 'run-a');
    const reads = read.mock.calls.map(args => String(args[0]));
    expect(reads.some(file => file.endsWith('private.txt'))).toBe(false);
    const baseline = JSON.parse(await fs.readFile(path.join(f.dataDir, 'changes/session-a/runs/run-a.json'), 'utf8'));
    expect(baseline.files).toEqual({ 'app-home/data-other/normal.txt': 'ordinary', 'code.ps1': 'original' });
  });

  it('rejects protected junctions, file hard links and dangling new-file parents', async () => {
    const f = await fixture();
    await fs.symlink(f.dataDir, path.join(f.projectPath, 'alias'), 'junction');
    await fs.link(path.join(f.dataDir, 'private.txt'), path.join(f.projectPath, 'hard.txt'));
    await fs.symlink(path.join(f.dataDir, 'missing'), path.join(f.projectPath, 'dangling'), 'junction');
    const read = vi.spyOn(fs, 'readFile'); const write = vi.spyOn(fs, 'writeFile');
    for (const relative of ['alias/private.txt', 'hard.txt']) {
      await expect(readWorkspaceText(f, relative)).rejects.toBeInstanceOf(WorkspaceAccessError);
      await expect(f.write(relative, 'BAD')).rejects.toBeInstanceOf(WorkspaceAccessError);
    }
    await expect(f.write('dangling/new.txt', 'BAD')).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect((await listWorkspaceFiles(f)).map(entry => entry.name)).toEqual(['app-home', 'code.ps1']);
  });

  it('keeps protected previews unavailable, including an alias swapped after a grant', async () => {
    const f = await fixture(); const previews = new ArtifactPreviews();
    await fs.writeFile(path.join(f.dataDir, 'private.html'), '<h1>PRIVATE</h1>');
    await expect(previews.info(f, 'app-home/data/private.html')).rejects.toBeInstanceOf(WorkspaceAccessError);
    const assets = path.join(f.projectPath, 'assets'); await fs.mkdir(assets); await fs.writeFile(path.join(assets, 'private.html'), 'safe');
    const info = await previews.info(f, 'assets/private.html');
    await fs.unlink(path.join(assets, 'private.html')); await fs.rmdir(assets); await fs.symlink(f.dataDir, assets, 'junction');
    const read = vi.spyOn(fs, 'open');
    expect((await previews.response({ url: info.previewUrl!, method: 'GET' })).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('requires complete context and rejects protected project roots and root replacement', async () => {
    const f = await fixture();
    await expect(readWorkspaceText({ ...f, protectedRoots: [] }, 'code.ps1')).rejects.toBeInstanceOf(WorkspaceAccessError);
    for (const folder of [f.dataDir, path.join(f.dataDir, 'sessions'), path.dirname(f.protectedRoots[1]) + '/cache']) {
      await fs.mkdir(folder, { recursive: true });
      await expect(resolveWorkspacePath(workspaceContext(folder, f.dataDir), '', { directory: true })).rejects.toBeInstanceOf(WorkspaceAccessError);
    }
    const outside = path.join(f.root, 'other-project'); await fs.mkdir(outside);
    const linked = path.join(f.root, 'root-link'); await fs.symlink(outside, linked, 'junction');
    await expect(resolveWorkspacePath(workspaceContext(linked, f.dataDir), '', { directory: true })).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it.skipIf(process.platform !== 'win32')('applies Windows case rules and extended path spellings consistently', async () => {
    const f = await fixture();
    await expect(readWorkspaceText(f, 'APP-HOME/DATA/private.txt')).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(pathKey('\\\\?\\' + f.projectPath)).toBe(pathKey(f.projectPath));
  });
});

describe('journal operations use only registered project ownership', () => {
  it.each(['records', 'runRecords', 'checkpoints'])('rejects foreign project paths in %s before target reads and preserves journal bytes', async section => {
    const f = await fixture(); await f.write('code.ps1', 'agent');
    await fs.writeFile(path.join(f.projectPath, 'code.ps1'), 'manual');
    const preview = await previewChangeCheckpoint(f, 'session-a', 'code.ps1');
    const value = JSON.parse(await fs.readFile(f.journal(), 'utf8'));
    const foreign = { ...value.records[0], projectPath: f.dataDir, path: 'private.txt' };
    if (section === 'checkpoints') value.checkpoints = [{ id: 'fixture', approvedAt: 'fixture', previous: foreign, approved: '', approvedHash: sha('') }];
    else value[section][0] = foreign;
    const before = JSON.stringify(value); await fs.writeFile(f.journal(), before);
    const read = vi.spyOn(fs, 'readFile'); const write = vi.spyOn(fs, 'writeFile'); const remove = vi.spyOn(fs, 'unlink'); const rename = vi.spyOn(fs, 'rename');
    for (const operation of [
      () => getChanges(f, 'session-a'), () => undoChange(f, 'session-a', 'code.ps1'),
      () => previewChangeCheckpoint(f, 'session-a', 'code.ps1'),
      () => checkpointChange(f, 'session-a', 'code.ps1', preview.currentHash, preview.recordHash),
      () => getRunToolChanges(f, 'session-a', 'run-a'), () => f.write('code.ps1', 'BAD'),
    ]) await expect(operation()).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(read.mock.calls.every(args => pathKey(String(args[0])) === pathKey(f.journal()))).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
    expect((await recoverRunChanges(f, 'session-a', 'run-a')).changesError).toContain('未知');
    expect(await fs.readFile(f.journal(), 'utf8')).toBe(before);
  });

  it('rejects protected/traversal paths even when the saved project root is correct', async () => {
    const f = await fixture(); await f.write('code.ps1', 'agent');
    const journal = JSON.parse(await fs.readFile(f.journal(), 'utf8'));
    for (const relative of ['app-home/data/private.txt', '../outside.txt']) {
      journal.records[0].path = relative; await fs.writeFile(f.journal(), JSON.stringify(journal));
      const read = vi.spyOn(fs, 'readFile');
      await expect(getChanges(f, 'session-a')).rejects.toBeInstanceOf(WorkspaceAccessError);
      expect(read.mock.calls).toHaveLength(1); read.mockRestore();
    }
  });

  it('keeps sessions independent across writes, undo, checkpoints and restart', async () => {
    const f = await fixture(); const store = new Store(f.dataDir); await store.init();
    const project = await store.addProject(f.projectPath);
    const a = await store.createSession(project.id); const b = await store.createSession(project.id);
    await f.write('a.ps1', 'a', a.id, 'round-a'); await f.write('b.ps1', 'b', b.id, 'round-b');
    const bBytes = await fs.readFile(f.journal(b.id));
    await fs.writeFile(path.join(f.projectPath, 'a.ps1'), 'manual-a');
    const preview = await previewChangeCheckpoint(store.sessionWorkspace(a.id), a.id, 'a.ps1');
    await checkpointChange(store.sessionWorkspace(a.id), a.id, 'a.ps1', preview.currentHash, preview.recordHash);
    await f.write('a.ps1', 'next-a', a.id, 'round-a2'); await undoChange(store.sessionWorkspace(a.id), a.id, 'a.ps1');
    expect(await fs.readFile(path.join(f.projectPath, 'a.ps1'), 'utf8')).toBe('manual-a');
    expect(await fs.readFile(f.journal(b.id))).toEqual(bBytes);
    const reopened = new Store(f.dataDir); await reopened.init();
    expect(await getChanges(reopened.sessionWorkspace(b.id), b.id)).toEqual([expect.objectContaining({ path: 'b.ps1', after: 'b' })]);
    await undoChange(reopened.sessionWorkspace(b.id), b.id, 'b.ps1');
    await expect(fs.stat(path.join(f.projectPath, 'b.ps1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses new protected projects and legacy unsafe tasks without deleting history', async () => {
    const f = await fixture(); const store = new Store(f.dataDir); await store.init();
    await expect(store.addProject(f.dataDir)).rejects.toBeInstanceOf(WorkspaceAccessError);
    const alias = path.join(f.root, 'data-alias'); await fs.symlink(f.dataDir, alias, 'junction');
    await expect(store.addProject(alias)).rejects.toBeInstanceOf(WorkspaceAccessError);
    const project = await store.addProject(f.projectPath); const session = await store.createSession(project.id);
    const state = JSON.parse(await fs.readFile(store.indexFile, 'utf8')); state.projects[0].path = f.dataDir;
    state.sessions[0].messages.push({ id: 'old', role: 'user', text: 'legacy retained', createdAt: 'fixture' });
    await fs.writeFile(store.indexFile, JSON.stringify(state));
    const reopened = new Store(f.dataDir); await reopened.init(); const before = structuredClone(reopened.session(session.id));
    await expect(reopened.beginRun(session.id, 'must not run', 'local')).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(reopened.session(session.id)).toEqual(before);
    expect(reopened.sessions()[0].messages[0].text).toBe('legacy retained');
  });

  it('never scans a protected root during settlement', async () => {
    const f = await fixture(); const read = vi.spyOn(fs, 'readFile'); const list = vi.spyOn(fs, 'readdir');
    const summary = await finishRunChanges(workspaceContext(f.dataDir, f.dataDir), 'session-a', 'run-a');
    expect(summary.changesError).toContain('未知'); expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });

  it('rejects per-session journal aliases without reading or changing the other session', async () => {
    const f = await fixture(); await f.write('a.ps1', 'a'); await f.write('b.ps1', 'b', 'session-b', 'run-b');
    const saved = await fs.readFile(f.journal('session-b'));
    const alias = path.join(f.dataDir, 'changes', 'session-a');
    await fs.unlink(f.journal()); await fs.rmdir(alias);
    await fs.symlink(path.join(f.dataDir, 'changes/session-b'), alias, 'junction');
    const read = vi.spyOn(fs, 'readFile');
    await expect(getChanges(f, 'session-a')).rejects.toBeInstanceOf(WorkspaceAccessError);
    await expect(f.write('a.ps1', 'BAD')).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(read).not.toHaveBeenCalled();
    expect(await fs.readFile(f.journal('session-b'))).toEqual(saved);
  });

  it('rechecks a checkpoint target swapped into protected data after preview', async () => {
    const f = await fixture(); const nested = path.join(f.projectPath, 'nested'); await fs.mkdir(nested);
    await f.write('nested/code.ps1', 'agent'); await fs.writeFile(path.join(nested, 'code.ps1'), 'manual');
    const preview = await previewChangeCheckpoint(f, 'session-a', 'nested/code.ps1');
    const journal = await fs.readFile(f.journal()); await fs.writeFile(path.join(f.dataDir, 'code.ps1'), 'manual');
    await fs.unlink(path.join(nested, 'code.ps1')); await fs.rmdir(nested); await fs.symlink(f.dataDir, nested, 'junction');
    const read = vi.spyOn(fs, 'readFile'); const write = vi.spyOn(fs, 'writeFile');
    await expect(checkpointChange(f, 'session-a', 'nested/code.ps1', preview.currentHash, preview.recordHash)).rejects.toBeInstanceOf(WorkspaceAccessError);
    expect(read.mock.calls.every(args => pathKey(String(args[0])) === pathKey(f.journal()))).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(await fs.readFile(f.journal())).toEqual(journal);
  });
});
