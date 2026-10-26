import fs from 'node:fs/promises';
import path from 'node:path';

/** Main-process/worker-owned capability. Never construct it from renderer paths. */
export interface WorkspaceContext {
  projectPath: string;
  dataDir: string;
  protectedRoots: string[];
}
export class WorkspaceAccessError extends Error {
  readonly code = 'WORKSPACE_ACCESS_DENIED';
  constructor(message: string) { super(message); this.name = 'WorkspaceAccessError'; }
}
export const isWorkspaceAccessError = (error: unknown): error is WorkspaceAccessError =>
  error instanceof WorkspaceAccessError || (error as { code?: string })?.code === 'WORKSPACE_ACCESS_DENIED';

export function pathKey(value: string): string {
  let normalized = path.resolve(value);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
  }
  return normalized;
}
export function contained(root: string, candidate: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export function workspaceContext(projectPath: string, dataDir: string): WorkspaceContext {
  const home = path.dirname(path.resolve(dataDir));
  return { projectPath: projectPath ? path.resolve(projectPath) : '', dataDir: path.resolve(dataDir),
    protectedRoots: [path.resolve(dataDir), path.join(home, 'cache'), path.join(home, 'logs')] };
}
/** Resolve missing roots through their closest existing ancestor; never follow a dangling link. */
async function canonicalLocation(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entry = await fs.lstat(absolute).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (entry || path.dirname(absolute) === absolute) throw new WorkspaceAccessError('受保护目录链接无法解析，已拒绝项目文件操作。');
    return path.join(await canonicalLocation(path.dirname(absolute)), path.basename(absolute));
  }
}
/** App-owned files must stay in their exact per-session location, not another session's alias. */
export async function privateStoragePath(dataDir: string, relative: string): Promise<string> {
  const pieces = relative.replaceAll('\\', '/').split('/');
  if (!pieces.length || pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.includes(':') || piece.includes('\0'))) {
    throw new WorkspaceAccessError('无效的应用记录路径。');
  }
  const root = await canonicalLocation(dataDir);
  let cursor = root;
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    if (pathKey(await canonicalLocation(cursor)) !== pathKey(cursor)) {
      throw new WorkspaceAccessError('应用记录目录含有路径别名，已拒绝跨位置读取或写入；原记录已保留。');
    }
    const stat = await fs.stat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isFile() && stat.nlink > 1) throw new WorkspaceAccessError('应用记录存在多个硬链接，原记录已保留。');
  }
  return cursor;
}
export async function workspaceBoundary(ctx: WorkspaceContext) {
  if (!ctx || typeof ctx.projectPath !== 'string' || typeof ctx.dataDir !== 'string' || !Array.isArray(ctx.protectedRoots)) {
    throw new WorkspaceAccessError('缺少可信工作区上下文，已拒绝项目文件操作。');
  }
  const required = workspaceContext(ctx.projectPath, ctx.dataDir).protectedRoots;
  if (required.some(root => !ctx.protectedRoots.some(value => typeof value === 'string' && pathKey(value) === pathKey(root)))) {
    throw new WorkspaceAccessError('工作区缺少应用数据保护范围。');
  }
  const roots = [...ctx.protectedRoots, ...await Promise.all(ctx.protectedRoots.map(canonicalLocation))];
  const rejectProtected = (candidate: string) => {
    if (roots.some(root => contained(root, candidate))) throw new WorkspaceAccessError('应用数据、缓存和日志属于受保护目录，不能作为项目文件访问。');
  };
  rejectProtected(ctx.projectPath);
  const root = await fs.realpath(ctx.projectPath);
  rejectProtected(root);
  if (!(await fs.stat(root)).isDirectory()) throw new WorkspaceAccessError('项目路径不是目录。');
  // Registered projects are canonical. Refuse a subsequently replaced root junction.
  if (pathKey(root) !== pathKey(ctx.projectPath)) throw new WorkspaceAccessError('项目根目录链接已变化，请重新选择实际项目目录。');
  return { root, rejectProtected };
}
