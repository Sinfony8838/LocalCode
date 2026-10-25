import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareStartupStorage, STARTUP_STORAGE_ERROR, LOG_STORAGE_ERROR } from '../src/main/startup-storage';
const roots: string[] = [];
const create = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localcode-startup-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const probes = (root: string) => fs.readdirSync(root, { recursive: true }).filter(name => String(name).includes('.localcode-write-check-'));

describe('early startup storage checks', () => {
  it('creates and checks all required folders, then cleans every owned probe', () => {
    const home = create(); const result = prepareStartupStorage(home);
    try {
      for (const name of ['data', 'cache', 'logs', 'data/electron', 'cache/chromium', 'cache/crashes']) expect(fs.statSync(path.join(home, name)).isDirectory()).toBe(true);
      expect(probes(home)).toEqual([]);
      fs.writeSync(result.logFd, 'new log entry\n');
      expect(fs.readFileSync(result.logPath, 'utf8')).toBe('new log entry\n');
    } finally { fs.closeSync(result.logFd); }
  });
  it('does not truncate existing history or logs, including on repeated launches', () => {
    const home = create(); fs.mkdirSync(path.join(home, 'data')); fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'data/index.json'), '{"private":"keep-existing-history"}');
    fs.writeFileSync(path.join(home, 'logs/desktop.log'), 'keep prior log\n');
    for (let i = 0; i < 2; i++) { const result = prepareStartupStorage(home); fs.closeSync(result.logFd); }
    expect(fs.readFileSync(path.join(home, 'data/index.json'), 'utf8')).toBe('{"private":"keep-existing-history"}');
    expect(fs.readFileSync(path.join(home, 'logs/desktop.log'), 'utf8')).toBe('keep prior log\n');
    expect(probes(home)).toEqual([]);
  });
  it('fails before opening the log if creating or writing an exclusive probe is blocked', () => {
    for (const stage of ['mkdir', 'open', 'write']) {
      const home = create();
      const io = { mkdirSync: fs.mkdirSync, openSync: fs.openSync, fstatSync: fs.fstatSync, writeSync: fs.writeSync, closeSync: vi.fn(fs.closeSync), unlinkSync: vi.fn(fs.unlinkSync) };
      if (stage === 'mkdir') io.mkdirSync = vi.fn(() => { throw new Error('EACCES private-directory'); });
      if (stage === 'open') io.openSync = vi.fn(() => { throw new Error('EACCES private-file'); });
      if (stage === 'write') io.writeSync = vi.fn(() => { throw new Error('ENOSPC private-volume'); });
      expect(() => prepareStartupStorage(home, io)).toThrow();
      expect(fs.existsSync(path.join(home, 'logs/desktop.log'))).toBe(false);
      expect(probes(home)).toEqual([]);
      expect(io.closeSync).toHaveBeenCalledTimes(stage === 'write' ? 1 : 0);
      expect(io.unlinkSync).toHaveBeenCalledTimes(stage === 'write' ? 1 : 0);
    }
  });
  it('never unlinks an existing file when exclusive creation fails', () => {
    const home = create(); let collidingPath = '';
    const io = { ...fs, openSync: vi.fn((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      if (flags === 'wx') { collidingPath = String(file); fs.writeFileSync(file, 'not-owned'); }
      return fs.openSync(file, flags, mode);
    }), unlinkSync: vi.fn(fs.unlinkSync) };
    expect(() => prepareStartupStorage(home, io)).toThrow();
    expect(io.unlinkSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(collidingPath, 'utf8')).toBe('not-owned');
  });
  it('detects an unusable existing log path before a stream can emit an unhandled open error', () => {
    const home = create(); fs.mkdirSync(path.join(home, 'logs/desktop.log'), { recursive: true });
    expect(() => prepareStartupStorage(home)).toThrow();
    expect(probes(home)).toEqual([]);
  });
  it.each(['directory', 'stat-error'])('closes an opened log handle when validation reports %s on any platform', mode => {
    const home = create(); const fakeLogFd = -777;
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs/desktop.log'), 'keep prior log');
    const io = { ...fs,
      openSync: vi.fn((file: fs.PathLike, flags: fs.OpenMode, permissions?: fs.Mode | null) => flags === 'a' ? fakeLogFd : fs.openSync(file, flags, permissions)),
      fstatSync: vi.fn().mockImplementation(() => {
        if (mode === 'stat-error') throw new Error('handle inspection failed');
        return { isFile: () => false };
      }),
      closeSync: vi.fn((descriptor: number) => { if (descriptor !== fakeLogFd) fs.closeSync(descriptor); }),
    };
    expect(() => prepareStartupStorage(home, io)).toThrow(mode === 'directory' ? 'not a regular file' : 'handle inspection failed');
    expect(io.fstatSync).toHaveBeenCalledWith(fakeLogFd);
    expect(io.closeSync.mock.calls.filter(([descriptor]) => descriptor === fakeLogFd)).toHaveLength(1);
    expect(probes(home)).toEqual([]);
    expect(fs.readFileSync(path.join(home, 'logs/desktop.log'), 'utf8')).toBe('keep prior log');
  });
  it('keeps user-facing failures fixed and provides safe writable-directory remedies', () => {
    expect(STARTUP_STORAGE_ERROR).toContain('可写的本地目录');
    expect(STARTUP_STORAGE_ERROR).toContain('保留原有 LocalCode/data');
    expect(STARTUP_STORAGE_ERROR).toContain('无需以管理员身份运行或关闭安全软件');
    expect(LOG_STORAGE_ERROR).toContain('保存当前工作');
  });
});
