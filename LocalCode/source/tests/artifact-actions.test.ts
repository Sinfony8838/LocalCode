import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const native = vi.hoisted(() => ({ openPath: vi.fn(), reveal: vi.fn(), clipboard: vi.fn(), spawn: vi.fn() }));
vi.mock('electron', () => ({ shell: { openPath: native.openPath, showItemInFolder: native.reveal }, clipboard: { writeText: native.clipboard } }));
vi.mock('node:child_process', () => ({ spawn: native.spawn }));
import { ArtifactController } from '../src/main/artifacts';

const base = path.resolve('tests');
const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); native.openPath.mockResolvedValue(''); });
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('.artifact-actions-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const project = await fs.mkdtemp(path.join(base, '.artifact-actions-')); roots.push(project);
  const filename = 'sample;$(echo injected).html'; const absolute = path.join(project, filename);
  await fs.writeFile(absolute, '<h1>hello</h1>');
  return { project, context: workspaceContext(project, path.join(project, 'app-private', 'data')), filename, absolute, artifacts: new ArtifactController() };
}

describe('native artifact actions', () => {
  it('passes validated absolute filenames directly to open/reveal/clipboard', async () => {
    const f = await fixture();
    await f.artifacts.action(f.context, f.filename, 'open');
    await f.artifacts.action(f.context, f.filename, 'reveal');
    await f.artifacts.action(f.context, f.filename, 'copy-path');
    expect(native.openPath).toHaveBeenCalledExactlyOnceWith(f.absolute);
    expect(native.reveal).toHaveBeenCalledExactlyOnceWith(f.absolute);
    expect(native.clipboard).toHaveBeenCalledExactlyOnceWith(f.absolute);
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it('preserves literal percent names across metadata, menu actions and repeated open validation', async () => {
    const f = await fixture();
    for (const name of ['report%20final.txt', 'report final.txt', 'notes.txt#L12', 'notes.txt']) {
      const absolute = path.join(f.project, name); await fs.writeFile(absolute, name);
    }
    for (const name of ['report%20final.txt', 'report final.txt', 'notes.txt#L12']) {
      const absolute = path.join(f.project, name);
      const info = await f.artifacts.info(f.context, encodeURIComponent(name), 'reference');
      expect(info.path).toBe(name);
      for (const action of ['open', 'reveal', 'copy-path'] as const) {
        await f.artifacts.action(f.context, name, action);
        await f.artifacts.action(f.context, info.path, action);
        await f.artifacts.action(f.context, pathToFileURL(absolute).href, action, 'reference');
      }
      expect(native.openPath).toHaveBeenLastCalledWith(absolute);
      expect(native.reveal).toHaveBeenLastCalledWith(absolute);
      expect(native.clipboard).toHaveBeenLastCalledWith(absolute);
    }
    expect(native.openPath).toHaveBeenCalledTimes(9);
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')('opens Windows application chooser without constructing shell text', async () => {
    const f = await fixture();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    native.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    await f.artifacts.action(f.context, f.filename, 'choose-app');
    expect(native.spawn).toHaveBeenCalledExactlyOnceWith(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['shell32.dll,OpenAs_RunDLL', f.absolute], { shell: false, windowsHide: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it.skipIf(process.platform === 'win32')('rejects application chooser on unsupported systems without spawning', async () => {
    const f = await fixture();
    await expect(f.artifacts.action(f.context, f.filename, 'choose-app')).rejects.toThrow('Windows');
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it('does not execute an executable script or an outside path through shell defaults', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.project, 'unsafe.cmd'), '@echo off');
    await expect(f.artifacts.action(f.context, 'unsafe.cmd', 'open')).rejects.toThrow(/编辑器/);
    await expect(f.artifacts.action(f.context, '../outside.html', 'open')).rejects.toThrow();
    expect(native.openPath).not.toHaveBeenCalled(); expect(native.spawn).not.toHaveBeenCalled();
  });
  it('reports OS-open errors instead of claiming the file was opened', async () => {
    const f = await fixture(); native.openPath.mockResolvedValue('No associated app');
    await expect(f.artifacts.action(f.context, f.filename, 'open')).rejects.toThrow(/No associated app/);
  });
});
