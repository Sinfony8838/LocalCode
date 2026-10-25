import fs from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentResource } from '../shared/contracts.js';
import { normalizeRelative, resolveWorkspacePath } from './workspace.js';

export interface ResourceContext { projectPath: string; dataDir: string; attachments?: AttachmentResource[] }
export interface ResolvedResource { root: string; relative: string; absolute: string; displayPath: string; inWorkspace: boolean; attachment?: AttachmentResource }
export function containsPath(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
async function canonicalTarget(input: string, allowMissing: boolean): Promise<string> {
  try { return await fs.realpath(input); }
  catch (error: any) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error;
    // A dangling link is an existing object, never a safe missing directory.
    const entry = await fs.lstat(input).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (entry) throw new Error('路径包含无法解析的目录链接。');
    const parent = path.dirname(input);
    if (parent === input) throw error;
    return path.join(await canonicalTarget(parent, true), path.basename(input));
  }
}
/** User-selected attachments are read-only capabilities, never additional writable roots. */
export async function resolveResource(ctx: ResourceContext, input: string, options: { directory?: boolean; write?: boolean; allowMissing?: boolean } = {}): Promise<ResolvedResource> {
  const alias = /^attachment:([^/\\]+)(?:[/\\](.*))?$/.exec(input);
  if (alias) {
    const attachment = ctx.attachments?.find(item => item.id === alias[1]);
    if (!attachment || attachment.kind === 'image') throw new Error('附件不存在或不是可读取的文本/文件夹。');
    if (options.write) throw new Error('附件仅供只读参考，不能修改。');
    if (attachment.kind === 'text') {
      if (alias[2] || options.directory) throw new Error('此附件不是文件夹。');
      const absolute = await fs.realpath(attachment.storagePath);
      return { root: path.dirname(absolute), relative: path.basename(absolute), absolute, displayPath: `attachment:${attachment.id}`, inWorkspace: true, attachment };
    }
    const resolved = await resolveWorkspacePath(attachment.storagePath, alias[2] || '', options);
    if (containsPath(await canonicalTarget(ctx.dataDir, true), await fs.realpath(resolved.absolute))) throw new Error('不能将应用私有数据作为附件文件夹读取。');
    return { ...resolved, displayPath: `attachment:${attachment.id}${resolved.relative ? '/' + resolved.relative : ''}`, inWorkspace: true, attachment };
  }
  if (!ctx.projectPath) throw new Error('当前任务未指定工作区；只能读取已添加的附件。');
  let resolved: { root: string; relative: string; absolute: string };
  const projectRoot = await fs.realpath(ctx.projectPath);
  if (!path.isAbsolute(input)) {
    resolved = await resolveWorkspacePath(projectRoot, input, options);
  } else {
    if (input.startsWith('\\\\') || input.includes('\0')) throw new Error('不支持网络路径或设备路径。');
    const parsed = path.parse(input);
    normalizeRelative(input.slice(parsed.root.length), options.directory);
    const canonical = await canonicalTarget(path.resolve(input), !!options.allowMissing);
    const canonicalParsed = path.parse(canonical);
    normalizeRelative(canonical.slice(canonicalParsed.root.length), options.directory);
    if (containsPath(projectRoot, canonical)) resolved = await resolveWorkspacePath(projectRoot, path.relative(projectRoot, canonical), options);
    else {
      const root = options.directory ? canonical : await canonicalTarget(path.dirname(canonical), true);
      // Missing parent trees use the nearest existing directory as their guarded root.
      let existingRoot = root;
      while (!(await fs.stat(existingRoot).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; }))) existingRoot = path.dirname(existingRoot);
      resolved = await resolveWorkspacePath(existingRoot, path.relative(existingRoot, canonical), options);
    }
  }
  const absolute = await canonicalTarget(resolved.absolute, !!options.allowMissing);
  const privateRoot = await canonicalTarget(ctx.dataDir, true);
  if (containsPath(privateRoot, absolute)) throw new Error('不允许通过 Agent 工具访问应用私有数据。');
  let readOnlyAttachment: AttachmentResource | undefined;
  for (const attachment of ctx.attachments ?? []) {
    if (attachment.kind !== 'folder') continue;
    const attachmentRoot = await fs.realpath(attachment.storagePath);
    if (containsPath(attachmentRoot, absolute)) {
      if (options.write) throw new Error('附件文件夹仅供只读参考，不能修改。');
      readOnlyAttachment = attachment;
    }
  }
  const inWorkspace = containsPath(projectRoot, absolute);
  if (readOnlyAttachment) {
    const root = await fs.realpath(readOnlyAttachment.storagePath); const relative = path.relative(root, absolute).replaceAll('\\', '/');
    return { root, relative, absolute, inWorkspace: true, attachment: readOnlyAttachment, displayPath: `attachment:${readOnlyAttachment.id}${relative ? '/' + relative : ''}` };
  }
  return { ...resolved, absolute, inWorkspace, displayPath: inWorkspace ? path.relative(projectRoot, absolute).replaceAll('\\', '/') : absolute };
}
export function childResource(parent: ResolvedResource, relative: string): string {
  if (parent.attachment) return `attachment:${parent.attachment.id}/${relative}`;
  return parent.inWorkspace ? relative : path.join(parent.root, relative);
}
