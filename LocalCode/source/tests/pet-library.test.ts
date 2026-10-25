import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PetLibrary, petIdSchema, validatePetAtlasHeader } from '../src/core/pet-library';
import { petAtlasFixture } from './helpers/pet-atlas';

let root: string;
let image: string;
const fixture = petAtlasFixture();
const scratch = path.resolve('../cache/pet-library-tests');
beforeEach(async () => {
  await fs.mkdir(scratch, { recursive: true });
  root = await fs.mkdtemp(path.join(scratch, 'run-'));
  image = path.join(root, 'pet.png'); await fs.writeFile(image, fixture);
});
afterEach(async () => { if (path.dirname(path.resolve(root)) !== scratch) throw new Error('Unexpected test directory'); await fs.rm(root, { recursive: true, force: true }); });
const library = () => new PetLibrary(path.join(root, 'library'));

describe('custom pet library', () => {
  it('preserves independent pets from concurrent imports and loads them after restart', async () => {
    const first = library();
    const created = await Promise.all([first.create(image, { name: '云朵', description: '第一只旅伴' }), first.create(image, { name: '灯灯' })]);
    expect(created[0].id).not.toBe(created[1].id);
    expect((await library().list()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...created].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await fs.readFile(path.join(root, 'library', `${created[0].id}.png`))).equals(await fs.readFile(image))).toBe(true);
  });
  it('imports manifest names and descriptions without modifying project files', async () => {
    const file = path.join(root, 'pet.json');
    const manifest = JSON.stringify({ name: '雨燕', description: '蓝色翅膀', atlas: 'pet.png' });
    await fs.writeFile(file, manifest);
    const entry = await library().create(file, { name: '界面默认名' });
    expect(entry).toMatchObject({ name: '雨燕', description: '蓝色翅膀' });
    expect(await fs.readFile(file, 'utf8')).toBe(manifest);
  });
  it('rejects escaping manifest paths, untrusted metadata and non-PNG inputs', async () => {
    const lib = library(), file = path.join(root, 'pet.json');
    for (const atlas of ['../pet.png', '..\\pet.png', 'C:\\pet.png', '/pet.png', 'pet.png:stream', 'https://example.com/pet.png', 'pet.svg']) {
      await fs.writeFile(file, JSON.stringify({ name: '不合法', atlas }));
      await expect(lib.create(file, { name: '输入名称' })).rejects.toThrow();
    }
    await fs.writeFile(file, JSON.stringify({ name: '不合法', atlas: 'pet.png', script: 'run me' }));
    await expect(lib.create(file, { name: '输入名称' })).rejects.toThrow(/清单/);
    await fs.writeFile(image, '<svg/>');
    await expect(lib.create(image, { name: '不合法' })).rejects.toThrow(/PNG/);
    expect(await lib.list()).toEqual([]);
  });
  it('keeps the previous atlas when replacement is invalid and backs up valid replacements', async () => {
    const lib = library(), entry = await lib.create(image, { name: '旅伴' });
    const target = path.join(root, 'library', `${entry.id}.png`), original = await fs.readFile(target);
    const invalid = path.join(root, 'invalid.png'); await fs.writeFile(invalid, 'not a PNG');
    await expect(lib.replace(entry.id, invalid)).rejects.toThrow(/PNG/);
    expect((await fs.readFile(target)).equals(original)).toBe(true);
    const replacement = path.join(root, 'replacement.png');
    await fs.writeFile(replacement, petAtlasFixture(1));
    await lib.replace(entry.id, replacement);
    expect((await fs.readFile(target)).equals(original)).toBe(false);
    const previous = (await fs.readdir(path.dirname(target))).find(name => name.startsWith(`${entry.id}.png.previous-`));
    expect(previous).toBeTruthy();
    expect((await fs.readFile(path.join(path.dirname(target), previous!))).equals(original)).toBe(true);
  });
  it('removes only custom membership and retains recovery files', async () => {
    const lib = library(), entry = await lib.create(image, { name: '旅伴' });
    await lib.remove(entry.id);
    expect(await library().list()).toEqual([]);
    expect((await fs.stat(path.join(root, 'library', `${entry.id}.png`))).isFile()).toBe(true);
    expect((await fs.readdir(path.join(root, 'library'))).some(name => name.startsWith('library.json.previous-'))).toBe(true);
    await expect(lib.remove('paimon')).rejects.toThrow(/内置/);
    await expect(lib.replace(entry.id, image)).rejects.toThrow(/不存在/);
  });
  it('preserves a malformed registry and refuses to overwrite it with a new import', async () => {
    const directory = path.join(root, 'library'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'library.json'), '{bad');
    const lib = library();
    await expect(lib.list()).rejects.toThrow(/原文件已保留/);
    await expect(lib.create(image, { name: '旅伴' })).rejects.toThrow(/原文件已保留/);
    expect(await fs.readFile(path.join(directory, 'library.json'), 'utf8')).toBe('{bad');
  });
  it('rejects traversal IDs, invalid dimensions and non-RGBA images', async () => {
    for (const id of ['../paimon', 'custom-../../file', 'paimon.png', 'custom-0', 'C:\\file']) expect(petIdSchema.safeParse(id).success).toBe(false);
    const bytes = await fs.readFile(image); validatePetAtlasHeader(bytes);
    const wrongSize = Buffer.from(bytes); wrongSize.writeUInt32BE(1024, 16);
    expect(() => validatePetAtlasHeader(wrongSize)).toThrow(/1536/);
    const wrongColor = Buffer.from(bytes); wrongColor[25] = 2;
    expect(() => validatePetAtlasHeader(wrongColor)).toThrow(/RGBA/);
  });
});
