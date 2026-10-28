import { t } from './i18n';
import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, CircleHelp, Clock3, FileText, Folder, Lightbulb, LoaderCircle, Pause, Play, ShieldCheck, Square, Target, Terminal, Trash2 } from 'lucide-react';
import type { Approval, GoalState, PlanRecord, QuestionRecord } from '../shared/contracts';

export function ApprovalCard({ approval, pending, onAnswer }: { approval: Approval; pending: boolean; onAnswer(allow: boolean, scope?: 'once' | 'session'): void }) {
  const command = !approval.kind || approval.kind === 'command';
  return <section className="approval-card agent-interaction-card" role="region" aria-label={t("操作审批")}>
    <div className="approval-heading"><span className="approval-icon">{command ? <Terminal size={18} /> : <FileText size={18} />}</span><div><strong>{command ? t("这条命令需要你的批准") : approval.kind === 'write' ? t("这次文件修改需要你的批准") : t("这次读取需要你的批准")}</strong><p>{command ? t("以当前 Windows 用户权限运行") : t("请确认操作的文件与范围")}</p></div></div>
    <div className="approval-cwd"><Folder size={13} /><span>{approval.resource || approval.cwd}</span></div>
    <pre className="approval-command">{approval.preview || approval.command}</pre>
    {approval.reason && <p className="approval-reason">{t(approval.reason)}</p>}
    {approval.permissionKey && <p className="approval-scope"><ShieldCheck size={12} />{command ? t("本会话授权仅适用于相同的完整命令和工作目录。") : t("本会话授权仅适用于同一路径的相同操作。")}</p>}
    <div className="approval-footer"><button type="button" className="secondary-button" disabled={pending} onClick={() => onAnswer(false)}>{t("拒绝")}</button>{approval.permissionKey && <button type="button" className="secondary-button" disabled={pending} onClick={() => onAnswer(true, 'session')}>{t("本会话允许此范围")}</button>}<button type="button" className="primary-button" disabled={pending} onClick={() => onAnswer(true, 'once')}>{pending ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t("允许这一次")}</button></div>
  </section>;
}

export function QuestionCard({ question, pending, onAnswer, onStop }: { question: QuestionRecord; pending: boolean; onAnswer(answers: string[][] | null): void; onStop(): void }) {
  const [selected, setSelected] = useState<string[][]>(() => question.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => question.questions.map(() => ''));
  const answers = question.questions.map((item, index) => [...(item.multiple || !custom[index]?.trim() ? selected[index] : []), ...(custom[index]?.trim() ? [custom[index].trim()] : [])]);
  const valid = answers.every(answer => answer.length > 0);
  return <form className="question-card agent-interaction-card" aria-label={t("需要你的回答")} onSubmit={event => { event.preventDefault(); if (valid && !pending) onAnswer(answers); }}>
    <header className="interaction-heading"><CircleHelp size={19} /><div><strong>{t("继续之前，需要你做个选择")}</strong><p>{t("可以选择选项，也可以输入自己的回答。")}</p></div></header>
    <div className="question-items">{question.questions.map((item, index) => <fieldset disabled={pending} key={index}><legend><span>{item.header}</span>{item.question}</legend><div className="question-options">{item.options.map(option => {
      const checked = selected[index].includes(option.label);
      return <label className={`question-option ${checked ? 'selected' : ''}`} key={option.label}><input type={item.multiple ? 'checkbox' : 'radio'} name={`${question.id}-${index}`} value={option.label} checked={checked} onChange={() => {
        setSelected(previous => previous.map((value, at) => at !== index ? value : item.multiple ? checked ? value.filter(label => label !== option.label) : [...value, option.label] : [option.label]));
        if (!item.multiple) setCustom(previous => previous.map((value, at) => at === index ? '' : value));
      }} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>;
    })}</div><textarea aria-label={`${item.header || `问题 ${index + 1}`}：自定义回答`} rows={2} maxLength={4000} value={custom[index]} placeholder={item.multiple ? t("补充其他回答…") : t("或输入自己的回答…")} onChange={event => { const text = event.target.value; setCustom(previous => previous.map((value, at) => at === index ? text : value)); if (!item.multiple && text.trim()) setSelected(previous => previous.map((value, at) => at === index ? [] : value)); }} /></fieldset>)}</div>
    <footer className="interaction-actions"><button type="button" className="text-button" disabled={pending} onClick={onStop}><Square size={12} />{t("停止任务")}</button><div><button type="button" className="secondary-button" disabled={pending} onClick={() => onAnswer(null)}>{t("暂不回答")}</button><button type="submit" className="primary-button" disabled={pending || !valid}>{pending ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{t("提交回答")}</button></div></footer>
  </form>;
}

export function PlanCard({ plan, busy, pending, onAccept, onRevise }: { plan: PlanRecord; busy: boolean; pending: boolean; onAccept(): void; onRevise(): void }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="plan-card agent-interaction-card" aria-label={t("实施计划")}>
    <button className="plan-heading" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Lightbulb size={19} /><strong>{plan.status === 'accepted' ? t("已确认的计划") : t("计划已准备好")}</strong><ChevronDown size={16} className={expanded ? 'rotate-180' : ''} /></button>
    {expanded && <div className="plan-content markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span> }}>{plan.text}</ReactMarkdown></div>}
    {plan.status === 'proposed' && <footer className="interaction-actions"><span>{t("确认后，Agent 将开始实施。")}</span><div><button type="button" className="secondary-button" disabled={busy || pending} onClick={onRevise}>{t("继续修改")}</button><button type="button" className="primary-button" disabled={busy || pending} onClick={onAccept}>{pending ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{t("开始实施")}</button></div></footer>}
  </section>;
}

const goalLabels: Record<GoalState['status'], string> = { active: t("进行中"), paused: t("已暂停"), blocked: t("等待处理"), budget_limited: t("预算已用完"), usage_limited: t("额度受限"), complete: t("已完成") };
const duration = (ms: number) => { const minutes = Math.floor(Math.max(0, ms) / 60000); return minutes >= 60 ? t("{hours} 小时 {minutes} 分",{hours:Math.floor(minutes/60),minutes:minutes%60}) : t("{minutes} 分钟",{minutes}); };
export function GoalCard({ goal, pending, busy, local, planMode, onControl }: { goal: GoalState; pending: boolean; busy: boolean; local: boolean; planMode: boolean; onControl(action: 'pause' | 'resume' | 'clear' | 'budget', budgetMs?: number): void }) {
  const [editingBudget, setEditingBudget] = useState(false), [hours, setHours] = useState(String(goal.budgetMs / 3600000));
  useEffect(() => setHours(String(goal.budgetMs / 3600000)), [goal.budgetMs]);
  const canResume = goal.status !== 'active' && goal.status !== 'complete' && !local && !planMode && !busy;
  return <section className="goal-card" aria-label={t("当前目标")}><div className="goal-card-top"><Target size={18} /><strong>{t("目标")}</strong><span className={`goal-status goal-${goal.status}`}>{t(goalLabels[goal.status])}</span><div className="goal-card-actions">{goal.status === 'active' ? <button type="button" className="icon-button" aria-label={t("暂停目标")} title={t("暂停目标")} disabled={pending} onClick={() => onControl('pause')}><Pause size={15} /></button> : goal.status !== 'complete' && <button type="button" className="icon-button" aria-label={t("恢复目标")} title={planMode ? t("先确认计划后再继续目标") : local ? t("请先切换外部模型") : t("恢复目标")} disabled={pending || !canResume} onClick={() => onControl('resume')}><Play size={15} /></button>}<button type="button" className="icon-button" aria-label={t("清除目标")} title={t("清除目标")} disabled={pending} onClick={() => onControl('clear')}><Trash2 size={15} /></button></div></div><p className="goal-objective">{goal.objective}</p><div className="goal-budget-row"><Clock3 size={13} /><span>{t("已用 {used} / {budget}",{used:duration(goal.activeMs),budget:duration(goal.budgetMs)})}</span><button type="button" disabled={pending} onClick={() => setEditingBudget(!editingBudget)}>{t("调整预算")}</button></div><div className="goal-budget-track" role="progressbar" aria-label={t("目标有效运行预算")} aria-valuemin={0} aria-valuemax={goal.budgetMs} aria-valuenow={Math.min(goal.activeMs, goal.budgetMs)}><span style={{ width: `${Math.min(100, goal.activeMs / goal.budgetMs * 100)}%` }} /></div>{goal.reason && <p className="goal-reason">{t(goal.reason)}</p>}{planMode && goal.status === 'active' && <p className="goal-reason">{t("计划阶段不会自动续跑，确认实施后继续推进。")}</p>}{editingBudget && <form className="goal-budget-edit" onSubmit={event => { event.preventDefault(); if (Number(hours) >= .25 && Number(hours) <= 24) { onControl('budget', Math.round(Number(hours) * 3600000)); setEditingBudget(false); } }}><label>{t("预算（小时）")}<input type="number" aria-label={t("调整目标预算")} min="0.25" max="24" step="0.25" value={hours} disabled={pending} onChange={event => setHours(event.target.value)} /></label><button type="submit" className="secondary-button" disabled={pending || !(Number(hours) >= .25 && Number(hours) <= 24)}>{t("保存")}</button></form>}</section>;
}
