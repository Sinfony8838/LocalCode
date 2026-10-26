import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../src/main/attachments.js';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4O0AAAAASUVORK5CYII=';
let root: string, data: string, store: AttachmentStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'localcode-attachments-')); data = path.join(root, 'data'); store = new AttachmentStore(data); await store.init(); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('attachments ownership and durability', () => {
  it('keeps image bytes out of metadata and serves only opaque image URLs', async () => {
    const [image] = await store.importBytes('draft:a', [{ name: '屏幕.png', data: pixel }]);
    expect(image.kind).toBe('image'); expect(image).not.toHaveProperty('storagePath');
    const response = await store.response(new Request(image.previewUrl!));
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(pixel, 'base64'));
    expect((await store.response(new Request('localcode-attachment://asset/../../file'))).status).toBe(404);
    expect((await store.response(new Request(image.previewUrl! + '?path=C:/secret'))).status).toBe(404);
  });
  it('binds to original draft, allows same-session retries and denies other sessions', async () => {
    const [file] = await store.importBytes('draft:a', [{ name: 'file.txt', data: Buffer.from('hello').toString('base64') }]);
    await expect(store.resolveForSend('draft:b', [file.id], 'session:a')).rejects.toThrow('不属于');
    const result = await store.resolveForSend('draft:a', [file.id], 'session:a');
    expect(await fs.readFile(result[0].storagePath, 'utf8')).toBe('hello');
    await expect(store.resolveForSend('draft:a', [file.id], 'session:a')).resolves.toHaveLength(1);
    await expect(store.resolveForSend('draft:a', [file.id], 'session:b')).rejects.toThrow('不属于');
    const restarted = new AttachmentStore(data);
    await expect(restarted.resolveHistory('session:a', [file.id])).resolves.toHaveLength(1);
    await expect(restarted.resolveHistory('session:b', [file.id])).rejects.toThrow('不属于');
  });
  it('copies selected files, independently of later edits or removal', async () => {
    const source = path.join(root, 'note.txt'); await fs.writeFile(source, 'original');
    const [file] = await store.importPaths('draft', [source]); await fs.writeFile(source, 'changed');
    const [resource] = await store.resolveForSend('draft', [file.id], 'session');
    expect(await fs.readFile(resource.storagePath, 'utf8')).toBe('original');
    expect((await store.response(new Request(`localcode-attachment://asset/${file.id}`))).status).toBe(404);
  });
  it('keeps folders as canonical references and exposes no path metadata', async () => {
    const folder = path.join(root, 'project'); await fs.mkdir(folder);
    const [file] = await store.importPaths('draft', [folder], true);
    expect(file).toMatchObject({ kind: 'folder', size: 0 }); expect(file).not.toHaveProperty('folder');
    const [resource] = await store.resolveForSend('draft', [file.id], 'session');
    expect(resource.storagePath).toBe(await fs.realpath(folder));
  });
  it('removes only the deleted session records, blobs and unsent drafts', async () => {
    const [sent] = await store.importBytes('session:a', [{ name: 'sent.txt', data: Buffer.from('sent').toString('base64') }]);
    const [other] = await store.importBytes('session:b', [{ name: 'other.txt', data: Buffer.from('other').toString('base64') }]);
    const [draft] = await store.importBytes('session:a', [{ name: 'draft.txt', data: Buffer.from('draft').toString('base64') }]);
    await store.resolveForSend('session:a', [sent.id], 'session:a');
    await store.resolveForSend('session:b', [other.id], 'session:b');
    await store.removeSession('session:a');
    await expect(store.resolveHistory('session:a', [sent.id])).rejects.toThrow();
    await expect(store.resolveForSend('session:a', [draft.id], 'session:a')).rejects.toThrow();
    await expect(store.resolveHistory('session:b', [other.id])).resolves.toHaveLength(1);
    await expect(fs.access(path.join(data, 'attachments', sent.id + '.blob'))).rejects.toThrow();
    await expect(store.removeSession('../evil')).rejects.toThrow();
  });
});

describe('attachments validation boundaries', () => {
  it('rejects traversal IDs, invalid names and malformed base64', async () => {
    await expect(store.importBytes('../draft', [{ name: 'x.txt', data: 'aA==' }])).rejects.toThrow();
    await expect(store.importBytes('draft', [{ name: '../x.txt', data: 'aA==' }])).rejects.toThrow();
    await expect(store.importBytes('draft', [{ name: 'x.txt', data: 'invalid base64' }])).rejects.toThrow();
    await expect(store.resolveForSend('draft', ['../x'], 'session')).rejects.toThrow();
  });
  it('rejects binary, fake image, non-UTF8, text and image size violations', async () => {
    for (const [name, bytes] of [['x.bin', Buffer.from([0, 1])], ['x.png', Buffer.from('fake')], ['x.txt', Buffer.from([255])], ['x.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 65)], ['x.png', Buffer.alloc(10 * 1024 * 1024 + 1, 65)]] as const) {
      await expect(store.importBytes('draft', [{ name, data: bytes.toString('base64') }])).rejects.toThrow();
    }
  });
  it('rejects internal data and a folder enclosing app data', async () => {
    const secret = path.join(data, 'providers.json'); await fs.writeFile(secret, 'sensitive');
    await expect(store.importPaths('draft', [secret])).rejects.toThrow('内部数据');
    await expect(store.importPaths('draft', [root], true)).rejects.toThrow('内部数据');
  });
  it('rejects directory junctions and external symlinks', async () => {
    const real = path.join(root, 'real'); await fs.mkdir(real); await fs.writeFile(path.join(real, 'a.txt'), 'x');
    const link = path.join(root, 'link'); await fs.symlink(real, link, 'junction');
    await expect(store.importPaths('draft', [link], true)).rejects.toThrow('链接');
    await expect(store.importPaths('draft', [path.join(link, 'a.txt')])).rejects.toThrow('链接');
  });
  it('verifies immutable content hashes before reuse', async () => {
    const [file] = await store.importBytes('draft', [{ name: 'x.txt', data: 'aGVsbG8=' }]);
    await fs.writeFile(path.join(data, 'attachments', file.id + '.blob'), 'other');
    await expect(store.resolveForSend('draft', [file.id], 'session')).rejects.toThrow('变化');
  });
  it('enforces message item limit without blocking accumulated history', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 11; index++) {
      const [file] = await store.importBytes('draft', [{ name: `${index}.txt`, data: 'eA==' }]); ids.push(file.id);
      await store.resolveForSend('draft', [file.id], 'session');
    }
    await expect(store.resolveForSend('draft', ids, 'session')).rejects.toThrow('最多');
    await expect(store.resolveHistory('session', ids)).resolves.toHaveLength(11);
    await expect(store.resolveForSend('draft', [ids[0], ids[0]], 'session')).rejects.toThrow('不同');
  });
  it('does not partially bind a message with mixed ownership', async () => {
    const [a] = await store.importBytes('draft:a', [{ name: 'a.txt', data: 'YQ==' }]);
    const [b] = await store.importBytes('draft:b', [{ name: 'b.txt', data: 'Yg==' }]);
    await expect(store.resolveForSend('draft:a', [a.id, b.id], 'session:a')).rejects.toThrow();
    await expect(store.resolveHistory('session:a', [a.id])).rejects.toThrow();
  });
  it('drops an unavailable historical folder capability while retaining text history', async () => {
    const folder = path.join(root, 'movable'); await fs.mkdir(folder);
    const [directory] = await store.importPaths('draft', [folder], true);
    const [file] = await store.importBytes('draft', [{name:'keep.txt',data:'eA=='}]);
    await store.resolveForSend('draft',[directory.id,file.id],'session');
    await fs.rename(folder,path.join(root,'moved'));
    expect((await store.resolveHistory('session',[directory.id,file.id])).map(item=>item.id)).toEqual([file.id]);
    await expect(store.resolveForSend('draft',[directory.id],'session')).rejects.toThrow();
  });
});
