import React, { useState } from 'react';
import { AlertCircle, Check, ChevronDown, FileCode2, FilePlus2, Square } from 'lucide-react';
import type { RunSummary as Summary } from '../shared/contracts';
import { ArtifactLink } from './Artifacts';

export function runDuration(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒` : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export default function RunSummary({ run }: { run: Summary }) {
  const [expanded, setExpanded] = useState(true);
  if (run.status === 'running') return null;
  const complete = run.status === 'completed';
  const additions = run.changes.reduce((sum, change) => sum + (change.additions || 0), 0);
  const deletions = run.changes.reduce((sum, change) => sum + (change.deletions || 0), 0);
  const incompleteCounts = run.changes.some(change => change.additions === null || change.deletions === null);
  return <section className={`run-summary ${run.status}`} data-run-id={run.runId} aria-label={complete ? '本轮完成总结' : '本轮结束记录'}>
    <button className="run-summary-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {complete ? <Check size={16} /> : run.status === 'failed' ? <AlertCircle size={16} /> : <Square size={14} />}
      <span>{complete ? '本轮已完成' : run.status === 'failed' ? '本轮运行失败' : '本轮已停止'} · {run.changes.length ? `${run.changes.length} 个文件有修改${run.changesError ? '（部分统计）' : ''}` : run.changesError ? '文件统计不可用' : '未记录到文件修改'}</span>
      <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} />
    </button>
    {expanded && <div className="run-summary-details">
      <div className="run-summary-meta"><span>用时 {runDuration(run.durationMs)}</span>{!!run.changes.length && (incompleteCounts ? <span>部分增删行数未知</span> : <><span className="added">+{additions}</span><span className="removed">−{deletions}</span></>)}</div>
      {!!run.changes.length && <div className="run-file-list">{run.changes.map(change => <div className="run-file-row" key={change.path}>
        {change.kind === 'created' ? <FilePlus2 size={14} /> : <FileCode2 size={14} />}
        {change.kind === 'deleted' ? <span className="run-file-deleted">{change.path}</span> : <ArtifactLink path={change.path} label={`打开文件 ${change.path}`}>{change.path}</ArtifactLink>}
        <span className="run-file-kind">{change.kind === 'created' ? '新增' : change.kind === 'deleted' ? '删除' : '修改'}{change.conflict ? ' · 已有其他修改' : ''}</span>
        <span className="added">{change.additions === null ? '—' : `+${change.additions}`}</span><span className="removed">{change.deletions === null ? '—' : `−${change.deletions}`}</span>
      </div>)}</div>}
      {run.changesError && <p className="run-summary-note warning-text">{run.changesError}</p>}
      {run.coverageNote && <p className="run-summary-note">{run.coverageNote}</p>}
    </div>}
  </section>;
}
