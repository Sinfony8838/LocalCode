import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const petIdSchema = z.string().regex(/^(?:paimon|ronova|custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, '无效的桌宠标识。');
export const petDetailsSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional() }).strict();
const entrySchema = petDetailsSchema.extend({ id: petIdSchema.refine(id => id.startsWith('custom-')) }).strict();
const registrySchema = z.object({ version: z.literal(1), characters: z.array(entrySchema).max(100) }).strict().refine(value => new Set(value.characters.map(c => c.id)).size === value.characters.length, '桌宠标识重复。');
const manifestSchema = petDetailsSchema.extend({ atlas: z.string().min(1).max(255) }).strict();
export type CustomPet = z.infer<typeof entrySchema>;
const MAX_ATLAS_BYTES = 16 * 1024 * 1024;

export function validatePetAtlasHeader(bytes: Buffer): void {
  if (bytes.length > MAX_ATLAS_BYTES || bytes.length < 57 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 1536 || bytes.readUInt32BE(20) !== 2288 || bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
    throw new Error('请选择小于 16 MiB、1536×2288、8 位 RGBA 的 PNG 动画图集。');
  }
}

async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`所选文件不是有效文件，或超过 ${Math.ceil(limit / 1024)} KiB。`);
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size || size > limit) throw new Error('文件在读取期间发生变化，请重试。');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function atomicWrite(file: string, data: string | Buffer) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, data, { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error: any) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 12) throw error; await new Promise(resolve => setTimeout(resolve, 75)); }
    }
  } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
}

/** The registry contains display metadata only; atlas paths are derived from validated IDs. */
export class PetLibrary {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private validate: (bytes: Buffer) => void = validatePetAtlasHeader) {}
  private get registry() { return path.join(this.directory, 'library.json'); }
  private async read(): Promise<CustomPet[]> {
    try { return registrySchema.parse(JSON.parse((await boundedRead(this.registry, 256 * 1024)).toString('utf8'))).characters; }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw new Error(`自定义宠物库无法读取，原文件已保留：${error.message}`); }
  }
  async list(): Promise<CustomPet[]> { await this.writes.catch(() => {}); return this.read(); }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work); this.writes = result; return result;
  }
  private async write(characters: CustomPet[]) {
    const value = registrySchema.parse({ version: 1, characters });
    await fs.mkdir(this.directory, { recursive: true });
    await atomicWrite(this.registry, JSON.stringify(value, null, 2));
  }
  private async image(file: string) {
    const bytes = await boundedRead(file, MAX_ATLAS_BYTES); this.validate(bytes); return bytes;
  }
  async readImport(file: string, fallback: z.infer<typeof petDetailsSchema>): Promise<{ name: string; description?: string; bytes: Buffer }> {
    let details = petDetailsSchema.parse(fallback), atlas = file;
    if (path.extname(file).toLowerCase() === '.json') {
      let manifest: z.infer<typeof manifestSchema>;
      try { manifest = manifestSchema.parse(JSON.parse((await boundedRead(file, 16 * 1024)).toString('utf8'))); }
      catch { throw new Error('宠物清单必须是 JSON：{ "name": "名称", "description": "可选介绍", "atlas": "pet.png" }。'); }
      if (path.basename(manifest.atlas) !== manifest.atlas || /[\\/:]/.test(manifest.atlas) || !/\.png$/i.test(manifest.atlas)) throw new Error('清单的 atlas 必须是同一目录内的 PNG 文件名。');
      const directory = await fs.realpath(path.dirname(file));
      atlas = await fs.realpath(path.join(directory, manifest.atlas));
      const relative = path.relative(directory, atlas);
      if ((process.platform === 'win32' ? relative.toLowerCase() !== manifest.atlas.toLowerCase() : relative !== manifest.atlas)) throw new Error('清单图集必须位于清单所在目录，不能通过链接引用其他目录。');
      details = { name: manifest.name, description: manifest.description };
    }
    return { ...details, bytes: await this.image(atlas) };
  }
  async create(file: string, details: z.infer<typeof petDetailsSchema>): Promise<CustomPet> {
    const input = await this.readImport(file, details);
    return this.queue(async () => {
      const characters = await this.read();
      if (characters.length >= 100) throw new Error('自定义宠物已达到 100 个，请先移除不再使用的宠物。');
      const entry = entrySchema.parse({ id: `custom-${randomUUID()}`, name: input.name, description: input.description });
      await fs.mkdir(this.directory, { recursive: true });
      const destination = path.join(this.directory, `${entry.id}.png`);
      await atomicWrite(destination, input.bytes);
      try { await this.write([...characters, entry]); }
      catch (error) { await fs.unlink(destination).catch(() => {}); throw error; }
      return entry;
    });
  }
  async replace(id: string, file: string): Promise<void> {
    petIdSchema.parse(id);
    const bytes = await this.image(file);
    return this.queue(async () => {
      if (id.startsWith('custom-') && !(await this.read()).some(entry => entry.id === id)) throw new Error('自定义宠物不存在，请刷新列表。');
      await fs.mkdir(this.directory, { recursive: true });
      const destination = path.join(this.directory, `${id}.png`);
      try { await fs.copyFile(destination, `${destination}.previous-${Date.now()}-${randomUUID()}`); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await atomicWrite(destination, bytes);
    });
  }
  async remove(id: string): Promise<void> {
    petIdSchema.parse(id);
    if (!id.startsWith('custom-')) throw new Error('内置宠物不能移除。');
    return this.queue(async () => {
      const characters = await this.read();
      if (!characters.some(entry => entry.id === id)) throw new Error('自定义宠物不存在，请刷新列表。');
      // Keep both the previous registry and images recoverable; removal only changes the visible library.
      await fs.copyFile(this.registry, `${this.registry}.previous-${Date.now()}-${randomUUID()}`);
      await this.write(characters.filter(entry => entry.id !== id));
    });
  }
  async settled() { await this.writes.catch(() => {}); }
}
