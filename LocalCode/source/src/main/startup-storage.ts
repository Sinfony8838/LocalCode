import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STARTUP_STORAGE_ERROR = 'LocalCode 无法写入应用数据、缓存或日志目录，尚未启动工作区。请将完整的便携版文件夹解压或移动到你可写的本地目录（例如“文档”中的新文件夹），确认磁盘有可用空间后重试。保留原有 LocalCode/data 文件夹，不要删除会话数据。无需以管理员身份运行或关闭安全软件。';
export const LOG_STORAGE_ERROR = 'LocalCode 暂时无法写入日志。请确认应用文件夹仍可写且磁盘有可用空间；保存当前工作后重新打开应用。未自动删除或替换已有数据。';
type StartupFilesystem = Pick<typeof fs, 'mkdirSync' | 'openSync' | 'writeSync' | 'closeSync' | 'unlinkSync'>;

/** Probe only newly and exclusively created files; never truncate existing user data. */
export function prepareStartupStorage(home: string, io: StartupFilesystem = fs) {
  const dataDir = path.join(home, 'data');
  const cacheDir = path.join(home, 'cache');
  const logsDir = path.join(home, 'logs');
  const folders = [dataDir, cacheDir, logsDir, path.join(dataDir, 'electron'), path.join(cacheDir, 'chromium'), path.join(cacheDir, 'crashes')];
  for (const folder of folders) {
    io.mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, `.localcode-write-check-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = io.openSync(probe, 'wx', 0o600);
      const content = 'LocalCode startup write check\n';
      if (io.writeSync(descriptor, content) !== Buffer.byteLength(content)) throw new Error('Startup storage probe could not be fully written.');
    } finally {
      // Only successful exclusive creation makes this probe ours to remove.
      if (descriptor !== undefined) {
        try { io.closeSync(descriptor); }
        finally { io.unlinkSync(probe); }
      }
    }
  }
  const logPath = path.join(logsDir, 'desktop.log');
  // A pre-existing read-only log can fail even when its directory is writable.
  // Open synchronously in append mode so startup handles the failure before IPC.
  const logFd = io.openSync(logPath, 'a', 0o600);
  return { dataDir, cacheDir, logsDir, logPath, logFd };
}
