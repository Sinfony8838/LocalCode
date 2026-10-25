import { t, useLocale } from './i18n';
import React, { useLayoutEffect, useRef } from 'react';
import type { ChangeCheckpointPreview } from '../shared/contracts';

export default function ChangeCheckpointDialog({ preview, pending, error, returnFocusTo, onCancel, onConfirm }: {
  preview: ChangeCheckpointPreview; pending: boolean; error: string; returnFocusTo?: HTMLElement | null; onCancel: () => void; onConfirm: () => void;
}) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    // React autoFocus runs while the dialog is still hidden. Set initial focus
    // only after showModal, rather than letting the focusable preview receive it.
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (returnFocusTo?.isConnected && !returnFocusTo.matches(':disabled')) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);
  return <dialog ref={dialogRef} className="checkpoint-dialog" aria-labelledby="checkpoint-title" aria-describedby="checkpoint-description"
    onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <h2 id="checkpoint-title">{t('确认当前内容为新起点')}</h2>
    <p id="checkpoint-description">{t('请检查下面的完整当前内容。确认不会改写文件；旧修改前后的内容会保留在本地修改记录中。此后撤销只能回到这里确认的内容，不会撤回格式化或其他外部修改。')}</p>
    <p className="checkpoint-path">{preview.path} · {t('{count} 字节', { count: preview.byteLength })}</p>
    <pre className="checkpoint-content" aria-label={t("当前文件完整内容")} tabIndex={0}>{preview.content}</pre>
    <p className="checkpoint-hash">SHA-256：<code>{preview.currentHash}</code></p>
    {error && <p className="checkpoint-error" role="alert">{t(error)}</p>}
    <div className="dialog-actions">
      <button ref={cancelRef} type="button" className="secondary-button" disabled={pending} onClick={onCancel}>{t('取消')}</button>
      <button type="button" className="primary-button" disabled={pending || Boolean(error)} onClick={onConfirm}>{pending ? t('正在保存新起点…') : t('确认并保留当前内容')}</button>
    </div>
  </dialog>;
}
