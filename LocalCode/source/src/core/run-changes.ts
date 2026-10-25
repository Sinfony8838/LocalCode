import { workspaceBoundary, privateStoragePath, isWorkspaceAccessError, type WorkspaceContext } from './workspace-context.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import type { RunFileChange, RunSummary } from '../shared/contracts.js';
import { getRunToolChanges, MAX_FILE_BYTES, normalizeRelative, readWorkspaceText, resolveWorkspacePath, workspacePathKey } from './workspace.js';

const MAX_FILES = 1000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORIES = 300;
const ignored = new Set(['.git', '.aws', '.ssh', '.codex', '.agents', 'node_modules', '.next', '.venv', 'venv', 'dist', 'build', 'coverage', 'models', 'runtime', '$recycle.bin']);
const COVERAGE = '统计本轮可读取的项目文本及文件工具修改；不含依赖和构建产物，同时发生的外部编辑可能计入。';
function excludedFromScan(relative: string) {
  return relative.replaceAll('\\', '/').split('/').some(component => ignored.has(component.toLowerCase()) || /^\.env(?:\.|$)/i.test(component));
}
interface Snapshot { version: 1; files: Record<string, string>; skipped: string[]; complete: boolean; readFailures?: number; limited?: boolean }
async function snapshotPath(dataDir: string, sessionId: string, runId: string) {
  for (const value of [sessionId, runId]) if (!/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new Error('无效的会话或任务标识。');
  return privateStoragePath(dataDir, `changes/${sessionId}/runs/${runId}.json`);
}
async function snapshot(ctx: WorkspaceContext): Promise<Snapshot> {
  const { root } = await workspaceBoundary(ctx);
  const queue = ['']; const result: Snapshot = { version: 1, files: {}, skipped: [], complete: true, readFailures: 0, limited: false };
  let bytes = 0, files = 0, directories = 0;
  while (queue.length) {
    if (++directories > MAX_DIRECTORIES) { result.complete = false; break; }
    const relative = queue.shift()!;
    let entries;
    try { const target = await resolveWorkspacePath(ctx, relative, { directory: true }); entries = await fs.readdir(target.absolute, { withFileTypes: true }); }
    catch { result.complete = false; result.readFailures!++; continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = [relative, entry.name].filter(Boolean).join('/');
      if (excludedFromScan(rel)) { result.skipped.push(rel); continue; }
      if (entry.isSymbolicLink()) { result.skipped.push(rel); continue; }
      try { await resolveWorkspacePath(ctx, rel, { allowMissing: true }); }
      catch { result.skipped.push(rel); continue; }
      try { normalizeRelative(rel); } catch { result.skipped.push(rel); continue; }
      if (entry.isDirectory()) { queue.push(rel); continue; }
      if (!entry.isFile()) continue;
      if (++files > MAX_FILES) { result.complete = false; return result; }
      try {
        const resolved = await resolveWorkspacePath(ctx, rel);
        const info = await fs.stat(resolved.absolute);
        if (info.size > MAX_FILE_BYTES) { result.skipped.push(rel); continue; }
        if (bytes + info.size > MAX_TOTAL_BYTES) { result.skipped.push(rel); result.limited = true; continue; }
        const text = await readWorkspaceText(ctx, rel);
        bytes += Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_TOTAL_BYTES) { result.skipped.push(rel); result.limited = true; continue; }
        result.files[rel] = text;
      } catch (error: any) {
        result.skipped.push(rel);
        // Binary/non-UTF-8 files are deliberately outside text statistics. A
        // permission/I/O failure is a separate uncertainty and must stay visible.
        if (!/不支持读写二进制文件|不是有效 UTF-8/.test(error.message ?? '')) result.readFailures!++;
      }
    }
  }
  return result;
}
export async function beginRunChanges(ctx: WorkspaceContext, sessionId: string, runId: string): Promise<void> {
  const file = await snapshotPath(ctx.dataDir, sessionId, runId);
  const value = await snapshot(ctx);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await snapshotPath(ctx.dataDir, sessionId, runId);
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  try { await snapshotPath(ctx.dataDir, sessionId, runId); await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
}
/** Only the caller that durably saved the terminal summary may discard its baseline.
 * The separate file-tool journal is deliberately retained for conflict-aware undo. */
export async function discardRunChanges(dataDir: string, sessionId: string, runId: string): Promise<void> {
  try { await fs.unlink(await snapshotPath(dataDir, sessionId, runId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function change(path: string, before: string | null, after: string | null, source: RunFileChange['source'], conflict = false): RunFileChange | undefined {
  if (before === after) return;
  const diff = diffLines(before ?? '', after ?? '', { timeout: 100, maxEditLength: 10000 });
  return {
    path, kind: before === null ? 'created' : after === null ? 'deleted' : 'modified', source, ...(conflict ? { conflict } : {}),
    additions: diff ? diff.reduce((count, part) => count + (part.added ? part.count ?? 0 : 0), 0) : null,
    deletions: diff ? diff.reduce((count, part) => count + (part.removed ? part.count ?? 0 : 0), 0) : null,
  };
}
export async function finishRunChanges(ctx: WorkspaceContext, sessionId: string, runId: string): Promise<Pick<RunSummary, 'changes' | 'changeScope' | 'coverageNote' | 'changesError'>> {
  try { await workspaceBoundary(ctx); }
  catch { return { changes: [], changeScope: 'file_tools', changesError: '项目路径无法安全校验，未读取项目文件；修改数量未知。' }; }
  const changes = new Map<string, RunFileChange>();
  const failed: string[] = [];
  let baseline: Snapshot | undefined;
  try {
    baseline = JSON.parse(await fs.readFile(await snapshotPath(ctx.dataDir, sessionId, runId), 'utf8')) as Snapshot;
    if (baseline.version !== 1 || !baseline.files || !Array.isArray(baseline.skipped)) throw new Error('本轮文件快照格式无效');
  } catch { failed.push('本轮开始时的项目快照不可用，仅显示文件工具记录。'); baseline = undefined; }
  const baselineKeys = new Set(Object.keys(baseline?.files ?? {}).map(workspacePathKey));
  const skippedKeys = (baseline?.skipped ?? []).map(workspacePathKey);
  const wasSkipped = (relative: string) => {
    const key = workspacePathKey(relative);
    return skippedKeys.some(skipped => key === skipped || key.startsWith(skipped + '/'));
  };
  if (baseline) {
    for (const [relative, before] of Object.entries(baseline.files)) {
      let after: string | null;
      try { after = await readWorkspaceText(ctx, relative); }
      catch (error: any) {
        // A broken/escaped link or unreadable file is not proof of deletion.
        if (error.code !== 'ENOENT') { failed.push('部分文件无法读取，统计不完整。'); continue; }
        try {
          const target = await resolveWorkspacePath(ctx, relative, { allowMissing: true });
          if (await fs.lstat(target.absolute).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; })) { failed.push('部分文件无法读取，统计不完整。'); continue; }
          after = null;
        } catch { failed.push('部分文件无法读取，统计不完整。'); continue; }
      }
      const observed = change(relative, before, after, 'workspace');
      if (observed) changes.set(workspacePathKey(relative), observed);
    }
    try {
      const current = await snapshot(ctx);
      // A truncated initial listing cannot establish that an unseen path is new.
      if (baseline.complete) for (const [relative, after] of Object.entries(current.files)) {
        if (baselineKeys.has(workspacePathKey(relative)) || wasSkipped(relative)) continue;
        const observed = change(relative, null, after, 'workspace');
        if (observed) changes.set(workspacePathKey(relative), observed);
      }
      if (!baseline.complete || !current.complete || baseline.limited || current.limited) failed.push('部分目录超出扫描范围，文件统计不完整。');
      if (baseline.readFailures || current.readFailures) failed.push('部分文件或目录无法读取，统计不完整。');
    } catch { failed.push('结束时的项目扫描失败，新增文件统计可能不完整。'); }
  }
  try {
    for (const record of await getRunToolChanges(ctx, sessionId, runId)) {
      const key = workspacePathKey(record.path);
      // Snapshot evidence reports the final disk state, including terminal edits after a file tool.
      if (baseline && baselineKeys.has(key)) {
        const observed = changes.get(key);
        if (observed) { observed.source = 'file_tool'; if (record.pending) observed.conflict = true; }
        continue;
      }
      let after: string | null = record.after; let conflict = record.pending;
      try { after = await readWorkspaceText(ctx, record.path); conflict ||= after !== record.after; }
      catch (error: any) { if (isWorkspaceAccessError(error)) throw error; if (error.code === 'ENOENT') after = null; else conflict = true; }
      // Absence proves creation only inside the automatic scan's actual scope.
      // Explicit tools can edit existing ignored files, so retain their true before bytes.
      const before = baseline?.complete && !excludedFromScan(record.path) && !wasSkipped(record.path) ? null : record.before;
      const observed = change(record.path, before, after, 'file_tool', conflict);
      if (observed) changes.set(key, observed); else changes.delete(key);
    }
  } catch { failed.push('文件工具修改记录无法读取，未将未知变更报告为零。'); }
  return {
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    changeScope: baseline ? 'workspace_snapshot' : 'file_tools',
    coverageNote: baseline ? COVERAGE + (baseline.skipped.length ? ' 非文本、大文件和链接不在自动文本统计范围内。' : '') : '仅统计本轮文件工具记录；终端及其他来源的修改未完整统计。',
    ...(failed.length ? { changesError: [...new Set(failed)].join(' ') } : {}),
  };
}
export async function recoverRunChanges(ctx: WorkspaceContext, sessionId: string, runId: string): Promise<Pick<RunSummary, 'changes' | 'changeScope' | 'coverageNote' | 'changesError'>> {
  try {
    const records = await getRunToolChanges(ctx, sessionId, runId);
    const changes = records.map(record => change(record.path, record.before, record.after, 'file_tool', record.pending)).filter((value): value is RunFileChange => !!value);
    return { changes, changeScope: 'file_tools', coverageNote: '应用异常退出，仅恢复已保存的本轮文件工具记录；终端修改和最终磁盘状态未确认。' };
  } catch {
    return { changes: [], changeScope: 'file_tools', changesError: '应用异常退出，文件修改记录无法恢复；文件变更数量未知。' };
  }
}
