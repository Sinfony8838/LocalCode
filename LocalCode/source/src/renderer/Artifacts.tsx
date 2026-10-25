import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Code2, Copy, ExternalLink, FileCode2, FolderOpen, LoaderCircle, Maximize2, Minimize2, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import type { ArtifactAction, ArtifactInfo, ArtifactInputKind } from '../shared/artifacts';
import type { FileView } from '../shared/contracts';

type ViewMode = 'preview' | 'source';
type ArtifactController = ReturnType<typeof useArtifactController>;
export const ArtifactContext = createContext<ArtifactController | null>(null);

/** Only presentation recognition; the main process resolves and authorizes every path. */
export function isFileReference(value: string) {
  if (/^(?:https?:|mailto:|#)/i.test(value)) return false;
  return /^(?:file:|[a-z]:[\\/]|[./\\])/i.test(value) || /^[^\n<>]+\.[a-z\d]{1,12}(?:[?#].*)?$/i.test(value);
}
export function markdownUrl(value: string) {
  return /^(?:https?:|mailto:)/i.test(value) || isFileReference(value) || !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(value) ? value : '';
}

export function useArtifactController({ projectId, onError, onOpen }: { projectId: string; onError: (error: unknown) => void; onOpen: () => void }) {
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [source, setSource] = useState<FileView | null>(null);
  const [mode, setMode] = useState<ViewMode>('preview');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; info?: ArtifactInfo; error?: string; trigger: HTMLElement | null } | null>(null);
  const request = useRef(0);
  const menuRequest = useRef(0);
  const close = () => { request.current++; setArtifact(null); setSource(null); setLoading(false); setExpanded(false); };
  useEffect(() => { close(); menuRequest.current++; setMenu(null); }, [projectId]);
  const open = async (filePath: string, desired: ViewMode = 'preview', inputKind: ArtifactInputKind = 'path') => {
    if (!projectId) return;
    const revision = ++request.current;
    setLoading(true); setArtifact(null); setSource(null); onOpen();
    try {
      const info = await window.localcode.artifactInfo({ projectId, path: filePath, inputKind });
      if (request.current !== revision) return;
      const nextMode = desired === 'source' || info.kind === 'text' ? 'source' : 'preview';
      let text: FileView | null = null;
      if (nextMode === 'source') text = await window.localcode.readFile({ projectId, path: info.path });
      if (request.current !== revision) return;
      setArtifact(info); setMode(nextMode); setSource(text); setReload(value => value + 1);
    } catch (error) { if (request.current === revision) onError(error); }
    finally { if (request.current === revision) setLoading(false); }
  };
  const act = async (path: string, action: ArtifactAction) => {
    try { await window.localcode.artifactAction({ projectId, path, action }); }
    catch (error) { onError(error); }
  };
  const openExternal = async (url: string) => {
    try { await window.localcode.openExternal(url); }
    catch (error) { onError(error); }
  };
  const showMenu = async (event: React.MouseEvent | React.KeyboardEvent, path: string, inputKind: ArtifactInputKind = 'path') => {
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const position = { x: 'clientX' in event && event.clientX ? event.clientX : rect.left, y: 'clientY' in event && event.clientY ? event.clientY : rect.bottom };
    const revision = ++menuRequest.current;
    setMenu({ path, ...position, trigger: target });
    try {
      const info = await window.localcode.artifactInfo({ projectId, path, inputKind });
      if (menuRequest.current === revision) setMenu({ path: info.path, ...position, info, trigger: target });
    } catch (error) { if (menuRequest.current === revision) setMenu({ path, ...position, error: error instanceof Error ? error.message : String(error), trigger: target }); }
  };
  const closeMenu = (restore = false) => { menuRequest.current++; if (restore) menu?.trigger?.focus(); setMenu(null); };
  return { artifact, source, mode, loading, expanded, reload, menu, open, close, act, openExternal, showMenu, closeMenu, setExpanded };
}

export function ExternalWebLink({ href, children }: { href: string; children: React.ReactNode }) {
  const controller = useContext(ArtifactContext);
  return <a className="markdown-link" href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void controller?.openExternal(href); }}>{children}</a>;
}

export function ArtifactLink({ path, inputKind = 'path', children, className = '', label }: { path: string; inputKind?: ArtifactInputKind; children: React.ReactNode; className?: string; label?: string }) {
  const controller = useContext(ArtifactContext);
  if (!controller) return <span>{children}</span>;
  return <a href={path} className={`artifact-link ${className}`} title={path} aria-label={label} onClick={event => { event.preventDefault(); void controller.open(path, 'preview', inputKind); }} onContextMenu={event => void controller.showMenu(event, path, inputKind)} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') void controller.showMenu(event, path, inputKind); }}>{children}</a>;
}

export function ArtifactPanel({ controller: c }: { controller: ArtifactController }) {
  if (!c.artifact && !c.loading) return null;
  const info = c.artifact;
  return <aside className={`artifact-panel ${c.expanded ? 'expanded' : ''}`} aria-label="文件查看器">
    <header className="artifact-header"><FileCode2 size={16} /><strong title={info?.absolutePath}>{info?.name || '正在打开文件…'}</strong><button className="icon-button" aria-label={c.expanded ? '还原预览大小' : '展开预览'} onClick={() => c.setExpanded(!c.expanded)}>{c.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button><button className="icon-button" aria-label="关闭文件预览" onClick={c.close}><X size={16} /></button></header>
    {info && <div className="artifact-toolbar"><div role="group" aria-label="文件查看方式"><button className={c.mode === 'preview' ? 'active' : ''} disabled={!info.previewUrl} onClick={() => void c.open(info.path, 'preview')}>预览</button><button className={c.mode === 'source' ? 'active' : ''} disabled={!['html', 'text'].includes(info.kind)} onClick={() => void c.open(info.path, 'source')}>源码</button></div><button className="icon-button" aria-label="刷新文件预览" onClick={() => void c.open(info.path, c.mode)}><RefreshCw size={14} /></button><button className="icon-button" aria-label="文件打开方式" onClick={event => void c.showMenu(event, info.path)}><MoreHorizontal size={17} /></button></div>}
    {c.loading ? <div className="panel-loading"><LoaderCircle size={20} className="spin" />正在读取文件…</div> : info && (c.mode === 'source' ? <><div className="file-readonly">只读源码{c.source?.truncated && ' · 内容已截断'}</div><pre className="artifact-source" tabIndex={0}>{c.source?.content}</pre></> : info.previewUrl ? <iframe key={`${info.previewUrl}-${c.reload}`} className="artifact-frame" title="文件预览" src={info.previewUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" /> : <div className="panel-empty"><FileCode2 size={30} /><h3>使用其他应用查看此文件</h3><p>{info.name}</p><button className="secondary-button" disabled={!info.canOpenExternally} onClick={() => void c.act(info.path, 'open')}><ExternalLink size={15} />使用默认应用打开</button><button className="secondary-button" onClick={() => void c.act(info.path, 'reveal')}><FolderOpen size={15} />打开所在目录</button></div>)}
    {info && <footer className="artifact-footer" title={info.absolutePath}>{info.path}{c.mode === 'preview' && info.kind === 'html' ? ' · 本地预览' : ''}</footer>}
  </aside>;
}

export function ArtifactMenu({ controller: c }: { controller: ArtifactController }) {
  const panel = useRef<HTMLDivElement>(null);
  const menu = c.menu;
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!panel.current?.contains(event.target as Node)) c.closeMenu(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); c.closeMenu(true); }
      if (event.key === 'Tab') c.closeMenu();
    };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key); window.addEventListener('blur', close); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [menu]);
  useEffect(() => { if (menu?.info) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [menu?.info]);
  if (!menu) return null;
  const info = menu.info;
  const choose = (action: ViewMode | ArtifactAction) => { c.closeMenu(); if (action === 'preview' || action === 'source') void c.open(menu.path, action); else void c.act(menu.path, action); };
  return <div ref={panel} role="menu" aria-label="文件打开方式" className="artifact-menu" style={{ left: Math.max(8, Math.min(menu.x, innerWidth - 294)), top: Math.max(8, Math.min(menu.y, innerHeight - 350)) }} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }}>
    <div className="artifact-menu-name" title={menu.path}>{info?.name || menu.path}</div>
    {!info ? <p>{menu.error || '正在读取文件信息…'}</p> : <>
      <button role="menuitem" disabled={!info.previewUrl} onClick={() => choose('preview')}><FileCode2 size={15} />在应用内预览</button>
      <button role="menuitem" disabled={!['html', 'text'].includes(info.kind)} onClick={() => choose('source')}><Code2 size={15} />查看源码</button>
      <div className="artifact-menu-divider" />
      <button role="menuitem" disabled={!info.canOpenExternally} onClick={() => choose('open')}><ExternalLink size={15} />使用默认应用打开</button>
      <button role="menuitem" onClick={() => choose('choose-app')}><MoreHorizontal size={15} />选择其他应用打开</button>
      <button role="menuitem" onClick={() => choose('reveal')}><FolderOpen size={15} />在文件资源管理器中显示</button>
      <button role="menuitem" onClick={() => choose('copy-path')}><Copy size={15} />复制完整路径</button>
    </>}
  </div>;
}
