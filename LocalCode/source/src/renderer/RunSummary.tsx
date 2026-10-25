import React, { useState } from 'react';
import { ChevronDown, Files } from 'lucide-react';
import type { RunSummary as Summary } from '../shared/contracts';
import { ArtifactLink } from './Artifacts';

export function runDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分钟${seconds % 60}秒` : seconds >= 60 ? `${Math.floor(seconds / 60)}分钟${seconds % 60}秒` : `${seconds}秒`;
}

export function RunTiming({ run }: { run: Summary }) {
  return <div className={`run-timing ${run.status}`}>
    {run.status !== 'completed' && <><span>{run.status === 'failed' ? '本轮运行失败' : '本轮已停止'}</span><span aria-hidden="true">·</span></>}
    <span>用时 {runDuration(run.durationMs)}</span>
  </div>;
}

export default function RunSummary({ run, showTiming = true }: { run: Summary; showTiming?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (run.status === 'running') return null;
  const additions = run.changes.reduce((sum, change) => sum + (change.additions || 0), 0);
  const deletions = run.changes.reduce((sum, change) => sum + (change.deletions || 0), 0);
  const incompleteCounts = run.changes.some(change => change.additions === null || change.deletions === null);
  const visibleChanges = showAll ? run.changes : run.changes.slice(0, 3);
  if (!showTiming && !run.changes.length && !run.changesError) return null;
  return <section className={`run-summary ${run.status}`} data-run-id={run.runId} aria-label="本轮运行记录">
    {showTiming && <RunTiming run={run} />}
    {!!run.changes.length && <div className="run-changes-card">
      <button className="run-summary-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="run-summary-icon"><Files size={20} /></span>
        <span className="run-summary-title"><strong>已编辑 {run.changes.length} 个文件{run.changesError ? '（部分统计）' : ''}</strong><span className="run-summary-meta">{incompleteCounts ? <span>部分增删行数未知</span> : <><span className="added">+{additions}</span><span className="removed">-{deletions}</span></>}</span></span>
        <ChevronDown size={16} className={expanded ? 'rotate-180' : ''} />
      </button>
      {expanded && <div className="run-file-list">{visibleChanges.map(change => <div className="run-file-row" key={change.path}>
        {change.kind === 'deleted' ? <span className="run-file-deleted">{change.path}</span> : <ArtifactLink path={change.path} label={`打开文件 ${change.path}`}>{change.path}</ArtifactLink>}
        {change.conflict && <span className="run-file-kind">已有其他修改</span>}
        <span className="run-file-counts"><span className="added">{change.additions === null ? '—' : `+${change.additions}`}</span><span className="removed">{change.deletions === null ? '—' : `-${change.deletions}`}</span></span>
      </div>)}{run.changes.length > 3 && <button className="run-files-toggle" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? '收起文件' : `再显示 ${run.changes.length - 3} 个文件`}<ChevronDown size={16} className={showAll ? 'rotate-180' : ''} /></button>}</div>}
    </div>}
    {run.changesError && <p className="run-summary-note warning-text">{run.changesError}</p>}
  </section>;
}
