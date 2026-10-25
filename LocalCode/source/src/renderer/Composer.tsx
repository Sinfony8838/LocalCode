import { t } from './i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, FileText, Folder, Hand, Lightbulb, LoaderCircle, Paperclip, Plus, ShieldAlert, ShieldCheck, Square, Target, X } from 'lucide-react';
import ModelPicker, { type ModelChoice } from './ModelPicker';
import type { ApprovalMode, AttachmentInfo, GoalState, SessionView, WorkMode } from '../shared/contracts';

export interface ComposerDraft {
  text: string;
  attachments: AttachmentInfo[];
  attachmentDraftKey?: string;
  originDraft?: { key: string; signature: string };
  approvalMode: ApprovalMode;
  workMode: WorkMode;
  goal?: { objective: string; budgetMs: number };
}
export function emptyDraft(session?: SessionView): ComposerDraft {
  return { text: '', attachments: [], approvalMode: session?.approvalMode || 'ask', workMode: session?.workMode || 'execute' };
}

const permissions = [
  { value: 'ask' as const, label: t("请求批准"), detail: t("终端命令与外部路径请求批准"), Icon: Hand },
  { value: 'auto' as const, label: t("帮我批准"), detail: t("按已授权规则批准，其他操作询问"), Icon: ShieldCheck },
  { value: 'full' as const, label: t("完全访问权限"), detail: t("跳过常规审批，以当前用户权限执行"), Icon: ShieldAlert },
];

function usePopover(open: boolean, trigger: React.RefObject<HTMLButtonElement | null>, panel: React.RefObject<HTMLDivElement | null>, close: (focus?: boolean) => void, width: number) {
  const [position, setPosition] = useState({ left: 12, bottom: 12, width, maxHeight: 400 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
      const actualWidth = Math.min(width * scale, innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, innerWidth - actualWidth - 12)), bottom: innerHeight - rect.top + 10, width: actualWidth, maxHeight: Math.max(80, Math.min(500 * scale, rect.top - 22)) });
    };
    place(); window.addEventListener('resize', place);
    const observer = new ResizeObserver(place); if (trigger.current) observer.observe(trigger.current);
    return () => { window.removeEventListener('resize', place); observer.disconnect(); };
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"], button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: Event) => { const node = event.target as Node; if (!panel.current?.contains(node) && !trigger.current?.contains(node)) close(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'Tab') close();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.scrollIntoView({ block: 'nearest' });
    }
  };
  return { position, onKeyDown };
}

export function ImagePreview({ attachment, onClose }: { attachment: AttachmentInfo; onClose(): void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; closeButton.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  return createPortal(<div className="attachment-lightbox" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); } }}>
    <section role="dialog" aria-modal="true" aria-label={t("图片预览 {name}",{name:attachment.name})}><header><span>{attachment.name}</span><button ref={closeButton} className="icon-button" type="button" aria-label={t("关闭图片预览")} onClick={onClose}><X size={20} /></button></header><img src={attachment.previewUrl} alt={attachment.name} /></section>
  </div>, document.body);
}

export function AttachmentStrip({ attachments, onRemove, disabled = false }: { attachments: AttachmentInfo[]; onRemove?(id: string): void; disabled?: boolean }) {
  const [preview, setPreview] = useState<AttachmentInfo>();
  if (!attachments.length) return null;
  return <><div className={`attachment-strip ${onRemove ? 'attachment-draft-strip' : 'attachment-history-strip'}`} aria-label={onRemove ? t("待发送附件") : t("消息附件")}>{attachments.map(item => <div className={`attachment-tile attachment-${item.kind}`} key={item.id}>
    {item.kind === 'image' && item.previewUrl ? <button type="button" className="attachment-image-button" aria-label={t("预览图片 {name}",{name:item.name})} onClick={() => setPreview(item)}><img src={item.previewUrl} alt={item.name} loading="lazy" /></button> : <div className="attachment-file-content">{item.kind === 'folder' ? <Folder size={26} /> : <FileText size={26} />}<span title={item.name}>{item.name}</span><small>{item.kind === 'folder' ? t("只读文件夹") : `${Math.max(1, Math.ceil(item.size / 1024))} KB · 文本`}</small></div>}
    {onRemove && <button type="button" className="attachment-remove" aria-label={t("移除附件 {name}",{name:item.name})} title={t("移除附件")} disabled={disabled} onClick={() => onRemove(item.id)}><X size={14} /></button>}
  </div>)}</div>{preview && <ImagePreview attachment={preview} onClose={() => setPreview(undefined)} />}</>;
}

function GoalEditor({ initial, onSave, onClose }: { initial?: ComposerDraft['goal']; onSave(goal: NonNullable<ComposerDraft['goal']>): void; onClose(): void }) {
  const [objective, setObjective] = useState(initial?.objective || '');
  const [hours, setHours] = useState(String((initial?.budgetMs || 2 * 3600000) / 3600000));
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  const valid = Boolean(objective.trim()) && Number(hours) >= .25 && Number(hours) <= 24;
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form ref={form} className="goal-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-dialog-title" onSubmit={event => { event.preventDefault(); if (valid) onSave({ objective: objective.trim(), budgetMs: Math.round(Number(hours) * 3600000) }); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') { const nodes = [...(form.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea') || [])]; const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}><header><Target size={21} /><h2 id="goal-dialog-title">{t("设置目标")}</h2><button type="button" className="icon-button" aria-label={t("关闭目标设置")} onClick={onClose}><X size={18} /></button></header><p>{t("让 Agent 持续推进这项工作，直到完成、需要你的输入或达到预算。")}</p><label className="field"><span>{t("你希望完成什么？")}</span><textarea autoFocus aria-label={t("目标内容")} value={objective} maxLength={4000} rows={4} placeholder={t("例如：完成这个项目的功能实现与测试，并修复发现的问题。")} onChange={event => setObjective(event.target.value)} /></label><label className="field goal-budget-field"><span>{t("有效运行预算（小时）")}</span><input aria-label={t("目标运行预算")} type="number" min="0.25" max="24" step="0.25" value={hours} onChange={event => setHours(event.target.value)} /></label><small>{t("等待审批、等待回答、排队及暂停不计时。重启应用后需要手动恢复。")}</small><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t("取消")}</button><button type="submit" className="primary-button" disabled={!valid}>{t("添加目标")}</button></div></form></div>, document.body);
}

export default function Composer({ draft, onChange, textareaRef, choices, selected, onModel, busy, pending, importing, stopPending, settingsOpen, projectName, goal, onSend, onStop, onPick, onImport }: {
  draft: ComposerDraft; onChange(patch: Partial<ComposerDraft>): void; textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  choices: ModelChoice[]; selected?: ModelChoice; onModel(choice: ModelChoice): void;
  busy: boolean; pending: boolean; importing: boolean; stopPending: boolean; settingsOpen: boolean; projectName?: string; goal?: GoalState;
  onSend(): void; onStop(): void; onPick(folders?: boolean): void; onImport(files: File[]): void;
}) {
  const [menu, setMenu] = useState<'add' | 'permission'>(); const [goalEditor, setGoalEditor] = useState(false); const [dragging, setDragging] = useState(false);
  const addTrigger = useRef<HTMLButtonElement>(null), permissionTrigger = useRef<HTMLButtonElement>(null), addPanel = useRef<HTMLDivElement>(null), permissionPanel = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const closeAdd = (focus = false) => { setMenu(undefined); if (focus) addTrigger.current?.focus(); };
  const closePermission = (focus = false) => { setMenu(undefined); if (focus) permissionTrigger.current?.focus(); };
  const addPopover = usePopover(menu === 'add', addTrigger, addPanel, closeAdd, 350);
  const permissionPopover = usePopover(menu === 'permission', permissionTrigger, permissionPanel, closePermission, 415);
  const permission = permissions.find(item => item.value === draft.approvalMode)!;
  const local = selected?.provider.kind === 'ollama';
  const supportsImages = selected?.model.supportsImages ?? selected?.provider.supportsImages;
  const imageUnsupported = draft.attachments.some(item => item.kind === 'image') && supportsImages !== true;
  const goalUnsupported = Boolean(draft.goal && local);
  const locked = busy || pending;
  const hasContent = Boolean(draft.text.trim() || draft.attachments.length || draft.goal?.objective);
  const canSend = hasContent && !pending && !importing && Boolean(selected) && !imageUnsupported && !goalUnsupported;
  useEffect(() => { if (locked || settingsOpen) { setMenu(undefined); setGoalEditor(false); } }, [locked, settingsOpen]);
  useEffect(() => { if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`; } }, [draft.text]);
  return <>
    <form className={`composer codex-composer ${dragging ? 'is-dragging' : ''}`} onSubmit={event => { event.preventDefault(); if (canSend && !busy) onSend(); }}
      onDragEnter={event => { if (!event.dataTransfer.types.includes('Files') || pending) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = pending ? 'none' : 'copy'; } }}
      onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!pending) onImport(Array.from(event.dataTransfer.files)); }}>
      <AttachmentStrip attachments={draft.attachments} disabled={pending} onRemove={id => onChange({ attachments: draft.attachments.filter(item => item.id !== id) })} />
      {importing && <div className="attachment-importing" role="status"><LoaderCircle size={14} className="spin" />{t("正在添加附件…")}</div>}
      <textarea ref={textareaRef} aria-label={t("任务输入")} value={draft.text} rows={2} placeholder={projectName ? t("和 LocalCode 一起工作") : t("随心输入")} disabled={pending}
        onChange={event => onChange({ text: event.target.value })}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); onImport(files); } }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend && !busy) onSend(); } }} />
      <div className="composer-toolbar"><div className="composer-options">
        <button ref={addTrigger} className="icon-button composer-add" type="button" aria-label={t("添加附件或模式")} title={t("添加")} aria-haspopup="menu" aria-expanded={menu === 'add'} disabled={pending} onClick={() => setMenu(menu === 'add' ? undefined : 'add')}><Plus size={23} strokeWidth={1.8} /></button>
        <button ref={permissionTrigger} className={`permission-trigger ${draft.approvalMode === 'full' ? 'full-access' : ''}`} type="button" aria-label={t("审批模式")} title={t(permission.detail)} aria-haspopup="menu" aria-expanded={menu === 'permission'} disabled={locked} onClick={() => setMenu(menu === 'permission' ? undefined : 'permission')}><permission.Icon size={18} /><span>{t(permission.label)}</span></button>
        {draft.workMode === 'plan' && <><span className="composer-divider" /><button type="button" className="mode-chip" aria-label={t("关闭计划模式")} title="计划模式：先讨论方案，确认后实施" disabled={locked} onClick={() => onChange({ workMode: 'execute' })}><Lightbulb size={18} /><span>{t("计划")}</span><X className="chip-dismiss" size={12} /></button></>}
        {(draft.goal || goal) && <><span className="composer-divider" />{draft.goal ? <div className="mode-chip goal-chip"><button type="button" title={draft.goal.objective} aria-label={t("编辑待发送目标")} disabled={locked || local} onClick={() => setGoalEditor(true)}><Target size={18} /><span>{t("目标")}</span></button><button className="chip-dismiss" type="button" aria-label={t("移除待发送目标")} disabled={locked} onClick={() => onChange({ goal: undefined })}><X size={12} /></button></div> : <span className="mode-chip goal-chip" title={goal?.objective}><Target size={18} /><span>{t("目标")}</span></span>}</>}
      </div><div className="composer-submit"><ModelPicker choices={choices} selected={selected} disabled={locked || settingsOpen} onChange={onModel} />{busy ? <button type="button" className="stop-button" aria-label={t("停止任务")} title={t("仅停止此会话的任务")} disabled={stopPending} onClick={onStop}>{stopPending ? <LoaderCircle size={16} className="spin" /> : <Square size={13} fill="currentColor" />}</button> : <button className="send-button" type="submit" aria-label={t("发送任务")} disabled={!canSend}>{pending ? <LoaderCircle size={19} className="spin" /> : <ArrowUp size={21} strokeWidth={2.2} />}</button>}</div></div>
      {dragging && <div className="attachment-drop-hint"><Paperclip size={22} /><span>{t("松开以添加文件")}</span></div>}
    </form>
    {imageUnsupported && <div className="composer-validation" role="status">{t("当前模型尚未启用图片能力。请选择支持图片的模型，或在模型设置中确认其图片能力。")}</div>}
    {goalUnsupported && <div className="composer-validation" role="status">{t("目标模式需要外部模型。请切换模型，或移除待发送目标。")}</div>}
    {menu === 'add' && createPortal(<div ref={addPanel} className="composer-popover add-popover" style={addPopover.position} role="menu" aria-label={t("添加")} onKeyDown={addPopover.onKeyDown}><div className="composer-popover-title">{t("添加")}</div>
      <button type="button" role="menuitem" onClick={() => { closeAdd(true); onPick(); }}><Paperclip size={20} /><span>{t("图片和文件")}<small>{t("添加图片、代码或文本文件")}</small></span></button>
      <button type="button" role="menuitem" onClick={() => { closeAdd(true); onPick(true); }}><Folder size={20} /><span>{t("文件夹")}<small>{t("添加只读文件夹上下文")}</small></span></button>
      <div className="composer-menu-divider" />
      <button type="button" role="menuitemcheckbox" aria-checked={Boolean(draft.goal || goal)} disabled={locked || local || Boolean(goal)} title={local ? t("本地 Ollama 暂不支持目标模式") : goal ? t("可在目标卡片中暂停、恢复或清除目标") : undefined} onClick={() => { closeAdd(); setGoalEditor(true); }}><Target size={20} /><span>{t("目标")}<small>{local ? t("切换外部模型后可用") : goal ? t("当前会话已有目标") : t("设置要持续完成的工作")}</small></span>{(draft.goal || goal) && <Check size={17} />}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={draft.workMode === 'plan'} disabled={locked} onClick={() => { onChange({ workMode: draft.workMode === 'plan' ? 'execute' : 'plan' }); closeAdd(true); }}><Lightbulb size={20} /><span>{t("计划模式")}<small>{draft.workMode === 'plan' ? t("关闭计划模式") : t("讨论方案，确认后再实施")}</small></span>{draft.workMode === 'plan' && <Check size={17} />}</button>
    </div>, document.body)}
    {menu === 'permission' && createPortal(<div ref={permissionPanel} className="composer-popover permission-popover" style={permissionPopover.position} role="menu" aria-label={t("审批选项")} onKeyDown={permissionPopover.onKeyDown}><div className="composer-popover-title">{t("应如何批准 LocalCode 操作？")}</div>{permissions.map(item => <button type="button" role="menuitemradio" aria-checked={draft.approvalMode === item.value} className={item.value === 'full' ? 'full-access' : ''} key={item.value} onClick={() => { onChange({ approvalMode: item.value }); closePermission(true); }}><item.Icon size={22} /><span>{t(item.label)}<small>{t(item.detail)}</small></span><span className="permission-check">{draft.approvalMode === item.value && <Check size={19} />}</span></button>)}<p className="permission-help">{t("计划模式始终只读。权限设置在下一次发送时生效。")}</p></div>, document.body)}
    {goalEditor && <GoalEditor initial={draft.goal} onClose={() => setGoalEditor(false)} onSave={next => { onChange({ goal: next }); setGoalEditor(false); textareaRef.current?.focus(); }} />}
  </>;
}
