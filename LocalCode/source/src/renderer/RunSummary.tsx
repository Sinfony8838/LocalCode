import { t, useLocale } from './i18n';
import React, { useState } from 'react';
import { ChevronDown, Files } from 'lucide-react';
import type { RunSummary as Summary } from '../shared/contracts';
import { ArtifactLink } from './Artifacts';

export function runDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600 ? t('{hours}小时{minutes}分钟{seconds}秒', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60), seconds: seconds % 60 }) : seconds >= 60 ? t('{minutes}分钟{seconds}秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('{seconds}秒', { seconds });
}

export function RunTiming({ run }: { run: Summary }) {
  useLocale();
  return <div className={`run-timing ${run.status}`}>
    {run.status !== 'completed' && <><span>{run.status === 'failed' ? t('本轮运行失败') : t('本轮已停止')}</span><span aria-hidden="true">·</span></>}
    <span>{t('用时 {duration}', { duration: runDuration(run.durationMs) })}</span>
  </div>;
}

export default function RunSummary({ run, showTiming = true }: { run: Summary; showTiming?: boolean }) {
  useLocale();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (run.status === 'running') return null;
  const additions = run.changes.reduce((sum, change) => sum + (change.additions || 0), 0);
  const deletions = run.changes.reduce((sum, change) => sum + (change.deletions || 0), 0);
  const incompleteCounts = run.changes.some(change => change.additions === null || change.deletions === null);
  const visibleChanges = showAll ? run.changes : run.changes.slice(0, 3);
  if (!showTiming && !run.changes.length && !run.changesError) return null;
  return <section className={`run-summary ${run.status}`} data-run-id={run.runId} aria-label={t('本轮运行记录')}>
    {showTiming && <RunTiming run={run} />}
    {!!run.changes.length && <div className="run-changes-card">
      <button className="run-summary-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="run-summary-icon"><Files size={20} /></span>
        <span className="run-summary-title"><strong>{t('已编辑 {count} 个文件', { count: run.changes.length })}{run.changesError ? t('（部分统计）') : ''}</strong><span className="run-summary-meta">{incompleteCounts ? <span>{t('部分增删行数未知')}</span> : <><span className="added">+{additions}</span><span className="removed">-{deletions}</span></>}</span></span>
        <ChevronDown size={16} className={expanded ? 'rotate-180' : ''} />
      </button>
      {expanded && <div className="run-file-list">{visibleChanges.map(change => <div className="run-file-row" key={change.path}>
        {change.kind === 'deleted' ? <span className="run-file-deleted">{change.path}</span> : <ArtifactLink path={change.path} label={t('打开文件 {path}', { path: change.path })}>{change.path}</ArtifactLink>}
        {change.conflict && <span className="run-file-kind">{t('已有其他修改')}</span>}
        <span className="run-file-counts"><span className="added">{change.additions === null ? '—' : `+${change.additions}`}</span><span className="removed">{change.deletions === null ? '—' : `-${change.deletions}`}</span></span>
      </div>)}{run.changes.length > 3 && <button className="run-files-toggle" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('收起文件') : t('再显示 {count} 个文件', { count: run.changes.length - 3 })}<ChevronDown size={16} className={showAll ? 'rotate-180' : ''} /></button>}</div>}
    </div>}
    {run.changesError && <p className="run-summary-note warning-text">{run.changesError.split(' ').map(note => t(note)).join(' ')}</p>}
  </section>;
}
