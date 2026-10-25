import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspaceBoundary, privateStoragePath, pathKey, isWorkspaceAccessError, WorkspaceAccessError, type WorkspaceContext } from './workspace-context.js';
import type { ChangeCheckpointPreview, ChangeView, FileEntry, FileView } from '../shared/contracts.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CHECKPOINT_BYTES = 128 * 1024;
const DISPLAY_CHARS = 200_000;
const ignored = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', 'dist', 'build', 'coverage', 'models', 'runtime', '$recycle.bin']);
const locks = new Map<string, Promise<unknown>>();
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** File identity follows the supported Windows filesystem; keep display spelling separately. */
export function workspacePathKey(relative: string): string {
  const value = relative.replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function safeId(id: string) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('无效的会话或任务标识。');
  return id;
}
function inside(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function normalizeRelative(input: string, allowEmpty = false): string {
  if (typeof input !== 'string' || input.includes('\0') || path.isAbsolute(input) || /^[a-z]:/i.test(input) || input.startsWith('\\\\') || input.includes(':')) {
    throw new Error('只允许所选项目内的相对路径。');
  }
  const pieces = input.replaceAll('\\', '/').split('/').filter(p => p !== '' && p !== '.');
  if (pieces.includes('..')) throw new Error('不允许路径穿越（..）。');
  if (pieces.some(p => p.toLowerCase() === '.git')) throw new Error('不允许直接访问或修改 .git 内部文件。');
  if (pieces.some(p => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('路径含 Windows 保留名称。');
  if (!pieces.length && !allowEmpty) throw new Error('文件路径不能为空。');
  return pieces.join('/');
}
export async function resolveWorkspacePath(ctx: WorkspaceContext, relative: string, options: { allowMissing?: boolean; directory?: boolean; write?: boolean } = {}): Promise<{ root: string; absolute: string; relative: string }> {
  const rel = normalizeRelative(relative, options.directory === true);
  const { root, rejectProtected } = await workspaceBoundary(ctx);
  const absolute = path.resolve(root, rel);
  rejectProtected(absolute);
  if (!inside(root, absolute)) throw new WorkspaceAccessError('路径超出所选项目。');
  let cursor = root;
  let missing = false;
  for (const part of rel.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    rejectProtected(cursor);
    if (missing) continue;
    try {
      const resolved = await fs.realpath(cursor);
      rejectProtected(resolved);
      if (!inside(root, resolved)) throw new WorkspaceAccessError('目录链接或符号链接指向项目外，已拒绝访问。');
      if (path.relative(root, resolved).split(path.sep).some(p => p.toLowerCase() === '.git')) throw new WorkspaceAccessError('链接指向受保护的 .git 目录。');
      const stat = await fs.stat(cursor);
      if (stat.isFile() && stat.nlink > 1) throw new WorkspaceAccessError('拒绝访问存在多个硬链接的文件。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.allowMissing) {
        // realpath also returns ENOENT for a dangling junction. It must never
        // become a writable "missing parent" whose target is outside the root.
        const entry = await fs.lstat(cursor).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === 'ENOENT') return null;
          throw statError;
        });
        if (entry) throw new WorkspaceAccessError('路径包含无法解析的目录链接，已拒绝访问。');
        missing = true;
      }
      else throw error;
    }
  }
  if (!options.allowMissing) {
    const stat = await fs.stat(absolute);
    if (options.directory && !stat.isDirectory()) throw new Error('路径不是目录。');
    if (!options.directory && !stat.isFile()) throw new Error('路径不是普通文件。');
  }
  return { root, absolute, relative: rel };
}
function visible(name: string) { return !ignored.has(name.toLowerCase()) && !/^\.env(?:\.|$)/i.test(name); }
function decode(buffer: Buffer) {
  if (buffer.includes(0)) throw new Error('不支持读写二进制文件。');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error('文件不是有效 UTF-8 文本，未进行修改。'); }
}
async function readBytes(ctx: WorkspaceContext, relative: string, missing = false): Promise<Buffer | null> {
  const target = await resolveWorkspacePath(ctx, relative, { allowMissing: missing });
  try {
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw new Error('路径不是普通文件。');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 2MiB，请选择较小的源文件。');
    const bytes = await fs.readFile(target.absolute);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('文件在读取时超过了大小限制。');
    return bytes;
  } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readWorkspaceText(ctx: WorkspaceContext, relative: string): Promise<string> {
  return decode((await readBytes(ctx, relative))!);
}
export async function listWorkspaceFiles(ctx: WorkspaceContext, directory = ''): Promise<FileEntry[]> {
  const target = await resolveWorkspacePath(ctx, directory, { directory: true });
  const entries = await fs.readdir(target.absolute, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (!visible(entry.name)) continue;
    const rel = [target.relative, entry.name].filter(Boolean).join('/');
    try {
      await resolveWorkspacePath(ctx, rel, { allowMissing: true });
      const stat = await fs.stat(path.join(target.absolute, entry.name));
      if (!stat.isDirectory() && !stat.isFile()) continue;
      result.push({ path: rel, name: entry.name, directory: stat.isDirectory() });
    } catch { /* Unsafe/unreadable links are omitted from automatic discovery. */ }
  }
  return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 500);
}
export async function walkWorkspaceFiles(ctx: WorkspaceContext, directory = '', maxFiles = 1500): Promise<string[]> {
  const queue = [directory]; const seen = new Set<string>(); const result: string[] = [];
  while (queue.length && result.length < maxFiles && seen.size < 300) {
    const dir = queue.shift()!;
    const resolved = await resolveWorkspacePath(ctx, dir, { directory: true });
    const actual = (await fs.realpath(resolved.absolute)).toLowerCase();
    if (seen.has(actual)) continue;
    seen.add(actual);
    for (const entry of await listWorkspaceFiles(ctx, dir)) {
      if (entry.directory) queue.push(entry.path); else result.push(entry.path);
      if (result.length >= maxFiles) break;
    }
  }
  return result;
}
export async function readWorkspaceFile(ctx: WorkspaceContext, relativePath: string): Promise<FileView> {
  const rel = normalizeRelative(relativePath);
  const content = await readWorkspaceText(ctx, rel);
  return { path: rel, content: content.slice(0, DISPLAY_CHARS), truncated: content.length > DISPLAY_CHARS };
}
interface ChangeRecord { path: string; projectPath: string; runId: string; before: string | null; after: string; afterHash: string; pending: boolean }
const recordHash = (record: ChangeRecord) => hash(Buffer.from(JSON.stringify([record.path, record.projectPath, record.runId, record.before, record.after, record.afterHash, record.pending])));
interface CheckpointRecord { id: string; approvedAt: string; previous: ChangeRecord; approved: string; approvedHash: string }
interface Journal { version: 1; records: ChangeRecord[]; runRecords?: ChangeRecord[]; checkpoints?: CheckpointRecord[] }
function journalPath(dataDir: string, sessionId: string) { return path.join(dataDir, 'changes', safeId(sessionId), 'index.json'); }
async function loadJournal(ctx: WorkspaceContext, sessionId: string): Promise<Journal> {
  await workspaceBoundary(ctx);
  let text: string;
  try {
    text = await fs.readFile(await privateStoragePath(ctx.dataDir, `changes/${safeId(sessionId)}/index.json`), 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] }; throw error; }
  const parsed = JSON.parse(text) as Journal;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) throw new WorkspaceAccessError('修改记录格式无效，原记录已保留。');
  await validateJournal(ctx, parsed);
  return parsed;
}

async function validateJournal(ctx: WorkspaceContext, journal: Journal): Promise<void> {
  if ((journal.runRecords !== undefined && !Array.isArray(journal.runRecords)) || (journal.checkpoints !== undefined && !Array.isArray(journal.checkpoints))) throw new WorkspaceAccessError('修改记录格式无效，原记录已保留。');
  const records = [...journal.records, ...(journal.runRecords ?? []), ...(journal.checkpoints ?? []).map(checkpoint => checkpoint?.previous)];
  // Complete metadata preflight before reading any project content or exposing saved bytes.
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || typeof record.projectPath !== 'string' || !path.isAbsolute(record.projectPath)
      || pathKey(record.projectPath) !== pathKey(ctx.projectPath) || typeof record.runId !== 'string'
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(record.runId) || typeof record.after !== 'string'
      || (record.before !== null && typeof record.before !== 'string') || typeof record.afterHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.afterHash) || typeof record.pending !== 'boolean') {
      throw new WorkspaceAccessError('修改记录与已登记项目不一致或格式无效，已拒绝操作；原记录已保留。');
    }
    try { normalizeRelative(record.path); }
    catch { throw new WorkspaceAccessError('修改记录包含无效项目路径，已拒绝操作；原记录已保留。'); }
    for (const encoded of [record.before, record.after]) {
      if (encoded === null) continue;
      if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
        throw new WorkspaceAccessError('修改记录的文件内容编码或大小无效，原记录已保留。');
      }
    }
    if (hash(Buffer.from(record.after, 'base64')) !== record.afterHash) throw new WorkspaceAccessError('修改记录内容校验失败，原记录已保留。');
  }
  for (const record of records) await resolveWorkspacePath(ctx, record.path, { allowMissing: true });
}

async function atomicJson(file: string, value: unknown, dataDir: string) {
  const relative = path.relative(dataDir, file);
  file = await privateStoragePath(dataDir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await privateStoragePath(dataDir, relative);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await privateStoragePath(dataDir, relative);
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
async function atomicWorkspaceWrite(ctx: WorkspaceContext, relative: string, bytes: Buffer) {
  let target = await resolveWorkspacePath(ctx, relative, { allowMissing: true, write: true });
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  target = await resolveWorkspacePath(ctx, relative, { allowMissing: true, write: true });
  const temp = path.join(path.dirname(target.absolute), `.localcode-${randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: 'wx' });
  try {
    await resolveWorkspacePath(ctx, relative, { allowMissing: true, write: true });
    await fs.rename(temp, target.absolute);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function writeWorkspaceText(input: WorkspaceContext & { sessionId: string; runId: string; relativePath: string; content: string; expectedText?: string }): Promise<void> {
  const rel = normalizeRelative(input.relativePath);
  if (typeof input.content !== 'string' || input.content.includes('\0')) throw new Error('只允许写入文本内容。');
  const nextBytes = Buffer.from(input.content, 'utf8');
  if (nextBytes.length > MAX_FILE_BYTES) throw new Error('写入内容超过 2MiB 限制。');
  const file = journalPath(input.dataDir, input.sessionId);
  return locked(file, async () => {
    await resolveWorkspacePath(input, rel, { allowMissing: true, write: true });
    const original = await loadJournal(input, input.sessionId);
    const before = await readBytes(input, rel, true);
    if (before) decode(before);
    if (input.expectedText !== undefined && (before === null || decode(before) !== input.expectedText)) throw new Error('文件自读取后已变化，未覆盖，请重新读取。');
    const journal: Journal = structuredClone(original);
    const key = workspacePathKey(rel);
    const existing = journal.records.find(r => workspacePathKey(r.path) === key);
    if (existing && (before === null || hash(before) !== existing.afterHash)) throw new Error('文件包含本任务之外的新修改；请先结束任务，再在“修改”面板预览并确认当前内容为新起点，或新建会话。');
    const record: ChangeRecord = {
      path: existing?.path ?? rel, projectPath: await fs.realpath(input.projectPath), runId: safeId(input.runId),
      before: existing ? existing.before : before?.toString('base64') ?? null,
      after: nextBytes.toString('base64'), afterHash: hash(nextBytes), pending: true,
    };
    // Keep each round's first bytes independently from the cumulative undo baseline.
    // A later round touching the same file must not rewrite earlier round evidence.
    const runExisting = journal.runRecords?.find(r => r.runId === input.runId && workspacePathKey(r.path) === key);
    const runRecord: ChangeRecord = { ...record, path: runExisting?.path ?? record.path, before: runExisting ? runExisting.before : before?.toString('base64') ?? null };
    journal.runRecords = [...(journal.runRecords ?? []).filter(r => r.runId !== input.runId || workspacePathKey(r.path) !== key), runRecord];
    journal.records = journal.records.filter(r => workspacePathKey(r.path) !== key);
    journal.records.push(record);
    await atomicJson(file, journal, input.dataDir);
    try {
      const current = await readBytes(input, rel, true);
      if ((current ? hash(current) : null) !== (before ? hash(before) : null)) throw new Error('文件在保存前发生变化，已取消写入。');
      await atomicWorkspaceWrite(input, rel, nextBytes);
      record.pending = false;
      runRecord.pending = false;
      await atomicJson(file, journal, input.dataDir);
    } catch (error) {
      const current = await readBytes(input, rel, true).catch(() => undefined);
      if (current !== undefined && (current ? hash(current) : null) === (before ? hash(before) : null)) await atomicJson(file, original, input.dataDir);
      throw error;
    }
  });
}
export async function getRunToolChanges(ctx: WorkspaceContext, sessionId: string, runId: string): Promise<Array<{ path: string; before: string | null; after: string; pending: boolean }>> {
  const journal = await loadJournal(ctx, sessionId);
  return (journal.runRecords ?? []).filter(record => record.runId === runId).map(record => ({
    path: record.path, before: record.before === null ? null : decode(Buffer.from(record.before, 'base64')),
    after: decode(Buffer.from(record.after, 'base64')), pending: record.pending,
  }));
}
export async function getChanges(ctx: WorkspaceContext, sessionId: string): Promise<ChangeView[]> {
  const journal = await loadJournal(ctx, sessionId);
  return Promise.all(journal.records.map(async record => {
    let conflict = record.pending;
    try { const current = await readBytes(ctx, record.path, true); conflict ||= !current || hash(current) !== record.afterHash; }
    catch (error) { if (isWorkspaceAccessError(error)) throw error; conflict = true; }
    return { path: record.path, before: record.before === null ? '' : decode(Buffer.from(record.before, 'base64')), after: decode(Buffer.from(record.after, 'base64')), created: record.before === null, conflict, runId: record.runId };
  }));
}
export async function undoChange(ctx: WorkspaceContext, sessionId: string, relativePath: string): Promise<void> {
  const rel = normalizeRelative(relativePath); const file = journalPath(ctx.dataDir, sessionId);
  return locked(file, async () => {
    const journal = await loadJournal(ctx, sessionId);
    const record = journal.records.find(r => workspacePathKey(r.path) === workspacePathKey(rel));
    if (!record) throw new Error('没有找到此文件的修改记录。');
    const target = await resolveWorkspacePath(ctx, rel, { write: true });
    const current = await readBytes(ctx, rel);
    if (!current || hash(current) !== record.afterHash) throw new Error('撤销冲突：文件已被再次修改，当前内容已保留。');
    if (record.before === null) await fs.unlink(target.absolute);
    else await atomicWorkspaceWrite(ctx, rel, Buffer.from(record.before, 'base64'));
    journal.records = journal.records.filter(r => r !== record);
    await atomicJson(file, journal, ctx.dataDir);
  });
}

/** UI-only review: return every byte as bounded, valid UTF-8, never a truncated approval. */
export async function previewChangeCheckpoint(ctx: WorkspaceContext, sessionId: string, relativePath: string): Promise<ChangeCheckpointPreview> {
  const rel = normalizeRelative(relativePath);
  return locked(journalPath(ctx.dataDir, sessionId), async () => {
    const journal = await loadJournal(ctx, sessionId);
    const record = checkpointRecord(journal, rel);
    await resolveWorkspacePath(ctx, record.path, { write: true });
    const current = (await readBytes(ctx, record.path))!;
    if (current.length > MAX_CHECKPOINT_BYTES) throw new Error('新起点预览仅支持不超过 128KiB 的文本文件；较大文件请保留当前内容并新建会话。');
    const currentHash = hash(current);
    if (currentHash === record.afterHash) throw new Error('文件没有需要确认的外部修改，请刷新修改面板。');
    return { path: record.path, content: decode(current), currentHash, recordHash: recordHash(record), byteLength: current.length };
  });
}
function checkpointRecord(journal: Journal, relativePath: string): ChangeRecord {
  const record = journal.records.find(r => workspacePathKey(r.path) === workspacePathKey(relativePath));
  if (!record) throw new Error('没有找到此文件的修改记录。');
  if (record.pending) throw new Error('上次文件写入未完成，不能创建新起点；请先检查并恢复修改记录。');
  return record;
}
/** Explicit desktop-user approval only. Do not expose this as an agent tool. */
export async function checkpointChange(ctx: WorkspaceContext, sessionId: string, relativePath: string, expectedHash: string, expectedRecordHash: string): Promise<void> {
  const rel = normalizeRelative(relativePath); const file = journalPath(ctx.dataDir, sessionId);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(expectedRecordHash)) throw new Error('无效的预览校验值，请重新预览。');
  return locked(file, async () => {
    const journal = await loadJournal(ctx, sessionId);
    const record = checkpointRecord(journal, rel);
    if (recordHash(record) !== expectedRecordHash) throw new Error('修改记录在预览后已变化，未创建新起点；请取消后重新预览。');
    // Re-resolve containment and read under the same journal lock used by edit/undo.
    await resolveWorkspacePath(ctx, record.path, { write: true });
    const current = (await readBytes(ctx, record.path))!;
    decode(current);
    if (current.length > MAX_CHECKPOINT_BYTES) throw new Error('新起点预览仅支持不超过 128KiB 的文本文件；较大文件请保留当前内容并新建会话。');
    if (hash(current) !== expectedHash) throw new Error('文件在预览后已再次修改，未创建新起点；请取消后重新预览。');
    if (expectedHash === record.afterHash) throw new Error('文件没有需要确认的外部修改，请刷新修改面板。');
    const approved = current.toString('base64');
    // Evidence and the new undo segment are one atomic commit. Never discard the
    // old bytes first, and never rewrite immutable per-round tool evidence.
    journal.checkpoints = [...(journal.checkpoints ?? []), { id: randomUUID(), approvedAt: new Date().toISOString(), previous: structuredClone(record), approved, approvedHash: expectedHash }];
    record.before = approved;
    record.after = approved;
    record.afterHash = expectedHash;
    await atomicJson(file, journal, ctx.dataDir);
    // The workspace itself is untouched. If an external editor races the commit,
    // normal afterHash checks still reject the next edit/undo without losing data.
  });
}
