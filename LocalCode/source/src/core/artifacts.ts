import { workspaceBoundary, type WorkspaceContext } from './workspace-context';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeRelative, resolveWorkspacePath } from './workspace';
import type { ArtifactInfo, ArtifactInputKind, ArtifactKind } from '../shared/artifacts';

export const PREVIEW_SCHEME = 'localcode-preview';
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
export function externalBrowserUrl(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\u0000-\u001f\u007f]/.test(input)) throw new Error('无效的网页链接。');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('无效的网页链接。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('外部浏览器仅允许 HTTP 或 HTTPS 网页。');
  return url.href;
}
const activeExtensions = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.mjs', '.cjs', '.py', '.pyw', '.rb', '.sh', '.ws', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.cpl', '.hta', '.lnk', '.url', '.reg', '.pif', '.scf', '.sct', '.msc', '.inf', '.jar', '.jnlp', '.application', '.appref-ms', '.gadget']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const textExtensions = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml', '.toml', '.ini', '.css', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.sql', '.sh', '.ps1', '.bat', '.cmd', '.tex', '.vue', '.svelte']);
const assetTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** Links are data: only project-contained filesystem references may reach the OS. */
export async function resolveArtifactPath(ctx: WorkspaceContext, input: string, inputKind: ArtifactInputKind = 'path') {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\0\r\n]/.test(input)) throw new Error('无效的文件路径。');
  let candidate = input;
  if (inputKind === 'reference') {
    // Strip editor locations before decoding so encoded literal # characters stay
    // literal. Never apply reference syntax to names returned by filesystem APIs.
    candidate = candidate.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
    if (/^file:/i.test(candidate)) {
      const url = new URL(candidate);
      if (url.username || url.password || url.search || url.hash || (url.hostname && url.hostname !== 'localhost')) throw new Error('只允许项目内的本地文件链接。');
      candidate = fileURLToPath(url);
    } else if (/%[\da-f]{2}/i.test(candidate)) {
      try { candidate = decodeURIComponent(candidate); }
      catch { throw new Error('文件链接的 URI 编码无效。'); }
    }
    // Markdown tools sometimes use /D:/folder/file.html for Windows absolute links.
    if (process.platform === 'win32' && /^\/[a-z]:[\\/]/i.test(candidate)) candidate = candidate.slice(1);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate)) throw new Error('此操作只接受本地文件。');
  const { root } = await workspaceBoundary(ctx);
  if (path.isAbsolute(candidate)) candidate = path.relative(root, path.resolve(candidate));
  return resolveWorkspacePath(ctx, normalizeRelative(candidate));
}

/** Bounded same-basename search over the project, skipping private directories. */
const SEARCH_ENTRY_BUDGET = 20000;
async function searchProjectByBasename(ctx: WorkspaceContext, wanted: string): Promise<string[]> {
  const { root } = await workspaceBoundary(ctx);
  const matches: string[] = [];
  let budget = SEARCH_ENTRY_BUDGET;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget-- <= 0 || matches.length >= 50) return;
      if (entry.name.startsWith('.') || /^(?:node_modules|runtime)$/i.test(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) matches.push(childRel);
    }
  };
  await walk(root, '');
  return matches;
}

/**
 * Agents often mention bare filenames (e.g. `index.html`) while the file they
 * created lives in a working subfolder, so root-relative resolution fails with
 * ENOENT. The session change journal knows where files were actually written;
 * a bounded project search covers pre-existing files the agent never wrote
 * (e.g. a SPEC.md seeded per task folder), preferring directories the sessions
 * actually worked in. Opens the unique best candidate, lists candidates when
 * several remain, and rethrows the original failure when nothing matches.
 */
export async function resolveBareFilename(
  ctx: WorkspaceContext,
  name: string,
  changes: Iterable<{ path: string }>,
  original: unknown,
  translateMessage: (source: string, values: Record<string, string | number>) => string = (source, values) => source.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? '')),
): Promise<{ root: string; absolute: string; relative: string }> {
  const wanted = path.basename(name).toLowerCase();
  const journal = [...changes].filter(change => !path.isAbsolute(change.path));
  const byName = journal.filter(change => path.basename(change.path).toLowerCase() === wanted);
  const openUnique = async (relative: string) => { try { return await resolveWorkspacePath(ctx, normalizeRelative(relative)); } catch { return null; } };
  if (byName.length === 1) {
    const target = await openUnique(byName[0].path);
    if (target) return target;
  }
  const candidates = new Set<string>(byName.map(change => change.path));
  if (candidates.size !== 1) {
    // Directories the sessions wrote into rank plain search hits: the SPEC.md a
    // conversation refers to is the one next to the files it changed.
    const journalDirs = new Set(journal.map(change => path.posix.dirname(change.path.replace(/\\/g, '/'))));
    const found = await searchProjectByBasename(ctx, wanted);
    const ranked = found.filter(relative => journalDirs.has(path.posix.dirname(relative)));
    for (const relative of ranked.length ? ranked : found) candidates.add(relative);
  }
  if (candidates.size === 1) {
    const target = await openUnique([...candidates][0]);
    if (target) return target;
  }
  if (candidates.size > 1) {
    throw new Error(translateMessage('项目内有多个同名文件：{names}。请使用完整路径打开。', { names: [...candidates].slice(0, 5).join('、') }));
  }
  throw original;
}

export function artifactKind(filename: string): ArtifactKind {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'html';
  if (imageExtensions.has(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (textExtensions.has(extension) || !extension) return 'text';
  return 'binary';
}

function privateAsset(relative: string) {
  return relative.split('/').some(segment => segment.startsWith('.') || /^(?:node_modules|runtime)$/i.test(segment));
}

/** One unguessable origin per preview; no app-origin privileges, IPC, network, forms or top navigation. */
export class ArtifactPreviews {
  private grants = new Map<string, WorkspaceContext>();
  async info(ctx: WorkspaceContext, input: string, inputKind: ArtifactInputKind = 'path'): Promise<ArtifactInfo> {
    const target = await resolveArtifactPath(ctx, input, inputKind);
    const stat = await fs.stat(target.absolute);
    const kind = artifactKind(target.relative);
    const result: ArtifactInfo = { path: target.relative, absolutePath: target.absolute, name: path.basename(target.absolute), kind, size: stat.size, canOpenExternally: !activeExtensions.has(path.extname(target.relative).toLowerCase()) };
    // Chromium's native PDF viewer is unavailable inside the opaque preview
    // sandbox. Keep PDFs available through the explicit system-opening actions.
    if (['html', 'image'].includes(kind) && stat.size <= MAX_PREVIEW_BYTES && !privateAsset(target.relative)) {
      const token = randomUUID();
      this.grants.set(token, { projectPath: ctx.projectPath, dataDir: ctx.dataDir, protectedRoots: [...ctx.protectedRoots] });
      // An open preview is replaceable by reopening the artifact, so bound retained capabilities.
      while (this.grants.size > 128) this.grants.delete(this.grants.keys().next().value!);
      result.previewUrl = `${PREVIEW_SCHEME}://${token}/${target.relative.split('/').map(encodeURIComponent).join('/')}`;
    }
    return result;
  }
  async response(request: Pick<Request, 'url' | 'method'>): Promise<Response> {
    try {
      const url = new URL(request.url);
      const ctx = this.grants.get(url.hostname);
      if (url.protocol !== `${PREVIEW_SCHEME}:` || !ctx || request.method !== 'GET' || url.username || url.password || url.port) return new Response('Forbidden', { status: 403 });
      const { root } = await workspaceBoundary(ctx);
      const relative = normalizeRelative(decodeURIComponent(url.pathname.slice(1)));
      if (privateAsset(relative)) return new Response('Forbidden', { status: 403 });
      const type = assetTypes[path.extname(relative).toLowerCase()];
      if (!type) return new Response('Unsupported preview resource', { status: 415 });
      const target = await resolveWorkspacePath(ctx, relative);
      // Recheck the real target: an in-project alias must not expose hidden metadata.
      const canonical = await fs.realpath(target.absolute);
      if (privateAsset(path.relative(root, canonical).split(path.sep).join('/'))) return new Response('Forbidden', { status: 403 });
      const handle = await fs.open(canonical, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return new Response('Preview resource too large', { status: 413 });
        const bytes = await handle.readFile();
        if (bytes.length > MAX_PREVIEW_BYTES) return new Response('Preview resource too large', { status: 413 });
        const origin = `${PREVIEW_SCHEME}://${url.hostname}`;
        const csp = `default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
        return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*' } });
      } finally { await handle.close(); }
    } catch { return new Response('File unavailable', { status: 404 }); }
  }
}
