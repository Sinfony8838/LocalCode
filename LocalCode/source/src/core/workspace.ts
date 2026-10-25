import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('无效的会话或任务标识。');
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
export async function resolveWorkspacePath(projectPath: string, relative: string, options: { allowMissing?: boolean; directory?: boolean; write?: boolean } = {}): Promise<{ root: string; absolute: string; relative: string }> {
  const rel = normalizeRelative(relative, options.directory === true);
  const root = await fs.realpath(projectPath);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('项目路径不是目录。');
  const absolute = path.resolve(root, rel);
  if (!inside(root, absolute)) throw new Error('路径超出所选项目。');
  let cursor = root;
  let missing = false;
  for (const part of rel.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (missing) continue;
    try {
      const resolved = await fs.realpath(cursor);
      if (!inside(root, resolved)) throw new Error('目录链接或符号链接指向项目外，已拒绝访问。');
      if (path.relative(root, resolved).split(path.sep).some(p => p.toLowerCase() === '.git')) throw new Error('链接指向受保护的 .git 目录。');
      if (options.write) {
        const stat = await fs.stat(cursor);
        if (stat.isFile() && stat.nlink > 1) throw new Error('拒绝修改存在多个硬链接的文件。');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.allowMissing) {
        // realpath also returns ENOENT for a dangling junction. It must never
        // become a writable "missing parent" whose target is outside the root.
        const entry = await fs.lstat(cursor).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === 'ENOENT') return null;
          throw statError;
        });
        if (entry) throw new Error('路径包含无法解析的目录链接，已拒绝访问。');
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
async function readBytes(projectPath: string, relative: string, missing = false): Promise<Buffer | null> {
  const target = await resolveWorkspacePath(projectPath, relative, { allowMissing: missing });
  try {
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile()) throw new Error('路径不是普通文件。');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 2MiB，请选择较小的源文件。');
    const bytes = await fs.readFile(target.absolute);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('文件在读取时超过了大小限制。');
    return bytes;
  } catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readWorkspaceText(projectPath: string, relative: string): Promise<string> {
  return decode((await readBytes(projectPath, relative))!);
}
export async function listWorkspaceFiles(projectPath: string, directory = ''): Promise<FileEntry[]> {
  const target = await resolveWorkspacePath(projectPath, directory, { directory: true });
  const entries = await fs.readdir(target.absolute, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (!visible(entry.name)) continue;
    const rel = [target.relative, entry.name].filter(Boolean).join('/');
    try {
      await resolveWorkspacePath(projectPath, rel, { allowMissing: true });
      const stat = await fs.stat(path.join(target.absolute, entry.name));
      if (!stat.isDirectory() && !stat.isFile()) continue;
      result.push({ path: rel, name: entry.name, directory: stat.isDirectory() });
    } catch { /* Unsafe/unreadable links are omitted from automatic discovery. */ }
  }
  return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 500);
}
export async function walkWorkspaceFiles(projectPath: string, directory = '', maxFiles = 1500): Promise<string[]> {
  const queue = [directory]; const seen = new Set<string>(); const result: string[] = [];
  while (queue.length && result.length < maxFiles && seen.size < 300) {
    const dir = queue.shift()!;
    const resolved = await resolveWorkspacePath(projectPath, dir, { directory: true });
    const actual = (await fs.realpath(resolved.absolute)).toLowerCase();
    if (seen.has(actual)) continue;
    seen.add(actual);
    for (const entry of await listWorkspaceFiles(projectPath, dir)) {
      if (entry.directory) queue.push(entry.path); else result.push(entry.path);
      if (result.length >= maxFiles) break;
    }
  }
  return result;
}
export async function readWorkspaceFile(projectPath: string, relativePath: string): Promise<FileView> {
  const rel = normalizeRelative(relativePath);
  const content = await readWorkspaceText(projectPath, rel);
  return { path: rel, content: content.slice(0, DISPLAY_CHARS), truncated: content.length > DISPLAY_CHARS };
}
interface ChangeRecord { path: string; projectPath: string; runId: string; before: string | null; after: string; afterHash: string; pending: boolean }
const recordHash = (record: ChangeRecord) => hash(Buffer.from(JSON.stringify([record.path, record.projectPath, record.runId, record.before, record.after, record.afterHash, record.pending])));
interface CheckpointRecord { id: string; approvedAt: string; previous: ChangeRecord; approved: string; approvedHash: string }
interface Journal { version: 1; records: ChangeRecord[]; runRecords?: ChangeRecord[]; checkpoints?: CheckpointRecord[] }
function journalPath(dataDir: string, sessionId: string) { return path.join(dataDir, 'changes', safeId(sessionId), 'index.json'); }
async function loadJournal(dataDir: string, sessionId: string): Promise<Journal> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath(dataDir, sessionId), 'utf8')) as Journal;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('修改记录格式无效。');
    return parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] }; throw error; }
}
async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
async function atomicWorkspaceWrite(projectPath: string, relative: string, bytes: Buffer) {
  let target = await resolveWorkspacePath(projectPath, relative, { allowMissing: true, write: true });
  await fs.mkdir(path.dirname(target.absolute), { recursive: true });
  target = await resolveWorkspacePath(projectPath, relative, { allowMissing: true, write: true });
  const temp = path.join(path.dirname(target.absolute), `.localcode-${randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: 'wx' });
  try {
    await resolveWorkspacePath(projectPath, relative, { allowMissing: true, write: true });
    await fs.rename(temp, target.absolute);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function writeWorkspaceText(input: { projectPath: string; dataDir: string; sessionId: string; runId: string; relativePath: string; content: string; expectedText?: string }): Promise<void> {
  const rel = normalizeRelative(input.relativePath);
  if (typeof input.content !== 'string' || input.content.includes('\0')) throw new Error('只允许写入文本内容。');
  const nextBytes = Buffer.from(input.content, 'utf8');
  if (nextBytes.length > MAX_FILE_BYTES) throw new Error('写入内容超过 2MiB 限制。');
  const file = journalPath(input.dataDir, input.sessionId);
  return locked(file, async () => {
    await resolveWorkspacePath(input.projectPath, rel, { allowMissing: true, write: true });
    const before = await readBytes(input.projectPath, rel, true);
    if (before) decode(before);
    if (input.expectedText !== undefined && (before === null || decode(before) !== input.expectedText)) throw new Error('文件自读取后已变化，未覆盖，请重新读取。');
    const original = await loadJournal(input.dataDir, input.sessionId);
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
    await atomicJson(file, journal);
    try {
      const current = await readBytes(input.projectPath, rel, true);
      if ((current ? hash(current) : null) !== (before ? hash(before) : null)) throw new Error('文件在保存前发生变化，已取消写入。');
      await atomicWorkspaceWrite(input.projectPath, rel, nextBytes);
      record.pending = false;
      runRecord.pending = false;
      await atomicJson(file, journal);
    } catch (error) {
      const current = await readBytes(input.projectPath, rel, true).catch(() => undefined);
      if (current !== undefined && (current ? hash(current) : null) === (before ? hash(before) : null)) await atomicJson(file, original);
      throw error;
    }
  });
}
export async function getRunToolChanges(dataDir: string, sessionId: string, runId: string): Promise<Array<{ path: string; before: string | null; after: string; pending: boolean }>> {
  const journal = await loadJournal(dataDir, sessionId);
  return (journal.runRecords ?? []).filter(record => record.runId === runId).map(record => ({
    path: record.path, before: record.before === null ? null : decode(Buffer.from(record.before, 'base64')),
    after: decode(Buffer.from(record.after, 'base64')), pending: record.pending,
  }));
}
export async function getChanges(dataDir: string, sessionId: string): Promise<ChangeView[]> {
  const journal = await loadJournal(dataDir, sessionId);
  return Promise.all(journal.records.map(async record => {
    let conflict = record.pending;
    try { const current = await readBytes(record.projectPath, record.path, true); conflict ||= !current || hash(current) !== record.afterHash; }
    catch { conflict = true; }
    return { path: record.path, before: record.before === null ? '' : decode(Buffer.from(record.before, 'base64')), after: decode(Buffer.from(record.after, 'base64')), created: record.before === null, conflict, runId: record.runId };
  }));
}
export async function undoChange(dataDir: string, sessionId: string, relativePath: string): Promise<void> {
  const rel = normalizeRelative(relativePath); const file = journalPath(dataDir, sessionId);
  return locked(file, async () => {
    const journal = await loadJournal(dataDir, sessionId);
    const record = journal.records.find(r => workspacePathKey(r.path) === workspacePathKey(rel));
    if (!record) throw new Error('没有找到此文件的修改记录。');
    const target = await resolveWorkspacePath(record.projectPath, rel, { write: true });
    const current = await readBytes(record.projectPath, rel);
    if (!current || hash(current) !== record.afterHash) throw new Error('撤销冲突：文件已被再次修改，当前内容已保留。');
    if (record.before === null) await fs.unlink(target.absolute);
    else await atomicWorkspaceWrite(record.projectPath, rel, Buffer.from(record.before, 'base64'));
    journal.records = journal.records.filter(r => r !== record);
    await atomicJson(file, journal);
  });
}

/** UI-only review: return every byte as bounded, valid UTF-8, never a truncated approval. */
export async function previewChangeCheckpoint(dataDir: string, sessionId: string, relativePath: string): Promise<ChangeCheckpointPreview> {
  const rel = normalizeRelative(relativePath);
  return locked(journalPath(dataDir, sessionId), async () => {
    const journal = await loadJournal(dataDir, sessionId);
    const record = checkpointRecord(journal, rel);
    await resolveWorkspacePath(record.projectPath, record.path, { write: true });
    const current = (await readBytes(record.projectPath, record.path))!;
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
export async function checkpointChange(dataDir: string, sessionId: string, relativePath: string, expectedHash: string, expectedRecordHash: string): Promise<void> {
  const rel = normalizeRelative(relativePath); const file = journalPath(dataDir, sessionId);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(expectedRecordHash)) throw new Error('无效的预览校验值，请重新预览。');
  return locked(file, async () => {
    const journal = await loadJournal(dataDir, sessionId);
    const record = checkpointRecord(journal, rel);
    if (recordHash(record) !== expectedRecordHash) throw new Error('修改记录在预览后已变化，未创建新起点；请取消后重新预览。');
    // Re-resolve containment and read under the same journal lock used by edit/undo.
    await resolveWorkspacePath(record.projectPath, record.path, { write: true });
    const current = (await readBytes(record.projectPath, record.path))!;
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
    await atomicJson(file, journal);
    // The workspace itself is untouched. If an external editor races the commit,
    // normal afterHash checks still reject the next edit/undo without losing data.
  });
}
