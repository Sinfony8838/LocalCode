import BrandLogo from './BrandLogo';
import { t, useLocale, setLocale, errorText } from './i18n';
import { APP_LOCALES, LOCALE_NAMES, type AppLocale } from '../shared/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { diffLines } from 'diff';
import PetControls from './PetControls';
import ModelSettings from './ModelSettings';
import Composer, { AttachmentStrip, emptyDraft, type ComposerDraft } from './Composer';
import { ApprovalCard, GoalCard, PlanCard, QuestionCard } from './AgentControls';
import TaskSidebar, { MoveTaskDialog, ProjectPicker } from './TaskNavigation';
import { ArtifactContext, ArtifactLink, ArtifactMenu, ArtifactPanel, ExternalWebLink, isFileReference, markdownUrl, useArtifactController } from './Artifacts';
import RunSummary, { RunTiming } from './RunSummary';
import ChangeCheckpointDialog from './ChangeCheckpointDialog';
import { reduceAgentEvent } from '../shared/session-events';
import { providerModels } from '../shared/providers';
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SIDEBAR } from '../shared/contracts';
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Bot, Check, ChevronDown,
  ChevronRight, Circle, Clipboard, Code2, Cpu, FileCode2, FilePlus2, Files, Folder,
  FolderOpen, FolderPlus, GitCompareArrows, History, LoaderCircle, MessageSquare,
  Monitor, Moon, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus, RefreshCw,
  Search, Send, Settings2, ShieldCheck, Sparkles, Square, Sun, Terminal, Trash2,
  PanelLeftClose, PanelLeftOpen, SquarePen, UserRound, Info, Home,
  Undo2, X, Brain, Languages,
} from 'lucide-react';
import type {
  MessagePart, RunProgress, AgentEvent, AppSettings, Bootstrap, ChangeCheckpointPreview, ChangeView, ChatMessage, FileEntry, FileView, RunSummary as RunSummaryRecord,
  ModelHealth, Project, ProviderConfig, RunStatus, SessionView, Theme, ToolRecord, SidebarPreferences,
} from '../shared/contracts';

const STATUS_LABELS: Record<RunStatus, string> = {
  idle: '准备就绪', running: '正在处理', awaiting_approval: '等待批准', awaiting_input: '等待回答',
  completed: '已完成', failed: '运行失败', interrupted: '已停止',
};
const TOOL_LABELS: Record<string, string> = {
  read: '读取文件', read_file: '读取文件', write: '写入文件', write_file: '写入文件',
  edit: '修改文件', edit_file: '修改文件', list: '浏览目录', list_files: '浏览目录',
  browse: '浏览目录', find: '查找文件', grep: '搜索代码', search: '搜索代码',
  search_files: '搜索代码', powershell: '运行命令', shell: '运行命令',
  load_skill: '读取桌宠定制 Skill',
};
const isBusy = (status?: RunStatus) => status === 'running' || status === 'awaiting_approval' || status === 'awaiting_input';
const shortPath = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();
const sortSessions = (sessions: SessionView[]) => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
export const sessionTitle = (session: SessionView) => session.title === '新会话' && !session.messages.length ? t('新会话') : session.title;
const draftSignature = (draft: ComposerDraft) => JSON.stringify({ text: draft.text, attachmentIds: draft.attachments.map(item => item.id), approvalMode: draft.approvalMode, workMode: draft.workMode, goal: draft.goal });

export default function App() {
  useLocale();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeProjectId, setActiveProjectId] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [pendingImports, setPendingImports] = useState<Record<string, number>>({});
  const [pendingInteractions, setPendingInteractions] = useState<Record<string, boolean>>({});
  const [draftModels, setDraftModels] = useState<Record<string, { providerId: string; modelId: string }>>({});
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsEntryTab>('models');
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = useCallback((tab: SettingsEntryTab = 'models', opener?: HTMLElement | null) => {
    settingsOpener.current = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'files' | 'changes'>('changes');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesRevision, setFilesRevision] = useState(0);
  const [directory, setDirectory] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [changes, setChanges] = useState<ChangeView[]>([]);
  const [changePath, setChangePath] = useState('');
  const [checkpointPreview, setCheckpointPreview] = useState<(ChangeCheckpointPreview & { sessionId: string }) | null>(null);
  const [checkpointPending, setCheckpointPending] = useState(false);
  const [checkpointError, setCheckpointError] = useState('');
  const checkpointRequest = useRef(0);
  const checkpointLock = useRef(false);
  const checkpointOpener = useRef<HTMLButtonElement | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, boolean>>({});
  const [pendingStops, setPendingStops] = useState<Record<string, boolean>>({});
  const sendLocks = useRef(new Set<string>());
  const importLocks = useRef(new Set<string>());
  const [healthPending, setHealthPending] = useState(false);
  const [renameId, setRenameId] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [moveSessionId, setMoveSessionId] = useState('');
  const navigationRevision = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const activeSessionRef = useRef(activeSessionId);
  const activeProjectRef = useRef(activeProjectId);
  const eventRevision = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = Boolean(window.localcode);
  const artifacts = useArtifactController({ projectId: activeProjectId, onError: failure => setError(errorText(failure)), onOpen: () => { setInspectorOpen(false); setSidebarOpen(false); } });
  const artifactOpen = Boolean(artifacts.artifact || artifacts.loading);

  activeSessionRef.current = activeSessionId;
  activeProjectRef.current = activeProjectId;
  const sessions = boot?.sessions || [];
  const activeSession = sessions.find(session => session.id === activeSessionId);
  const project = boot?.projects.find(item => item.id === activeProjectId);
  const sidebarPreferences = boot?.settings.sidebar || DEFAULT_SIDEBAR;
  const backgroundSessions = sessions.filter(session => isBusy(session.status) && session.id !== activeSessionId);
  const busySession = backgroundSessions[0];
  const busy = isBusy(activeSession?.status);
  const changesBusy = sessions.some(session => isBusy(session.status)) || Object.values(pendingActions).some(Boolean) || checkpointPending;
  const draftKey = activeSessionId || 'new-task';
  const actionPending = Boolean(pendingActions[draftKey]);
  const approvalPending = Boolean(pendingApprovals[activeSessionId]);
  const stopPending = Boolean(pendingStops[activeSessionId]);
  const draft = drafts[draftKey] || emptyDraft(activeSession);
  const importing = Boolean(pendingImports[draftKey]);
  const interactionPending = Boolean(pendingInteractions[activeSessionId]);
  const providers = boot?.settings.providers || [];
  const choices = providers.filter(p => p.enabled !== false).flatMap(p => providerModels(p).filter(m => m.enabled).map(m => ({ provider: p, model: m })));
  const requestedProviderId = providerId || providers[0]?.id;
  const choice = choices.find(c => c.provider.id === requestedProviderId && (!modelId || c.model.id === modelId));
  const provider = choice ? { ...choice.provider, model: choice.model.id, contextWindow: choice.model.contextWindow, maxTokens: choice.model.maxTokens, supportsImages: choice.model.supportsImages ?? choice.provider.supportsImages } : undefined;
  useEffect(() => {
    if (!activeSessionId) return;
    setDraftModels(previous => {
      const saved = previous[activeSessionId];
      if (!saved || saved.providerId === providerId && saved.modelId === modelId) return previous;
      return { ...previous, [activeSessionId]: { providerId, modelId } };
    });
  }, [activeSessionId, providerId, modelId]);
  const cloudSelected = Boolean(provider && provider.kind !== 'ollama');
  const cloudConfigured = choices.some(c => c.provider.kind !== 'ollama' && c.provider.hasKey);
  const needsModelSetup = Boolean(boot && (cloudSelected ? !provider?.hasKey : !boot.health.modelAvailable));
  const selectedChange = changes.find(change => change.path === changePath) || changes[0];

  const putSession = useCallback((session: SessionView) => {
    setBoot(previous => previous ? { ...previous, sessions: previous.sessions.some(item => item.id === session.id)
      ? previous.sessions.map(item => item.id === session.id ? session : item) : [session, ...previous.sessions] } : previous);
  }, []);

  const refresh = useCallback(async () => {
    if (!window.localcode) return;
    const revision = eventRevision.current;
    const state = await window.localcode.bootstrap();
    setBoot(previous => {
      if (!previous || revision === eventRevision.current) return state;
      // Keep streamed session state if events arrived while the snapshot was in flight.
      const localSessions = new Map(previous.sessions.map(session => [session.id, session]));
      return { ...state, sessions: state.sessions.map(session => {
        const local = localSessions.get(session.id);
        return local && local.updatedAt > session.updatedAt ? local : session;
      }) };
    });
    return state;
  }, []);

  const refreshChanges = useCallback(async (sessionId = activeSessionRef.current) => {
    if (!sessionId || !window.localcode) { setChanges([]); return; }
    try {
      const next = await window.localcode.changes(sessionId);
      if (activeSessionRef.current === sessionId) setChanges(next);
    } catch (failure) { setError(errorText(failure)); }
  }, []);

  useEffect(() => {
    if (!window.localcode) { setLoading(false); return; }
    let disposed = false;
    window.localcode.bootstrap().then(state => {
      if (disposed) return;
      setLocale(state.settings.locale);
      setBoot(state);
      const latest = sortSessions(state.sessions)[0];
      setActiveProjectId(latest?.projectId || '');
      setActiveSessionId(latest?.id || '');
      setModelId(latest?.modelId || ''); setProviderId(latest?.providerId || state.settings.defaultProviderId || state.settings.providers[0]?.id || '');
    }).catch(failure => !disposed && setError(errorText(failure))).finally(() => !disposed && setLoading(false));
    const unsubscribe = window.localcode.onEvent(event => {
      eventRevision.current++;
      if (event.type === 'state_changed') {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void refresh().catch(failure => setError(errorText(failure))), 70);
        return;
      }
      setBoot(previous => previous ? { ...previous, sessions: previous.sessions.map(session => reduceAgentEvent(session, event)) } : previous);
      if (event.type === 'notice' && event.sessionId === activeSessionRef.current) setNotice(event.message);
      if (event.type === 'changes_updated' || event.type === 'settled') {
        if (event.sessionId === activeSessionRef.current) setFilesRevision(value => value + 1);
        if (changesTimer.current) clearTimeout(changesTimer.current);
        changesTimer.current = setTimeout(() => void refreshChanges(), 120);
      }
      if (event.type === 'settled') {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void refresh().catch(failure => setError(errorText(failure))), 120);
      }
    });
    return () => { disposed = true; unsubscribe(); if (refreshTimer.current) clearTimeout(refreshTimer.current); if (changesTimer.current) clearTimeout(changesTimer.current); };
  }, [refresh, refreshChanges]);

  useEffect(() => { if (boot) setLocale(boot.settings.locale); }, [boot?.settings.locale]);
  useEffect(() => { document.documentElement.dataset.theme = boot?.settings.theme || 'light'; }, [boot?.settings.theme]);
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * (boot?.settings.fontSize ?? DEFAULT_FONT_SIZE) / DEFAULT_FONT_SIZE}px`;
  }, [boot?.settings.fontSize]);
  useEffect(() => {
    let disposed = false;
    setFileView(null);
    if (!activeProjectId || !window.localcode) { setFiles([]); setFileLoading(false); return; }
    setFileLoading(true);
    window.localcode.listFiles({ projectId: activeProjectId, directory }).then(entries => !disposed && setFiles(entries))
      .catch(failure => !disposed && setError(errorText(failure))).finally(() => !disposed && setFileLoading(false));
    return () => { disposed = true; };
  }, [activeProjectId, directory, filesRevision]);
  useEffect(() => { if (inspectorOpen) artifacts.close(); }, [inspectorOpen]);
  useEffect(() => {
    setChanges([]); setChangePath(''); setNotice('');
    void refreshChanges(activeSessionId);
  }, [activeSessionId, refreshChanges]);
  useEffect(() => {
    // A delayed preview must not reopen after the user navigates away.
    checkpointRequest.current++; checkpointLock.current = false;
    setCheckpointPreview(null); setCheckpointError(''); setCheckpointPending(false);
  }, [activeSessionId, activeProjectId, inspectorOpen, inspectorTab, changePath]);
  useEffect(() => {
    if (atBottom && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activeSession?.messages, activeSession?.tools, activeSession?.approval, activeSession?.runs, atBottom]);
  useEffect(() => {
    setAtBottom(true);
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
  }, [activeSessionId]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [draft.text, boot?.settings.fontSize]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); openSettings(); }
      if (event.key === 'Escape') { setSettingsOpen(false); setRenameId(''); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const moveTask = async (sessionId: string, projectId: string) => {
    try {
      const moved = await window.localcode.moveSession({ sessionId, projectId });
      putSession(moved); setMoveSessionId('');
      if (activeSessionRef.current === sessionId) { navigationRevision.current++; setActiveProjectId(projectId); setDirectory(''); artifacts.close(); }
    } catch (failure) { setError(errorText(failure)); }
  };

  const openProject = async (moveId?: string) => {
    const navigation = ++navigationRevision.current;
    try {
      const next = await window.localcode.pickProject();
      if (!next) return;
      await refresh();
      if (moveId) await moveTask(moveId, next.id);
      else if (navigation === navigationRevision.current) selectProject(next.id);
      textareaRef.current?.focus();
    } catch (failure) { setError(errorText(failure)); }
  };

  const selectProject = (id: string) => {
    navigationRevision.current++;
    setActiveProjectId(id); setDirectory(''); setFileView(null);
    setActiveSessionId(''); setNotice(''); artifacts.close();
  };

  const openSession = async (session: SessionView) => {
    navigationRevision.current++;
    const selection = draftModels[session.id];
    setActiveProjectId(session.projectId || ''); setActiveSessionId(session.id); setProviderId(selection?.providerId ?? session.providerId); setModelId(selection?.modelId ?? session.modelId ?? ''); setDirectory('');
    try {
      const revision = eventRevision.current;
      const current = await window.localcode.openSession(session.id);
      if (revision === eventRevision.current) putSession(current);
    } catch (failure) { setError(errorText(failure)); }
  };

  const goHome = () => {
    navigationRevision.current++;
    // Home is navigation only. Keep history, per-session drafts and active runs intact.
    setActiveSessionId(''); setNotice(''); setAtBottom(true);
    setInspectorOpen(false); artifacts.close(); artifacts.closeMenu();
    textareaRef.current?.focus();
  };

  const newSession = () => {
    goHome(); setActiveProjectId(''); setDirectory(''); setFileView(null);
  };
  const createPetInProject = async (input: { name: string; description: string }) => {
    const navigation = ++navigationRevision.current;
    let projectId = activeProjectId;
    if (!projectId) {
      const picked = await window.localcode.pickProject();
      if (!picked) return;
      await refresh(); projectId = picked.id;
    }
    if (navigation !== navigationRevision.current) return;
    const session = await window.localcode.createSession(projectId);
    putSession(session);
    const prompt = t('$create-desktop-pet\n请使用桌宠定制 Skill，为当前项目创建一个 LocalCode 虚拟宠物。\n名称：{name}\n角色与风格：{description}\n先读取 Skill，使用我选择的模型完成设计与制作流程。需要生图时检查图片 API 配置，缺少时说明所需配置，不要把聊天 API 当作图片 API。产物保存在项目内的新目录，输出通过校验的 pet.json 和 pet.png，并说明预览与导入方式。', { name: input.name, description: input.description || t('请先和我确认角色外观与风格。') });
    setDrafts(previous => ({ ...previous, [session.id]: { ...emptyDraft(session), text: prompt } }));
    setDraftModels(previous => ({ ...previous, [session.id]: { providerId: provider?.id || providerId, modelId: provider?.model || modelId } }));
    if (navigation !== navigationRevision.current) return;
    setActiveProjectId(projectId); setActiveSessionId(session.id); setDirectory(''); setFileView(null);
    setNotice(t('桌宠定制任务已准备好。确认模型和描述后发送。')); setSettingsOpen(false);
    setInspectorOpen(false); artifacts.close(); artifacts.closeMenu();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const chooseWorkspace = (projectId: string | null) => {
    if (activeSession) { if (projectId && !activeSession.projectId) void moveTask(activeSession.id, projectId); }
    else selectProject(projectId || '');
  };
  const updateSidebar = async (patch: Partial<SidebarPreferences>) => {
    setBoot(previous => previous ? { ...previous, settings: { ...previous.settings, sidebar: { ...DEFAULT_SIDEBAR, ...previous.settings.sidebar, ...patch } } } : previous);
    try { await window.localcode.setSidebar(patch); }
    catch (failure) { setError(errorText(failure)); await refresh(); }
  };
  const togglePinned = async (project: Project) => {
    try { const updated = await window.localcode.setProjectPinned({ projectId: project.id, pinned: !project.pinned }); setBoot(previous => previous ? { ...previous, projects: previous.projects.map(p => p.id === updated.id ? updated : p) } : previous); }
    catch (failure) { setError(errorText(failure)); }
  };

  const updateDraft = (patch: Partial<ComposerDraft>, key = draftKey) => {
    const fallback = emptyDraft(sessions.find(session => session.id === key));
    setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] || fallback), ...patch } }));
  };

  const attach = async (files?: File[], folders = false) => {
    const key = draftKey;
    if (importLocks.current.has(key) || pendingActions[key]) return;
    const base = draft;
    const attachmentDraftKey = base.attachmentDraftKey || key;
    importLocks.current.add(key);
    setPendingImports(previous => ({ ...previous, [key]: 1 }));
    try {
      if (files && !files.length) return;
      if (files && base.attachments.length + files.length > 10) throw new Error('每条消息最多添加 10 个附件。');
      if (files?.some(file => file.size > 10 * 1024 * 1024)) throw new Error('单个图片不能超过 10 MiB，文本不能超过 2 MiB。');
      if (files && files.reduce((total, file) => total + file.size, base.attachments.reduce((total, file) => total + file.size, 0)) > 50 * 1024 * 1024) throw new Error('每条消息的附件总大小不能超过 50 MiB。');
      const imported = files ? await window.localcode.importAttachments({ draftKey: attachmentDraftKey, files: await Promise.all(files.map(file => new Promise<{ name: string; data: string }>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
        reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] || '' }); reader.readAsDataURL(file);
      }))) }) : await window.localcode.pickAttachments({ draftKey: attachmentDraftKey, folders });
      if (!imported.length) return;
      if (base.attachments.length + imported.length > 10) throw new Error('每条消息最多添加 10 个附件，请先移除部分附件。');
      if (base.attachments.reduce((total, item) => total + item.size, 0) + imported.reduce((total, item) => total + item.size, 0) > 50 * 1024 * 1024) throw new Error('每条消息的附件总大小不能超过 50 MiB。');
      // Attach to the originating draft even when a picker or import finishes after navigation.
      setDrafts(previous => { const current = previous[key] || base; return { ...previous, [key]: { ...current, attachmentDraftKey, attachments: [...current.attachments, ...imported] } }; });
    } catch (failure) { setError(errorText(failure)); }
    finally { importLocks.current.delete(key); setPendingImports(previous => ({ ...previous, [key]: 0 })); }
  };

  const interaction = async (sessionId: string, action: () => Promise<unknown>) => {
    if (pendingInteractions[sessionId]) return;
    setPendingInteractions(previous => ({ ...previous, [sessionId]: true }));
    try { await action(); await refresh(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setPendingInteractions(previous => ({ ...previous, [sessionId]: false })); }
  };

  const acceptPlan = () => {
    const session = activeSession;
    if (!session?.plan || !provider || busy || interactionPending) return;
    void interaction(session.id, async () => {
      await window.localcode.acceptPlan({ sessionId: session.id, planId: session.plan!.id, providerId: provider.id, modelId: provider.model });
      updateDraft({ workMode: 'execute' }, session.id);
    });
  };

  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const prompt = draft.text.trim() || draft.goal?.objective || '';
    if ((!prompt && !draft.attachments.length) || busy || importing || sendLocks.current.has(draftKey) || !provider) return;
    if (draft.attachments.some(item => item.kind === 'image') && provider.supportsImages !== true) { setError('请先选择支持图片的模型。'); return; }
    if (draft.goal && provider.kind === 'ollama') { setError('目标模式需要外部模型。'); return; }
    const navigation = navigationRevision.current;
    const oldDraftKey = draftKey;
    let targetId = activeSessionId;
    let accepted = false;
    sendLocks.current.add(oldDraftKey);
    setPendingActions(previous => ({ ...previous, [oldDraftKey]: true })); setError(''); setNotice(''); setAtBottom(true);
    try {
      let session = activeSession;
      if (!session) { session = await window.localcode.createSession(activeProjectId || null); putSession(session); if (navigation === navigationRevision.current && activeProjectRef.current === activeProjectId && !activeSessionRef.current) setActiveSessionId(session.id); }
      targetId = session.id;
      sendLocks.current.add(targetId);
      setPendingActions(previous => ({ ...previous, [targetId]: true }));
      await window.localcode.send({ sessionId: session.id, prompt, providerId: provider.id, modelId: provider.model, draftKey: draft.attachmentDraftKey || oldDraftKey, attachmentIds: draft.attachments.map(item => item.id), approvalMode: draft.approvalMode, workMode: draft.workMode, goal: draft.goal });
      accepted = true;
      const cleared = { ...draft, text: '', attachments: [], attachmentDraftKey: undefined, originDraft: undefined, goal: undefined };
      setDrafts(previous => {
        const next = { ...previous, [oldDraftKey]: cleared, [session!.id]: cleared };
        const origin = draft.originDraft;
        if (origin && previous[origin.key] && draftSignature(previous[origin.key]) === origin.signature) next[origin.key] = cleared;
        return next;
      });
      const revision = eventRevision.current;
      const current = await window.localcode.openSession(session.id);
      if (revision === eventRevision.current) putSession(current);
      else void refresh().catch(failure => setError(errorText(failure)));
    } catch (failure) {
      // Creating a task can succeed before sending fails. Keep its visible draft too.
      if (!accepted && targetId && targetId !== oldDraftKey) setDrafts(previous => {
        const original = previous[oldDraftKey] || draft;
        return { ...previous, [targetId]: { ...original, originDraft: original.originDraft || { key: oldDraftKey, signature: draftSignature(original) } } };
      });
      setError(accepted ? `任务已发送，但暂时未能刷新会话：${errorText(failure)}` : errorText(failure));
    }
    finally {
      sendLocks.current.delete(oldDraftKey); sendLocks.current.delete(targetId);
      setPendingActions(previous => ({ ...previous, [oldDraftKey]: false, [targetId]: false }));
      if (activeSessionRef.current === targetId) textareaRef.current?.focus();
    }
  };

  const stop = async () => {
    if (!activeSession || !busy || stopPending) return;
    const sessionId = activeSession.id;
    setPendingStops(previous => ({ ...previous, [sessionId]: true }));
    try { await window.localcode.stop(sessionId); } catch (failure) { setError(errorText(failure)); }
    finally { setPendingStops(previous => ({ ...previous, [sessionId]: false })); }
  };
  const approve = async (allow: boolean, scope?: 'once' | 'session') => {
    const approval = activeSession?.approval;
    if (!approval || approvalPending) return;
    const sessionId = activeSessionId;
    setPendingApprovals(previous => ({ ...previous, [sessionId]: true }));
    try { await window.localcode.approve({ runId: approval.runId, approvalId: approval.id, allow, scope }); }
    catch (failure) { setError(errorText(failure)); }
    finally { setPendingApprovals(previous => ({ ...previous, [sessionId]: false })); }
  };
  const changeTheme = async (theme: Theme) => {
    try { await window.localcode.setTheme(theme); setBoot(previous => previous ? { ...previous, settings: { ...previous.settings, theme } } : previous); }
    catch (failure) { setError(errorText(failure)); }
  };
  const changeLocale = async (locale: AppLocale) => {
    await window.localcode.setLocale(locale);
    setLocale(locale);
    setBoot(previous => previous ? { ...previous, settings: { ...previous.settings, locale } } : previous);
  };
  const changeFontSize = async (fontSize: number) => {
    try {
      await window.localcode.setFontSize(fontSize);
      setBoot(previous => previous ? { ...previous, settings: { ...previous.settings, fontSize } } : previous);
    } catch (failure) { setError(errorText(failure)); }
  };
  const checkHealth = async () => {
    setHealthPending(true);
    try { const health = await window.localcode.health(); setBoot(previous => previous ? { ...previous, health } : previous); }
    catch (failure) { setError(errorText(failure)); }
    finally { setHealthPending(false); }
  };
  const openFile = async (entry: FileEntry) => {
    if (entry.directory) { setDirectory(entry.path); return; }
    await artifacts.open(entry.path);
  };
  const undo = async (change: ChangeView) => {
    if (!activeSession || changesBusy || change.conflict) return;
    try { await window.localcode.undo({ sessionId: activeSession.id, path: change.path }); await refreshChanges(); }
    catch (failure) { setError(errorText(failure)); await refreshChanges(); }
  };
  const previewCheckpoint = async (change: ChangeView, opener: HTMLButtonElement) => {
    if (!activeSession || changesBusy || !change.conflict || checkpointLock.current) return;
    const sessionId = activeSession.id; const request = ++checkpointRequest.current;
    // Capture before disabling the trigger for the asynchronous preview request.
    checkpointOpener.current = opener;
    checkpointLock.current = true; setCheckpointPending(true); setCheckpointError('');
    try {
      const preview = await window.localcode.previewCheckpoint({ sessionId, path: change.path });
      if (request === checkpointRequest.current && activeSessionRef.current === sessionId) setCheckpointPreview({ ...preview, sessionId });
    } catch (failure) { if (request === checkpointRequest.current) setError(errorText(failure)); }
    finally { if (request === checkpointRequest.current) { checkpointLock.current = false; setCheckpointPending(false); } }
  };
  const confirmCheckpoint = async () => {
    if (!checkpointPreview || changesBusy || checkpointLock.current || activeSessionId !== checkpointPreview.sessionId) return;
    const preview = checkpointPreview; const request = ++checkpointRequest.current;
    checkpointLock.current = true; setCheckpointPending(true); setCheckpointError('');
    try {
      await window.localcode.checkpoint({ sessionId: preview.sessionId, path: preview.path, expectedHash: preview.currentHash, expectedRecordHash: preview.recordHash });
      if (request === checkpointRequest.current) {
        setCheckpointPreview(null); setNotice('已保留当前文件内容作为新起点。旧修改已归档，可继续本会话。');
        await refreshChanges(preview.sessionId);
      }
    } catch (failure) { if (request === checkpointRequest.current) setCheckpointError(errorText(failure)); }
    finally { if (request === checkpointRequest.current) { checkpointLock.current = false; setCheckpointPending(false); } }
  };
  const renameSession = async () => {
    if (!renameId || !renameTitle.trim()) return;
    try { const updated = await window.localcode.renameSession({ sessionId: renameId, title: renameTitle.trim() }); putSession(updated); setRenameId(''); }
    catch (failure) { setError(errorText(failure)); }
  };

  if (!connected) return <div className="bridge-empty"><div className="brand-mark"><BrandLogo /></div><h1>LocalCode</h1><p>{t("请通过 LocalCode 桌面程序打开此页面。")}</p><span>{t("本地工具只通过桌面应用的受控接口提供。")}</span></div>;
  if (loading) return <div className="bridge-empty"><div className="brand-mark"><BrandLogo /></div><h1>LocalCode</h1><p><LoaderCircle className="spin" size={16} />{t(" 正在打开你的工作区…")}</p></div>;

  return <ArtifactContext.Provider value={artifacts}><div className={`app-shell ${inspectorOpen || artifactOpen ? '' : 'inspector-hidden'} ${sidebarOpen ? '' : 'sidebar-hidden'} ${artifactOpen ? 'artifact-open' : ''}`}>
    <nav className="activity-rail" aria-label={t("工作区导航")}>
      <button className={`rail-button ${!activeSessionId ? 'active' : ''}`} title={t("返回首页")} aria-label={t("返回首页")} aria-current={!activeSessionId ? 'page' : undefined} onClick={goHome}><HomeIcon active={!activeSessionId} /></button>
      <button className="rail-button" title={sidebarOpen ? t('收起侧边栏') : t('展开侧边栏')} aria-label={sidebarOpen ? t('收起侧边栏') : t('展开侧边栏')} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      <button className="rail-button" title={t("打开项目文件夹")} aria-label={t("添加项目")} onClick={() => void openProject()}><FolderOpen size={19} /></button>
      <div className="rail-divider" />
      <button className={`rail-button ${inspectorOpen ? 'active' : ''}`} title={t("文件与修改")} aria-label={t("切换文件与修改面板")} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><GitCompareArrows size={19} /></button>
      <div className="rail-spacer" />
      <button className="rail-button" title={t("设置")} aria-label={t("应用设置")} onClick={() => openSettings()}><Settings2 size={18} /></button>
      <UserMenu onOpenSettings={openSettings} labels={{ menu: t('用户菜单'), user: t('本地用户'), description: t('此设备上的工作区'), settings: t('设置'), pets: t('桌宠'), about: t('关于 LocalCode') }} />
    </nav>
    <aside className="sidebar">
      <div className="sidebar-brand drag-region"><BrandLogo /><span>LocalCode</span><ChevronDown size={13} /><button className="icon-button" title={t("打开项目文件夹")} aria-label={t("打开项目文件夹")} onClick={() => void openProject()}><FolderPlus size={16} /></button></div>
      <div className="sidebar-actions"><button className="new-task-button" onClick={() => void newSession()}><SquarePen size={15} /><span>{t("新建任务")}</span></button></div>
      <TaskSidebar projects={boot?.projects || []} sessions={sessions} activeProjectId={activeProjectId} activeSessionId={activeSessionId} preferences={sidebarPreferences} onProject={selectProject} onSession={session => void openSession(session)} onAddProject={() => void openProject()} onRename={session => { setRenameId(session.id); setRenameTitle(session.title); }} onMove={session => setMoveSessionId(session.id)} onPin={project => void togglePinned(project)} onPreferences={patch => void updateSidebar(patch)} />
      {busySession && busySession.id !== activeSessionId && <button className="background-task" onClick={() => void openSession(busySession)}><LoaderCircle size={14} className="spin" /><span>{busySession.status === 'awaiting_approval' ? t('有任务等待确认') : t('有任务正在运行')}</span><ArrowUpRight size={13} /></button>}
      <div className="sidebar-footer">
        <div className="local-health" title={cloudSelected ? t("云端模型不依赖本地 Ollama；连通性请在设置中手动测试。") : boot?.health.message ? t(boot.health.message) : undefined}><span className={`status-dot ${cloudSelected ? provider?.hasKey ? 'online' : 'offline' : boot?.health.online && boot?.health.modelAvailable ? 'online' : 'offline'}`} /><span>{cloudSelected ? t("云端模式 · 无需 Ollama") : boot?.health.online ? boot.health.modelAvailable ? boot.health.gpuPercent === 0 ? t("CPU 运行 · 较慢") : t("本地模型已就绪") : t("模型尚未就绪") : t("Ollama 未连接")}</span><button className="icon-button" title={t("刷新连接")} aria-label={t("刷新模型连接")} onClick={() => void checkHealth()} disabled={healthPending}><RefreshCw size={13} className={healthPending ? 'spin' : ''} /></button></div>
      </div>
    </aside>

    <main className="workspace">
      <header className="workspace-header drag-region">
        <div className="workspace-heading"><Folder size={16} /><h1 title={activeSession?.title || project?.path}>{activeSession ? sessionTitle(activeSession) : t('首页')}</h1></div>
        <div className="header-actions no-drag"><span className={`run-status ${activeSession?.status || 'idle'}`}><span className="status-dot" />{t(STATUS_LABELS[activeSession?.status || 'idle'])}</span><button className="icon-button" title={inspectorOpen ? t('收起文件面板') : t('打开文件面板')} aria-label={inspectorOpen ? t('收起文件面板') : t('打开文件面板')} onClick={() => setInspectorOpen(value => !value)}>{inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div>
      </header>
      {needsModelSetup && <section className="model-setup-banner" aria-label={t("模型配置指引")}><div><strong>{cloudSelected ? t("还差一步：配置 API Key") : t("开始前，选择一种模型方式")}</strong><p>{cloudSelected ? t("在模型设置中保存密钥，然后选择云端模型。无需安装 Ollama 或下载本地模型。") : cloudConfigured ? t("本地模型尚未就绪。你也可以直接在输入框下方选择已配置的云端模型，不受本地环境影响。") : t("本地新安装：运行 Install-LocalModel.cmd（便携版）或 Setup.cmd（源码版）。已有 Ollama：在设置中选择已有服务。云端 API：只需地址、模型名和密钥。")}</p></div><button className="secondary-button" onClick={() => openSettings()}><Settings2 size={15} />{t("配置模型与检查环境")}</button></section>}
      <div className="conversation" ref={scrollRef} onScroll={event => { const element = event.currentTarget; setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 100); }}>
        {(!activeSession || !activeSession.messages.length) ? <div className="welcome">
          <h2>{project ? t('你想在 {name} 中做些什么？', { name: project.name }) : t('我们从哪里开始？')}</h2>
          <p>{project ? t('和 LocalCode 一起工作') : t('直接开始对话，也可以选择项目处理文件')}</p>
          {project && <>
            <div className="project-location"><FolderOpen size={14} /><span title={project.path}>{project.path}</span></div>
            <div className="starter-grid">
              {[
                { icon: Search, title: t("理解这个项目"), text: t("浏览项目目录，概括主要文件和入口。暂时不要修改文件。") },
                { icon: Code2, title: t("完成一个小改动"), text: t("我想完成一个小改动。先查看项目结构，等我说明具体需求。") },
                { icon: ShieldCheck, title: t("检查现有代码"), text: t("查看项目中的关键代码，找出一个值得修复的问题，先解释依据。") },
              ].map(item => <button className="starter-card" key={item.title} onClick={() => { updateDraft({ text: item.text }); textareaRef.current?.focus(); }}><item.icon size={18} strokeWidth={1.6} /><span>{item.title}</span><ArrowUpRight size={13} /></button>)}
            </div>
          </>}
        </div> : <div className="message-list">
          <ConversationTimeline messages={activeSession.messages} tools={activeSession.tools} runs={activeSession.runs || []} status={activeSession.status} />
          {busy && !activeSession.approval && !activeSession.question && <ProgressIndicator progress={activeSession.progress} />}
          {activeSession.error && <div className="inline-error"><AlertCircle size={16} /><div><strong>{t("任务遇到问题")}</strong><p>{t(activeSession.error)}</p></div></div>}
        </div>}
      </div>
      {!atBottom && <button className="scroll-bottom icon-button" title={t("回到最新消息")} aria-label={t("回到最新消息")} onClick={() => { setAtBottom(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown size={17} /></button>}
      <div className="composer-area">
        {notice && <div className="notice-banner"><Sparkles size={14} /><span>{notice}</span><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setNotice('')}><X size={13} /></button></div>}
        {activeSession?.goal && <GoalCard goal={activeSession.goal} pending={interactionPending} busy={busy} local={provider?.kind === 'ollama'} planMode={draft.workMode === 'plan'} onControl={(action, budgetMs) => { const session = activeSession; void interaction(session.id, () => window.localcode.controlGoal({ sessionId: session.id, goalId: session.goal!.id, action, budgetMs, ...(action === 'resume' && provider ? { providerId: provider.id, modelId: provider.model } : {}) })); }} />}
        {activeSession?.approval && <ApprovalCard approval={activeSession.approval} pending={approvalPending} onAnswer={(allow, scope) => void approve(allow, scope)} />}
        {activeSession?.question && <QuestionCard key={activeSession.question.id} question={activeSession.question} pending={interactionPending} onAnswer={answers => { const session = activeSession, question = session.question!; void interaction(session.id, () => window.localcode.answerQuestion({ sessionId: session.id, runId: question.runId, questionId: question.id, answers })); }} onStop={() => void stop()} />}
        {activeSession?.plan && <PlanCard key={activeSession.plan.id} plan={activeSession.plan} busy={busy} pending={interactionPending} onAccept={acceptPlan} onRevise={() => { updateDraft({ workMode: 'plan' }); textareaRef.current?.focus(); }} />}
        <div className="composer-context"><ProjectPicker projects={boot?.projects || []} value={activeProjectId || null} disabled={busy || actionPending || Boolean(activeSession?.projectId)} onChange={chooseWorkspace} onCreate={() => void openProject(activeSession && !activeSession.projectId ? activeSession.id : undefined)} /><span className="computer-context"><Monitor size={14} />{t("此计算机")}</span></div>
        <Composer key={draftKey} draft={draft} onChange={updateDraft} textareaRef={textareaRef} choices={choices} selected={choice} onModel={next => { setProviderId(next.provider.id); setModelId(next.model.id); }} busy={busy} pending={actionPending} importing={importing} stopPending={stopPending} settingsOpen={settingsOpen} projectName={project?.name} goal={activeSession?.goal} onSend={() => void send()} onStop={() => void stop()} onPick={folders => void attach(undefined, folders)} onImport={files => void attach(files)} />
        <div className="composer-caption"><ShieldCheck size={11} /><span>{provider && provider.kind !== 'ollama' ? t("外部模型 · 使用你选择的供应商") : t("本地模型 · 对话保存在这台电脑")} </span>{busySession && busySession.id !== activeSessionId && <button onClick={() => void openSession(busySession)}>{t("查看正在运行的任务")}</button>}</div>
      </div>
    </main>

    {inspectorOpen && !artifactOpen && <aside className="inspector">
      <div className="inspector-tabs"><button className={inspectorTab === 'changes' ? 'active' : ''} onClick={() => setInspectorTab('changes')}><GitCompareArrows size={15} />{t("修改")}{changes.length > 0 && <span className="count-badge">{changes.length}</span>}</button><button className={inspectorTab === 'files' ? 'active' : ''} onClick={() => setInspectorTab('files')}><Files size={15} />{t("文件")}</button></div>
      {inspectorTab === 'changes' ? <>
        <div className="inspector-section-label"><span>{t("本次会话")}</span><button className="icon-button" title={t("刷新文件差异")} aria-label={t("刷新文件差异")} onClick={() => void refreshChanges()}><RefreshCw size={13} /></button></div>
        {!changes.length ? <div className="panel-empty"><div className="panel-empty-icon"><GitCompareArrows size={27} strokeWidth={1.4} /></div><h3>{t("修改会显示在这里")}</h3><p>{t("Agent 编辑文件后，你可以查看差异，并撤销本次会话的修改。")}</p><span className="panel-footnote">{t("不会自动提交到 Git")}</span></div> : <>
          <div className="change-files">{changes.map(change => <button key={change.path} className={`change-file ${selectedChange?.path === change.path ? 'active' : ''}`} onClick={() => setChangePath(change.path)} onContextMenu={event => void artifacts.showMenu(event, change.path)} title={change.path}>{change.created ? <FilePlus2 size={14} /> : <FileCode2 size={14} />}<span>{change.path}</span>{change.conflict ? <AlertCircle size={13} className="warning-text" /> : <span className={change.created ? 'change-mark added' : 'change-mark'}>{change.created ? 'A' : 'M'}</span>}</button>)}</div>
          {selectedChange && <div className="diff-pane"><div className="diff-title"><span title={selectedChange.path}>{shortPath(selectedChange.path)}</span><button className="icon-button" aria-label={t("撤销此文件修改")} title={selectedChange.conflict ? t("文件有其他修改，不能直接撤销") : changesBusy ? t("所有任务结束后可撤销") : t("撤销本会话对此文件的修改")} disabled={changesBusy || selectedChange.conflict} onClick={() => void undo(selectedChange)}><Undo2 size={14} /></button></div>{selectedChange.conflict && <div className="conflict-note"><AlertCircle size={13} /><div>{t("文件已有其他修改，已保护当前内容，无法直接撤销。")}<button className="secondary-button checkpoint-preview-button" disabled={changesBusy} title={changesBusy ? t("请等待所有任务结束") : t("检查当前内容后才能继续编辑")} onClick={event => void previewCheckpoint(selectedChange, event.currentTarget)}>{t("预览并设为新起点")}</button></div></div>}<DiffContent change={selectedChange} /></div>}
        </>}
      </> : <>
        <div className="file-breadcrumb"><button className="icon-button" disabled={!directory && !fileView} aria-label={t("返回上级目录")} title={t("返回目录")} onClick={() => { if (fileView) setFileView(null); else setDirectory(directory.replace(/\\/g, '/').split('/').slice(0, -1).join('/')); }}><ArrowLeft size={14} /></button><span title={fileView?.path || directory || project?.path}>{fileView?.path || directory || project?.name || t("项目文件")}</span></div>
        {fileLoading ? <div className="panel-loading"><LoaderCircle size={19} className="spin" /><span>{t("正在读取…")}</span></div> : fileView ? <><div className="file-readonly"><FileCode2 size={12} />{t("只读预览")}{fileView.truncated && <span>{t("· 内容已截断")}</span>}</div><pre className="file-code">{fileView.content}</pre></> : <div className="file-list">{files.map(entry => <button key={entry.path} className="file-entry" onClick={() => void openFile(entry)} onContextMenu={event => { if (!entry.directory) void artifacts.showMenu(event, entry.path); }} onKeyDown={event => { if (!entry.directory && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) void artifacts.showMenu(event, entry.path); }} title={entry.path}>{entry.directory ? <Folder size={15} className="folder-icon" /> : <FileCode2 size={15} />}<span>{entry.name}</span>{entry.directory && <ChevronRight size={12} />}</button>)}{!files.length && <div className="panel-empty compact"><FolderOpen size={25} strokeWidth={1.4} /><p>{project ? t("此目录没有可显示的文件。") : t("选择项目后浏览文件。")}</p></div>}</div>}
      </>}
      <div className="inspector-bottom"><ShieldCheck size={12} /><span>{t("工作范围：所选项目文件夹")}</span></div>
    </aside>}

    {error && <div className="toast error-toast" role="alert"><AlertCircle size={18} /><div><strong>{t("操作未完成")}</strong><p>{t(error)}</p></div><button className="icon-button" title={t("关闭错误提示")} aria-label={t("关闭错误提示")} onClick={() => setError('')}><X size={15} /></button></div>}
    {settingsOpen && boot && <SettingsDialog onCreatePet={createPetInProject} hasProject={Boolean(activeProjectId)} initialTab={settingsInitialTab} returnFocusTo={settingsOpener.current} settings={boot.settings} health={boot.health} version={boot.version} onClose={() => setSettingsOpen(false)} onTheme={changeTheme} onLocale={changeLocale} onFontSize={changeFontSize} onHealth={checkHealth} healthPending={healthPending} onSaved={refresh} onOpenData={() => { void window.localcode.openDataFolder().catch(failure => setError(errorText(failure))); }} />}
    {checkpointPreview && <ChangeCheckpointDialog preview={checkpointPreview} returnFocusTo={checkpointOpener.current} pending={checkpointPending} error={checkpointError} onCancel={() => { checkpointRequest.current++; setCheckpointPreview(null); setCheckpointError(''); }} onConfirm={() => void confirmCheckpoint()} />}
    {renameId && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setRenameId(''); }}><form className="small-dialog" onSubmit={event => { event.preventDefault(); void renameSession(); }}><h2>{t("重命名会话")}</h2><label className="field"><span>{t("会话名称")}</span><input autoFocus value={renameTitle} maxLength={100} onChange={event => setRenameTitle(event.target.value)} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setRenameId('')}>{t("取消")}</button><button className="primary-button" disabled={!renameTitle.trim()}>{t("保存")}</button></div></form></div>}
    {moveSessionId && sessions.find(session => session.id === moveSessionId) && <MoveTaskDialog session={sessions.find(session => session.id === moveSessionId)!} projects={boot?.projects || []} onClose={() => setMoveSessionId('')} onMove={projectId => moveTask(moveSessionId, projectId)} onCreate={() => openProject(moveSessionId)} />}
    <ArtifactPanel controller={artifacts} />
    <ArtifactMenu controller={artifacts} />
  </div></ArtifactContext.Provider>;
}

function ConversationTimeline({ messages, tools, runs, status }: { messages: ChatMessage[]; tools: ToolRecord[]; runs: RunSummaryRecord[]; status: RunStatus }) {
  const finalRuns = useMemo(() => new Map(runs.filter(run => run.status === 'completed' && run.finalMessageId && messages.some(message => message.id === run.finalMessageId && message.role === 'assistant' && !message.partial && message.text.trim())).map(run => [run.finalMessageId!, run])), [messages, runs]);
  // Older histories have no per-run summaries. Only their last completed answer is copyable.
  const legacyFinal = !runs.length && status === 'completed' ? [...messages].reverse().find(message => message.role === 'assistant' && !message.partial && message.text.trim()) : undefined;
  const items = useMemo(() => [
    ...messages.map(message => ({ type: 'message' as const, id: message.id, createdAt: message.createdAt, message })),
    ...tools.map(tool => ({ type: 'tool' as const, id: tool.id, createdAt: tool.createdAt, tool })),
    ...runs.filter(run => run.status !== 'running' && run.endedAt).map(run => ({ type: 'summary' as const, id: run.runId, createdAt: run.endedAt!, run })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [messages, tools, runs]);
  return <>{items.map(item => item.type === 'message'
    ? <React.Fragment key={`message-${item.id}`}>{finalRuns.has(item.id) && <RunTiming run={finalRuns.get(item.id)!} />}<Message message={item.message} />{item.id === legacyFinal?.id && <div className="reply-actions"><MessageCopy message={item.message} /></div>}</React.Fragment>
    : item.type === 'tool' ? <ToolCard key={`tool-${item.id}`} tool={item.tool} /> : <React.Fragment key={`run-${item.id}`}><RunSummary run={item.run} showTiming={!item.run.finalMessageId || !finalRuns.has(item.run.finalMessageId)} />{item.run.finalMessageId && finalRuns.has(item.run.finalMessageId) && <div className="reply-actions" data-run-id={item.run.runId}><MessageCopy message={messages.find(message => message.id === item.run.finalMessageId)!} /></div>}</React.Fragment>)}</>;
}

function MessageCopy({ message }: { message: ChatMessage }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try { await window.localcode.copyText(message.text); setState('copied'); }
    catch { setState('failed'); }
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  return <button className="message-copy icon-button" aria-label={t("复制回答")} title={state === 'copied' ? t('已复制') : state === 'failed' ? t('复制失败，请重试') : t('复制回答')} onClick={() => void copy()}>{state === 'copied' ? <Check size={13} /> : state === 'failed' ? <AlertCircle size={13} /> : <Clipboard size={13} />}<span className="sr-only" role="status">{state === 'copied' ? t('已复制') : state === 'failed' ? t('复制失败，请重试') : ''}</span></button>;
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    if (message.automatic) return <div className="automatic-message"><RefreshCw size={12} /><span>继续推进目标</span></div>;
    if (message.attachments?.length) return <div className="user-message with-attachments"><div className="user-message-content"><AttachmentStrip attachments={message.attachments} />{message.text && <div className="user-message-text">{message.text}</div>}</div></div>;
    return <div className="user-message"><div>{message.text}</div></div>;
  }
  if (!message.text && !message.parts?.length) return null;
  return <article className={`assistant-message ${message.partial ? 'streaming' : ''}`}><div className="assistant-avatar"><BrandLogo /></div><div className="assistant-body"><div className="assistant-label">LocalCode</div>{message.parts?.length ? message.parts.map(part => part.type === 'thinking' ? <ThinkingPart key={part.index} part={part} /> : <MarkdownText key={part.index} text={part.text} />) : <MarkdownText text={message.text} />}</div></article>;
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} urlTransform={markdownUrl} skipHtml components={{
    a: ({ children, href }) => href && (isFileReference(href) || !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) ? <ArtifactLink path={href} inputKind="reference">{children}</ArtifactLink> : href && /^https?:\/\//i.test(href) ? <ExternalWebLink href={href}>{children}</ExternalWebLink> : <span>{children}</span>,
    code: ({ children, className, node }) => !className && node?.position?.start.line === node?.position?.end.line && typeof children === 'string' && isFileReference(children) ? <ArtifactLink path={children} inputKind={/^file:/i.test(children) ? 'reference' : 'path'}><code>{children}</code></ArtifactLink> : <code className={className}>{children}</code>,
    img: ({ alt, src }) => src && isFileReference(src) ? <ArtifactLink path={src} inputKind="reference">{alt || t('查看图片')}</ArtifactLink> : <span className="image-placeholder">{t('[图片：')}{alt || t('未加载')}]</span>,
  }}>{text}</ReactMarkdown></div>;
}
function useClock(active: boolean) {
  const [time, setTime] = useState(Date.now());
  useEffect(() => { if (!active) return; setTime(Date.now()); const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return time;
}
function ThinkingPart({ part }: { part: MessagePart }) {
  const active = part.state === 'streaming';
  const time = useClock(active);
  const [open, setOpen] = useState(active);
  const previous = useRef(active);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const autoPosition = useRef(0);
  useEffect(() => { if (previous.current !== active) setOpen(active); previous.current = active; }, [active]);
  useEffect(() => {
    if (active && open && follow.current && content.current) {
      content.current.scrollTop = content.current.scrollHeight;
      autoPosition.current = content.current.scrollTop;
    }
  }, [active, open, part.text]);
  const seconds = Math.max(0, Math.floor(((part.endedAt ? Date.parse(part.endedAt) : time) - Date.parse(part.startedAt)) / 1000));
  return <section className={`thinking-part ${part.state}`}>
    <button className="thinking-summary" aria-expanded={open} onClick={() => setOpen(value => !value)}><Brain size={15} /><span>{active ? t("正在思考") : part.state === 'interrupted' ? t("思考已中断") : t("思考")} · {seconds}{t(" 秒")}</span><ChevronDown size={14} className={open ? 'rotate-180' : ''} /></button>
    {open && <div ref={content} className="thinking-content" tabIndex={0} aria-label={t("模型返回的思考内容")} onScroll={event => { const el = event.currentTarget; if (Math.abs(el.scrollTop - autoPosition.current) > 1) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}><MarkdownText text={part.text || t("等待思考内容…")} /></div>}
  </section>;
}
function ProgressIndicator({ progress }: { progress?: RunProgress }) {
  const time = useClock(true);
  const labels = { waiting: t("等待模型响应"), thinking: t("正在思考"), output: t("正在输出"), tool: t("正在执行工具"), queued: t("等待供应商请求空位"), retry: t("供应商限流，等待重试") };
  const countdown = progress?.retryAt ? Math.max(0, Math.ceil((progress.retryAt - time) / 1000)) : 0;
  return <div className="thinking-indicator" role="status"><span /><span /><span /><span className="thinking-label">{labels[progress?.phase || 'waiting']}…{progress?.phase === 'retry' ? t(" {seconds} 秒 · 重试 {attempt}/2", { seconds: countdown, attempt: progress.attempt ?? 1 }) : ''}</span></div>;
}

function ToolCard({ tool }: { tool: ToolRecord }) {
  const [expanded, setExpanded] = useState(false);
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {};
  const summary = String(args.path || args.file_path || args.command || args.pattern || args.directory || '');
  const command = /powershell|shell|command/i.test(tool.name);
  const artifact = React.useContext(ArtifactContext);
  const filePath = !command && typeof (args.path || args.file_path) === 'string' ? String(args.path || args.file_path) : '';
  const openable = Boolean(filePath && tool.status === 'completed' && !tool.isError);
  const label = t(TOOL_LABELS[tool.name] || tool.name);
  return <div className={`tool-card ${tool.status}`} onContextMenu={event => { if (filePath && tool.status === 'completed') void artifact?.showMenu(event, filePath); }}>
    <div className={`tool-summary-row ${openable ? 'has-file-link' : ''}`}><button className="tool-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{tool.status === 'running' ? <LoaderCircle className="spin" size={14} /> : tool.status === 'failed' ? <AlertCircle size={14} /> : command ? <Terminal size={14} /> : <FileCode2 size={14} />}<span className="tool-label">{label}</span>{!openable && <span className="tool-short-args" title={summary}>{summary}</span>}</button>{openable && <ArtifactLink path={filePath} className="tool-file-link" label={t("打开文件 {path}", { path: filePath })}><span>{filePath}</span></ArtifactLink>}{tool.status === 'completed' && <Check size={12} className="tool-success" />}<button className="tool-expand icon-button" aria-label={t(expanded ? '收起{label}详情' : '展开{label}详情', { label })} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronRight size={13} className={expanded ? 'rotate-90' : ''} /></button></div>
    {expanded && <div className="tool-details"><div className="tool-detail-heading">{t("输入")}</div><pre>{JSON.stringify(tool.args, null, 2)}</pre>{tool.result !== undefined && <><div className="tool-detail-heading">{tool.isError ? t('错误') : t('输出')}</div><pre>{tool.result || t('执行完成，无输出。')}</pre></>}{tool.status === 'running' && <div className="tool-waiting">{t("正在执行…")}</div>}</div>}
  </div>;
}

function DiffContent({ change }: { change: ChangeView }) {
  const rows = useMemo(() => {
    let oldLine = 1, newLine = 1;
    return diffLines(change.before, change.after).flatMap(part => {
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.map(text => ({ text, kind: part.added ? 'added' : part.removed ? 'removed' : 'same', old: part.added ? null : oldLine++, next: part.removed ? null : newLine++ }));
    });
  }, [change.before, change.after]);
  const added = rows.filter(row => row.kind === 'added').length;
  const removed = rows.filter(row => row.kind === 'removed').length;
  return <><div className="diff-stats"><span className="added">+{added}</span><span className="removed">−{removed}</span><span>{change.created ? t("新增文件") : t("与首次修改前比较")}</span></div><div className="diff-content" aria-label={t("{path} 的文件差异", { path: change.path })}>{rows.length ? rows.map((row, index) => <div key={index} className={`diff-row ${row.kind}`}><span className="line-number">{row.old}</span><span className="line-number">{row.next}</span><span className="diff-sign">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span><code>{row.text || ' '}</code></div>) : <div className="diff-empty">{t("没有文本差异")}</div>}</div></>;
}

type SettingsEntryTab = 'models' | 'pets' | 'about';

function HomeIcon({ active }: { active: boolean }) {
  if (!active) return <Home className="home-icon" size={20} aria-hidden="true" />;
  return <svg className="home-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M12 2.5 2.75 10v1.75H5v9h14v-9h2.25V10L12 2.5ZM10 14h4v6.75h-4V14Z" /></svg>;
}

function UserMenu({ onOpenSettings, labels }: {
  onOpenSettings: (tab: SettingsEntryTab, opener?: HTMLElement | null) => void;
  labels: { menu: string; user: string; description: string; settings: string; pets: string; about: string };
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(0);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[firstFocus.current < 0 ? items.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        if (menu.current?.contains(document.activeElement)) trigger.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const entries = [
    { tab: 'models' as const, label: labels.settings, Icon: Settings2 },
    { tab: 'pets' as const, label: labels.pets, Icon: Sparkles },
    { tab: 'about' as const, label: labels.about, Icon: Info },
  ];
  return <div className="user-menu-anchor" ref={root} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className={`rail-button user-menu-trigger ${open ? 'active' : ''}`} title={labels.menu} aria-label={labels.menu} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'local-user-menu' : undefined} onClick={() => { firstFocus.current = 0; setOpen(value => !value); }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); firstFocus.current = event.key === 'ArrowUp' ? -1 : 0; setOpen(true); }
    }}><UserRound size={19} /></button>
    {open && <div className="user-menu-popover" ref={menu} id="local-user-menu" role="menu" aria-label={labels.menu} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div className="user-menu-heading" role="presentation"><span className="user-menu-avatar"><UserRound size={20} /></span><div><strong>{labels.user}</strong><p>{labels.description}</p></div></div>
      <div className="user-menu-divider" role="separator" />
      {entries.map(({ tab, label, Icon }) => <button key={tab} type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); onOpenSettings(tab, trigger.current); }}><Icon size={16} /><span>{label}</span></button>)}
    </div>}
  </div>;
}

function SettingsDialog({ initialTab, returnFocusTo, settings, health, version, onClose, onTheme, onLocale, onFontSize, onHealth, healthPending, onSaved, onOpenData, onCreatePet, hasProject }: {
  initialTab: SettingsEntryTab; returnFocusTo: HTMLElement | null;
  settings: AppSettings; health: ModelHealth; version: string; onClose: () => void; onTheme: (theme: Theme) => Promise<void>;
  onFontSize: (fontSize: number) => Promise<void>;
  onLocale: (locale: AppLocale) => Promise<void>;
  onHealth: () => Promise<void>; healthPending: boolean; onSaved: () => Promise<unknown>; onOpenData: () => void;
  onCreatePet: (input: { name: string; description: string }) => Promise<void>; hasProject: boolean;
}) {
  const [tab, setTab] = useState<'models' | 'language' | 'appearance' | 'pets' | 'about'>(initialTab);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    return () => { if (returnFocusTo?.isConnected) returnFocusTo.focus(); };
  }, [returnFocusTo]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className={`settings-dialog ${tab === 'models' ? 'model-settings-dialog' : tab === 'pets' ? 'pet-settings-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="settings-header"><h2 id="settings-title">{t("设置")}</h2><button ref={closeButton} className="icon-button" aria-label={t("关闭设置")} onClick={onClose}><X size={19} /></button></header><div className="settings-layout"><nav className="settings-nav"><button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}><Cpu size={16} />{t("模型设置")}</button><button className={tab === 'language' ? 'active' : ''} onClick={() => setTab('language')}><Languages size={16} />{t('语言')}</button><button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}><Monitor size={16} />{t("外观")}</button><button className={tab === 'pets' ? 'active' : ''} onClick={() => setTab('pets')}><Sparkles size={16} />{t("桌宠")}</button><button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}><BrandLogo />{t("关于")}</button></nav><div className="settings-content">
      {tab === 'language' && <LanguageControl value={settings.locale} onChange={onLocale} />}
      {tab === 'pets' && <PetControls onCreateInProject={onCreatePet} hasProject={hasProject} />}
      {tab === 'models' && <ModelSettings settings={settings} health={health} onHealth={onHealth} healthPending={healthPending} onSaved={onSaved} />}
      {tab === 'appearance' && <><div className="settings-section-heading"><h3>{t("外观")}</h3><p>{t("为你的工作区选择舒适的配色与字号。")}</p></div><FontSizeControl value={settings.fontSize} onChange={onFontSize} /><div className="theme-options">{(['light', 'dark'] as const).map(theme => <button key={theme} className={`theme-option ${settings.theme === theme ? 'selected' : ''}`} onClick={() => void onTheme(theme)}><div className={`theme-preview ${theme}`}><i /><div><b /><span /><span /><em /></div><i /></div><span>{theme === 'light' ? <Sun size={15} /> : <Moon size={15} />}{theme === 'light' ? t("浅色") : t("深色")}{settings.theme === theme && <Check size={14} />}</span></button>)}</div></>}
      {tab === 'about' && <><div className="about-brand"><div className="brand-mark"><BrandLogo /></div><h3>LocalCode</h3><p>{t("让想法，在本地落地。")}</p><span>{t("版本 ")}{version || '0.1.0'}</span></div><div className="about-details"><div><span>{t("Agent 运行时")}</span><strong>pi SDK 1.4.0</strong></div><div><span>{t("默认运行方式")}</span><strong>{t("每个会话独立 Agent")}</strong></div><div><span>{t("文件权限")}</span><strong>{t("所选项目内自动修改")}</strong></div><div><span>{t("终端权限")}</span><strong>{t("每条命令单独确认")}</strong></div></div><p className="about-disclaimer">{t("终端命令以当前 Windows 用户权限运行。应用的项目范围校验不等于操作系统沙箱。")}</p><button className="secondary-button data-folder-button" onClick={onOpenData}><FolderOpen size={15} />{t("打开应用数据目录")}</button></>}
    </div></div></section></div>;
}

export function LanguageControl({ value, onChange }: { value: AppLocale; onChange: (value: AppLocale) => Promise<void> }) {
  useLocale();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const change = async (next: AppLocale) => {
    if (pending || value === next) return;
    setPending(true); setFailure('');
    try { await onChange(next); }
    catch (error) { setFailure(errorText(error)); }
    finally { setPending(false); }
  };
  return <section className="language-setting" aria-busy={pending}>
    <div className="settings-section-heading"><h3>{t('语言')}</h3><p>{t('界面和默认回复使用所选语言，自动保存。')}</p></div>
    <label className="field"><span>{t('界面与交互语言')}</span><select aria-label={t('界面与交互语言')} value={value} disabled={pending} onChange={event => void change(event.target.value as AppLocale)}>
      {APP_LOCALES.map(locale => <option key={locale} value={locale} lang={locale}>{LOCALE_NAMES[locale]}</option>)}
    </select></label>
    <p className="language-help">{t('切换后立即更新界面，已有会话从下一轮开始使用新语言。')}</p>
    <p className="language-help">{t('明确指定的回复语言优先。例如：用中文提问并要求英文回复时，将使用英文。')}</p>
    {failure && <p className="inline-error" role="alert">{t(failure)}</p>}
  </section>;
}

function FontSizeControl({ value, onChange }: { value: number; onChange: (value: number) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const change = async (next: number) => {
    if (pending || next === value) return;
    setPending(true);
    try { await onChange(next); } finally { setPending(false); }
  };
  return <section className="font-size-setting" aria-label={t("字号设置")} aria-busy={pending}>
    <div className="font-size-heading"><div><h4>{t("字号")}</h4><p>{t("聊天、代码预览和界面文字同步调整，自动保存。")}</p></div><button type="button" className="secondary-button" disabled={pending || value === DEFAULT_FONT_SIZE} onClick={() => void change(DEFAULT_FONT_SIZE)}>{t("恢复默认字号")}</button></div>
    <div className="font-size-controls"><button type="button" className="secondary-button" aria-label={t("减小字号")} disabled={pending || value <= MIN_FONT_SIZE} onClick={() => void change(value - 1)}>A−</button><label className="field"><span className="sr-only">{t("字号")}</span><select aria-label={t("字号")} value={value} disabled={pending} onChange={event => void change(Number(event.target.value))}>{Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, i) => MIN_FONT_SIZE + i).map(size => <option key={size} value={size}>{size} px{size === DEFAULT_FONT_SIZE ? t("（默认）") : ''}</option>)}</select></label><button type="button" className="secondary-button" aria-label={t("增大字号")} disabled={pending || value >= MAX_FONT_SIZE} onClick={() => void change(value + 1)}>A＋</button></div>
    <p className="font-size-preview">{t("文字预览：把想法一步步变成代码。")}</p>
  </section>;
}
