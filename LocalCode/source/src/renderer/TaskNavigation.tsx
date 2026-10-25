import { t, useLocale } from './i18n';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, LoaderCircle, MoreHorizontal, Pin, PinOff, Search, SquarePen, X } from 'lucide-react';
import type { Project, SessionView, SidebarPreferences } from '../shared/contracts';
import './task-navigation.css';

const busy = (session: SessionView) => ['running', 'awaiting_approval'].includes(session.status);
const recent = (sessions: SessionView[]) => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
type MenuTarget = { project: Project; session?: never } | { session: SessionView; project?: never };

export default function TaskSidebar({ projects, sessions, activeProjectId, activeSessionId, preferences, onProject, onSession, onAddProject, onRename, onMove, onPin, onPreferences }: {
  projects: Project[]; sessions: SessionView[]; activeProjectId: string; activeSessionId: string; preferences: SidebarPreferences;
  onProject(id: string): void; onSession(session: SessionView): void; onAddProject(): void;
  onRename(session: SessionView): void; onMove(session: SessionView): void; onPin(project: Project): void;
  onPreferences(patch: Partial<SidebarPreferences>): void;
}) {
  useLocale();
  const [menu, setMenu] = useState<{ target: MenuTarget; x: number; y: number; trigger: HTMLElement } | null>(null);
  const [allProjects, setAllProjects] = useState<Record<string, boolean>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const showMenu = (event: React.MouseEvent<HTMLElement>, target: MenuTarget) => {
    event.preventDefault(); const box = event.currentTarget.getBoundingClientRect();
    setMenu({ target, x: Math.min(box.left, innerWidth - 210), y: Math.min(box.bottom + 4, innerHeight - 120), trigger: event.currentTarget });
  };
  const closeMenu = () => { menu?.trigger.focus(); setMenu(null); };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const task = (session: SessionView, grouped = false) => <div key={session.id} data-session-id={session.id} className={`task-row ${grouped ? 'project-task-row' : 'session-row'} ${session.id === activeSessionId ? 'active' : ''}`} onContextMenu={event => showMenu(event, { session })}>
    <button className={grouped ? 'project-session-button' : 'session-button'} onClick={() => onSession(session)} title={session.title}><span>{session.title}</span>{busy(session) && <LoaderCircle size={13} className={session.status === 'running' ? 'spin' : 'approval-dot'} />}</button>
    <button className="session-more icon-button" aria-label={t('任务选项 {title}', { title: session.title })} title={t("任务选项")} onClick={event => showMenu(event, { session })}><MoreHorizontal size={14} /></button>
  </div>;
  const projectGroup = (project: Project) => {
    const collapsed = preferences.collapsedProjects.includes(project.id), tasks = recent(sessions.filter(s => s.projectId === project.id));
    return <div className="project-group" data-project-id={project.id} key={project.id}>
      <div className="project-row" onContextMenu={event => showMenu(event, { project })}>
        <button className="project-chevron icon-button" aria-label={t(collapsed ? '展开项目 {name}' : '收起项目 {name}', { name: project.name })} aria-expanded={!collapsed} onClick={() => onPreferences({ collapsedProjects: collapsed ? preferences.collapsedProjects.filter(id => id !== project.id) : [...preferences.collapsedProjects, project.id] })}><ChevronRight size={13} className={collapsed ? '' : 'rotate-90'} /></button>
        <button className={`project-item ${activeProjectId === project.id ? 'active' : ''}`} onClick={() => onProject(project.id)} title={project.path}>{activeProjectId === project.id ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{project.name}</span></button>
        <button className="project-more icon-button" aria-label={t('项目选项 {name}', { name: project.name })} title={t("项目选项")} onClick={event => showMenu(event, { project })}>{project.pinned ? <Pin size={13} /> : <MoreHorizontal size={14} />}</button>
      </div>
      {!collapsed && <div className="project-tasks">{(allProjects[project.id] ? tasks : tasks.slice(0, 5)).map(s => task(s, true))}{tasks.length > 5 && <button className="show-project-tasks" onClick={() => setAllProjects(previous => ({ ...previous, [project.id]: !previous[project.id] }))}>{allProjects[project.id] ? t('收起显示') : t('展开显示')}</button>}</div>}
    </div>;
  };
  const heading = (title: string, key: 'pinnedCollapsed' | 'projectsCollapsed' | 'recentCollapsed', extra?: React.ReactNode) => <div className="section-label task-section-label"><button className="section-toggle" aria-label={t(preferences[key] ? '展开{section}' : '收起{section}', { section: t(title) })} aria-expanded={!preferences[key]} onClick={() => onPreferences({ [key]: !preferences[key] })}><span>{t(title)}</span><ChevronRight size={13} className={preferences[key] ? '' : 'rotate-90'} /></button>{extra}</div>;
  return <div className="task-sidebar-content">
    {projects.some(p => p.pinned) && <section aria-label={t("置顶项目")}>{heading(t('置顶'), 'pinnedCollapsed')}{!preferences.pinnedCollapsed && projects.filter(p => p.pinned).map(projectGroup)}</section>}
    <section aria-label={t("项目分组")}>{heading(t('项目'), 'projectsCollapsed', <button className="icon-button" aria-label={t("打开项目文件夹")} title={t("添加项目")} onClick={onAddProject}><FolderPlus size={15} /></button>)}
      {!preferences.projectsCollapsed && <nav className="grouped-projects" aria-label={t("项目列表")}>{projects.filter(p => !p.pinned).map(projectGroup)}{!projects.length && <button className="add-first-project" onClick={onAddProject}><FolderPlus size={16} />{t("添加项目")}</button>}</nav>}
    </section>
    <section aria-label={t("最近任务")}>{heading(t('最近'), 'recentCollapsed')}{!preferences.recentCollapsed && <nav className="session-list" aria-label={t("会话记录")}>{recent(sessions).map(s => task(s))}{!sessions.length && <p className="sidebar-empty">{t("开始对话，任务会保存在这里。")}</p>}</nav>}</section>
    {menu && createPortal(<div ref={menuRef} className="sidebar-item-menu" role="menu" aria-label={t("侧栏选项")} style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
      if (event.key === 'Tab') setMenu(null);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') || [])]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    }}>{menu.target.project ? <>
      <button role="menuitem" onClick={() => { onPin(menu.target.project!); closeMenu(); }}>{menu.target.project.pinned ? <PinOff size={15} /> : <Pin size={15} />}{menu.target.project.pinned ? t('取消置顶项目') : t('置顶项目')}</button>
      <button role="menuitem" onClick={() => { onProject(menu.target.project!.id); closeMenu(); }}><SquarePen size={15} />{t("在此项目中新建任务")}</button>
    </> : <>
      <button role="menuitem" onClick={() => { onRename(menu.target.session!); closeMenu(); }}><SquarePen size={15} />{t("重命名任务")}</button>
      {!menu.target.session!.projectId && <button role="menuitem" disabled={busy(menu.target.session!)} onClick={() => { onMove(menu.target.session!); closeMenu(); }}><Folder size={15} />{t("移入项目")}</button>}
    </>}</div>, document.body)}
  </div>;
}

export function ProjectPicker({ projects, value, onChange, onCreate, disabled = false }: { projects: Project[]; value: string | null; onChange(value: string | null): void; onCreate(): void; disabled?: boolean }) {
  useLocale();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const project = projects.find(p => p.id === value);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); };
  }, [open]);
  const choose = (id: string | null) => { onChange(id); close(); };
  return <><button ref={trigger} className="workspace-picker-trigger" type="button" aria-label={t("选择工作项目")} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={project?.path || t('不在项目中工作')} onClick={() => { if (open) { close(); return; } const rect = trigger.current!.getBoundingClientRect(); setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 340)), bottom: innerHeight - rect.top + 8 }); setQuery(''); setOpen(true); }}><Folder size={15} /><span>{project?.name || t('不在项目中工作')}</span><ChevronDown size={13} /></button>
    {open && createPortal(<div ref={panel} className="workspace-picker-panel" role="dialog" aria-label={t("选择工作项目")} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const options = [...panel.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')]; const index = options.indexOf(document.activeElement as HTMLButtonElement); options[index < 0 ? event.key === 'ArrowUp' ? options.length - 1 : 0 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length]?.focus(); }
    }}><label className="workspace-search"><Search size={16} /><input ref={search} aria-label={t("搜索项目")} placeholder={t("搜索项目")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="workspace-options" role="listbox" aria-label={t("工作项目")}>{projects.filter(p => `${p.name} ${p.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(p => <button type="button" role="option" aria-selected={p.id === value} key={p.id} onClick={() => choose(p.id)} title={p.path}><Folder size={16} /><span>{p.name}</span>{p.id === value && <Check size={16} />}</button>)}<button type="button" role="option" aria-selected={!value} onClick={() => choose(null)}><X size={16} /><span>{t("不在项目中工作")}</span>{!value && <Check size={16} />}</button></div>
      <button className="workspace-create" type="button" onClick={() => { close(); onCreate(); }}><FolderPlus size={16} />{t("新建项目")}</button>
    </div>, document.body)}
  </>;
}

export function MoveTaskDialog({ session, projects, onMove, onCreate, onClose }: { session: SessionView; projects: Project[]; onMove(id: string): Promise<void>; onCreate(): Promise<void>; onClose(): void }) {
  useLocale();
  const [query, setQuery] = useState(''), [pending, setPending] = useState(false);
  const run = async (action: () => Promise<void>) => { if (pending) return; setPending(true); try { await action(); } finally { setPending(false); } };
  return <div className="modal-backdrop" onMouseDown={event => { if (!pending && event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (!pending && event.key === 'Escape') onClose(); }}><section className="move-task-dialog" role="dialog" aria-modal="true" aria-label={t("移入项目")}><header><h2>{t("移入项目")}</h2><button className="icon-button" aria-label={t("取消移动")} disabled={pending} onClick={onClose}><X size={17} /></button></header><p>{session.title}</p><label className="workspace-search"><Search size={16} /><input autoFocus aria-label={t("搜索目标项目")} placeholder={t("搜索项目")} value={query} onChange={event => setQuery(event.target.value)} disabled={pending} /></label><div className="move-project-options">{projects.filter(p => `${p.name} ${p.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(p => <button key={p.id} disabled={pending} onClick={() => void run(() => onMove(p.id))} title={p.path}><Folder size={16} /><span>{p.name}</span><ChevronRight size={14} /></button>)}{!projects.length && <p>{t("添加项目后，可把当前任务移入其中。")}</p>}</div><button className="workspace-create" disabled={pending} onClick={() => void run(onCreate)}><FolderPlus size={16} />{t("新建项目并移入")}</button></section></div>;
}
