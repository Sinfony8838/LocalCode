import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { ModelConfig, ProviderConfig } from '../shared/contracts';
import { t, useLocale } from './i18n';

export interface ModelChoice { provider: ProviderConfig; model: ModelConfig }
// Translate only the built-in name; provider names entered by the user stay intact.
export const providerLabel = (provider: Pick<ProviderConfig, 'id' | 'name'>) => provider.id === 'local' && provider.name === 'Ollama 本地模型' ? t('Ollama 本地模型') : provider.name;
export const choiceLabel = (choice: ModelChoice) => choice.provider.kind === 'ollama' ? providerLabel(choice.provider) : `${choice.provider.name} · ${choice.model.id}`;

export default function ModelPicker({ choices, selected, disabled, onChange }: {
  choices: ModelChoice[]; selected?: ModelChoice; disabled: boolean; onChange: (choice: ModelChoice) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 336, maxHeight: 400 });
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const selectedIndex = choices.findIndex(c => c.provider.id === selected?.provider.id && c.model.id === selected?.model.id);
  const groups = [...new Map(choices.map(c => [c.provider.id, c.provider])).values()];

  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const show = () => { if (!disabled && choices.length) { setActive(Math.max(0, selectedIndex)); setOpen(true); } };
  const focusOption = (index: number) => {
    const next = (index + choices.length) % choices.length;
    setActive(next); options.current[next]?.focus({ preventScroll: true }); options.current[next]?.scrollIntoView({ block: 'nearest' });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
      const width = Math.min(336 * scale, innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), bottom: innerHeight - rect.top + 10,
        width, maxHeight: Math.max(0, Math.min(510 * scale, rect.top - 22)) });
    };
    place();
    window.addEventListener('resize', place);
    const observer = new ResizeObserver(place); if (trigger.current) observer.observe(trigger.current);
    return () => { window.removeEventListener('resize', place); observer.disconnect(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const selectedOption = options.current[Math.max(0, selectedIndex)];
    selectedOption?.focus({ preventScroll: true }); selectedOption?.scrollIntoView({ block: 'nearest' });
    const outside = (event: Event) => { const node = event.target as Node; if (!trigger.current?.contains(node) && !panel.current?.contains(node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => { if (disabled || !choices.length) setOpen(false); }, [disabled, choices.length]);

  return <div className="model-select-wrap">
    <button ref={trigger} type="button" className={`model-picker-trigger ${open ? 'is-open' : ''}`} aria-label={t('选择模型')} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      title={selected ? choiceLabel(selected) : t('请选择可用模型')} disabled={disabled || !choices.length} onClick={() => open ? close() : show()}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); show(); } }}>
      <span>{selected ? selected.provider.kind === 'ollama' ? providerLabel(selected.provider) : selected.model.id : t('请选择可用模型')}</span><ChevronDown size={13} />
    </button>
    {open && createPortal(<div ref={panel} className="model-picker-popover" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusOption(active + (event.key === 'ArrowDown' ? 1 : -1)); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focusOption(event.key === 'Home' ? 0 : choices.length - 1); }
      else if (event.key === 'Tab') close(true);
    }}>
      <div className="model-picker-title" id={`${listId}-label`}>{t('选择模型')}</div>
      <div id={listId} role="listbox" aria-labelledby={`${listId}-label`} className="model-picker-options">
        {groups.map(provider => <div className="model-picker-group" role="group" aria-label={providerLabel(provider)} key={provider.id}>
          <div className="model-picker-group-label">{provider.kind === 'ollama' ? t('本地模型') : provider.name}</div>
          {choices.map((choice, index) => choice.provider.id !== provider.id ? null : <button key={JSON.stringify([provider.id, choice.model.id])} ref={node => { options.current[index] = node; }} type="button" role="option"
            aria-label={choiceLabel(choice)} aria-selected={index === selectedIndex} tabIndex={index === active ? 0 : -1} className="model-picker-option"
            onFocus={() => setActive(index)} onClick={() => { onChange(choice); close(true); }}>
            <span>{provider.kind === 'ollama' ? providerLabel(provider) : choice.model.id}</span><span className="model-picker-check">{index === selectedIndex && <Check size={18} strokeWidth={1.8} />}</span>
          </button>)}
        </div>)}
      </div>
    </div>, document.body)}
  </div>;
}
