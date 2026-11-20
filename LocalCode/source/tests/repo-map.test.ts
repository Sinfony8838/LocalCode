import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectRepoMap } from '../src/agent/engine.js';
import { workspaceContext } from '../src/core/workspace-context.js';

let project: string;
let dataDir: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-repomap-proj-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-repomap-data-'));
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true }).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('projectRepoMap', () => {
  it('summarizes two-level structure with root files, top dirs and subdirs', async () => {
    await fs.mkdir(path.join(project, 'src', 'agent'), { recursive: true });
    await fs.mkdir(path.join(project, 'src', 'core'), { recursive: true });
    await fs.mkdir(path.join(project, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(project, 'package.json'), '{}');
    await fs.writeFile(path.join(project, 'README.md'), '# hi');
    await fs.writeFile(path.join(project, 'src', 'engine.ts'), 'export {}');
    await fs.writeFile(path.join(project, 'src', 'tools.ts'), 'export {}');
    await fs.writeFile(path.join(project, 'src', 'agent', 'worker.ts'), 'export {}');
    await fs.writeFile(path.join(project, 'node_modules', 'junk.js'), 'x');
    const ctx = workspaceContext(await fs.realpath(project), await fs.realpath(dataDir));
    const map = await projectRepoMap(ctx);
    expect(map).toContain('<project-map');
    expect(map).toContain('package.json');
    expect(map).toContain('src/');
    expect(map).toContain('engine.ts');
    expect(map).toContain('agent/');
    expect(map).not.toContain('junk.js');
  });

  it('respects the character budget by trimming directory details', async () => {
    for (let i = 0; i < 40; i++) {
      await fs.mkdir(path.join(project, `dir${i}`), { recursive: true });
      await fs.writeFile(path.join(project, `dir${i}`, `file${i}.ts`), 'x');
      await fs.writeFile(path.join(project, `dir${i}`, `long-name-module-${i}-with-suffix.ts`), 'x');
    }
    const ctx = workspaceContext(await fs.realpath(project), await fs.realpath(dataDir));
    const map = await projectRepoMap(ctx, { budgetChars: 400 });
    expect(map.length).toBeLessThan(1400);
    expect(map).toContain('<project-map');
  });

  it('returns empty text without a project path and for empty projects', async () => {
    const noProject = workspaceContext('', await fs.realpath(dataDir));
    expect(await projectRepoMap(noProject)).toBe('');
    const empty = workspaceContext(await fs.realpath(project), await fs.realpath(dataDir));
    expect(await projectRepoMap(empty)).toBe('');
  });
});
