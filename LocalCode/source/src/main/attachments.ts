import { workspaceContext } from '../core/workspace-context';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AttachmentInfo, AttachmentResource } from '../shared/contracts.js';

const IMAGE_LIMIT = 10 * 1024 * 1024, TEXT_LIMIT = 2 * 1024 * 1024;
const MESSAGE_LIMIT = 50 * 1024 * 1024, MAX_ITEMS = 10;
const scheme = 'localcode-attachment:';
interface RecordEntry { version: 1; id: string; draftKey: string; sessionId?: string; name: string; kind: AttachmentInfo['kind']; size: number; mimeType?: string; hash?: string; folder?: string }
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function key(value: string): string { if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) throw new Error('附件草稿或会话标识无效。'); return value; }
function id(value: string): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error('附件标识无效。'); return value; }
function filename(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\\/\0\r\n]/.test(value)) throw new Error('附件文件名无效。');
  return value;
}
function digest(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function inspect(name: string, bytes: Buffer): Pick<RecordEntry, 'kind' | 'mimeType'> {
  if (!bytes.length) return { kind: 'text', mimeType: 'text/plain' };
  let mime: string | undefined;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') mime = 'image/png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  if (mime) { if (bytes.length > IMAGE_LIMIT) throw new Error('图片不能超过 10 MiB。'); return { kind: 'image', mimeType: mime }; }
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) throw new Error('图片格式或文件内容无效。');
  if (bytes.length > TEXT_LIMIT) throw new Error('文本附件不能超过 2 MiB。');
  if (bytes.includes(0)) throw new Error('仅支持 PNG、JPEG、WebP、GIF 图片及 UTF-8 文本文件。');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('文本附件必须是有效 UTF-8。'); }
  return { kind: 'text', mimeType: 'text/plain' };
}
function publicInfo(record: RecordEntry): AttachmentInfo {
  return { id: record.id, name: record.name, kind: record.kind, size: record.size, mimeType: record.mimeType,
    ...(record.kind === 'image' ? { previewUrl: `${scheme}//asset/${record.id}` } : {}) };
}

/** Host-owned, immutable attachment copies. Renderer gets opaque IDs only.
 * The picked draft is captured before asynchronous file reads, following OpenCode's
 * composer attachment ownership model. Session association never follows current UI focus.
 */
export class AttachmentStore {
  readonly root: string;
  private ready?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly dataDir: string) { this.root = path.resolve(dataDir, 'attachments'); }
  init(): Promise<void> {
    return this.ready ??= (async () => {
      await fs.mkdir(this.root, { recursive: true });
      const actual = await fs.realpath(this.root), data = await fs.realpath(this.dataDir);
      if (!inside(data, actual) || (await fs.lstat(this.root)).isSymbolicLink()) throw new Error('附件存储目录不安全。');
    })();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(work); this.tail = next; return next;
  }
  private async source(input: string, directory: boolean): Promise<string> {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0') || /^\\\\[?.]\\/.test(input)) throw new Error('附件路径无效。');
    const normalized = path.resolve(input);
    let cursor = path.parse(normalized).root;
    for (const part of path.relative(cursor, normalized).split(path.sep).filter(Boolean)) {
      if (part.includes(':') || ['.git', '.aws', '.codex'].includes(part.toLowerCase())) throw new Error('不能添加应用凭证或内部数据目录。');
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('附件不能通过符号链接或目录联接导入。');
    }
    const actual = await fs.realpath(normalized), data = await fs.realpath(this.dataDir);
    if ((await Promise.all(workspaceContext('', this.dataDir).protectedRoots.map(root => fs.realpath(root).catch(error => { if (error.code === 'ENOENT') return path.resolve(root); throw error; })))).some(root => inside(root, actual) || directory && inside(actual, root))) throw new Error('不能添加应用内部数据或包含应用数据的文件夹。');
    const stat = await fs.stat(actual);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? '请选择文件夹。' : '请选择普通文件。');
    if (!directory && stat.nlink > 1) throw new Error('不支持导入多重硬链接文件。');
    return actual;
  }
  private async save(record: RecordEntry, bytes?: Buffer): Promise<AttachmentInfo> {
    if (bytes) await fs.writeFile(path.join(this.root, record.id + '.blob'), bytes, { flag: 'wx' });
    try { await fs.writeFile(path.join(this.root, record.id + '.json'), JSON.stringify(record), { flag: 'wx' }); }
    catch (error) { if (bytes) await fs.unlink(path.join(this.root, record.id + '.blob')).catch(() => {}); throw error; }
    return publicInfo(record);
  }
  async importPaths(draftKey: string, paths: string[], folders = false): Promise<AttachmentInfo[]> {
    key(draftKey); if (!Array.isArray(paths) || !paths.length || paths.length > MAX_ITEMS) throw new Error('每次最多添加 10 个附件。');
    await this.init();
    return this.serial(async () => {
      const staged: { record: RecordEntry; bytes?: Buffer }[] = []; let total = 0;
      for (const input of paths) {
        const canonical = await this.source(input, folders), stat = await fs.stat(canonical), name = filename(path.basename(canonical));
        if (folders) { staged.push({ record: { version: 1, id: randomUUID(), draftKey, name, kind: 'folder', size: 0, folder: canonical } }); continue; }
        if (stat.size > IMAGE_LIMIT) throw new Error('单个附件不能超过 10 MiB。');
        const bytes = await fs.readFile(canonical);
        // Revalidate after read: a replaced link/path must not broaden the user's selection.
        if (await this.source(input, false) !== canonical) throw new Error('附件在导入期间发生变化，请重新选择。');
        const type = inspect(name, bytes); total += bytes.length;
        staged.push({ record: { version: 1, id: randomUUID(), draftKey, name, ...type, size: bytes.length, hash: digest(bytes) }, bytes });
      }
      if (total > MESSAGE_LIMIT) throw new Error('附件总大小不能超过 50 MiB。');
      const output: AttachmentInfo[] = [];
      for (const item of staged) output.push(await this.save(item.record, item.bytes));
      return output;
    });
  }
  async importBytes(draftKey: string, files: { name: string; data: string }[]): Promise<AttachmentInfo[]> {
    key(draftKey); if (!Array.isArray(files) || !files.length || files.length > MAX_ITEMS) throw new Error('每次最多添加 10 个附件。');
    await this.init();
    return this.serial(async () => {
      let total = 0;
      const staged = files.map(file => {
        const name = filename(file.name), encoded = file.data;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('附件编码或大小无效。');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new Error('附件编码无效。');
        const type = inspect(name, bytes); total += bytes.length;
        return { bytes, record: { version: 1 as const, id: randomUUID(), draftKey, name, ...type, size: bytes.length, hash: digest(bytes) } };
      });
      if (total > MESSAGE_LIMIT) throw new Error('附件总大小不能超过 50 MiB。');
      const output: AttachmentInfo[] = [];
      for (const item of staged) output.push(await this.save(item.record, item.bytes));
      return output;
    });
  }
  private async record(attachmentId: string): Promise<RecordEntry> {
    id(attachmentId);
    const file = path.join(this.root, attachmentId + '.json');
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) throw new Error('附件记录无效。');
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as RecordEntry;
    if (record.version !== 1 || record.id !== attachmentId || !['image', 'text', 'folder'].includes(record.kind) || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('附件记录无效。');
    key(record.draftKey); filename(record.name); if (record.sessionId) key(record.sessionId);
    return record;
  }
  private async resource(record: RecordEntry): Promise<AttachmentResource> {
    if (record.kind === 'folder') {
      if (!record.folder) throw new Error('文件夹附件记录无效。');
      const canonical = await this.source(record.folder, true);
      if (canonical !== record.folder) throw new Error('附件文件夹已移动。');
      return { ...publicInfo(record), storagePath: canonical };
    }
    const blob = path.join(this.root, record.id + '.blob'), stat = await fs.lstat(blob);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== record.size || stat.size > IMAGE_LIMIT) throw new Error('附件内容已失效。');
    const bytes = await fs.readFile(blob), type = inspect(record.name, bytes);
    if (digest(bytes) !== record.hash || type.kind !== record.kind || type.mimeType !== record.mimeType) throw new Error('附件内容已变化。');
    return { ...publicInfo(record), storagePath: blob };
  }
  async resolveForSend(draftKey: string, ids: string[], sessionId: string): Promise<AttachmentResource[]> {
    key(draftKey); key(sessionId); if (!Array.isArray(ids) || ids.length > MAX_ITEMS || new Set(ids).size !== ids.length) throw new Error('每条消息最多 10 个不同附件。');
    await this.init();
    return this.serial(async () => {
      const records = await Promise.all(ids.map(value => this.record(value)));
      if (records.some(record => record.draftKey !== draftKey || record.sessionId && record.sessionId !== sessionId)) throw new Error('附件不属于当前草稿或会话。');
      if (records.reduce((sum, record) => sum + record.size, 0) > MESSAGE_LIMIT) throw new Error('每条消息附件总大小不能超过 50 MiB。');
      const resources = await Promise.all(records.map(record => this.resource(record)));
      for (const record of records) {
        if (record.sessionId) continue;
        record.sessionId = sessionId;
        const temp = path.join(this.root, randomUUID() + '.tmp');
        await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx' });
        try { await fs.rename(temp, path.join(this.root, record.id + '.json')); }
        finally { await fs.unlink(temp).catch(() => {}); }
      }
      return resources;
    });
  }
  async resolveHistory(sessionId: string, ids: string[]): Promise<AttachmentResource[]> {
    key(sessionId); if (!Array.isArray(ids) || ids.length > 10000) throw new Error('附件历史标识无效。');
    await this.init();
    const resources: AttachmentResource[] = [];
    // History may contain many messages. Validate one blob at a time to keep
    // peak memory bounded by one attachment rather than the entire chat.
    for (const value of new Set(ids)) {
      const record = await this.record(value);
      if (record.sessionId !== sessionId) throw new Error('附件不属于当前会话。');
      try { resources.push(await this.resource(record)); }
      catch (error) { if (record.kind !== 'folder') throw error; /* Missing/unsafe historical folders lose their read capability, not the entire chat. */ }
    }
    return resources;
  }
  async response(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.protocol !== scheme || url.hostname !== 'asset' || url.search || url.hash) return new Response('Not found', { status: 404 });
      await this.init();
      const record = await this.record(decodeURIComponent(url.pathname.slice(1)));
      if (record.kind !== 'image') return new Response('Not found', { status: 404 });
      const resource = await this.resource(record), bytes = await fs.readFile(resource.storagePath);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': record.mimeType!, 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
    } catch { return new Response('Not found', { status: 404 }); }
  }
}
