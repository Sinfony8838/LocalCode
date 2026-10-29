import { t, useLocale, errorText } from './i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, FolderOpen, Pause, Pin, Play, Plus, RotateCcw, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { PetSnapshot, PetPreferences, PetCharacter } from '../shared/pets';
import { PetSprite } from './PetSprite';
import './pets.css';

export interface PetCreationDraft { name: string; description: string }
interface PetControlsProps {
  onCreateInProject?: (input: PetCreationDraft) => void | Promise<void>;
  hasProject?: boolean;
}

export default function PetControls({ onCreateInProject, hasProject = false }: PetControlsProps) {
  useLocale();
  const [state, setState] = useState<PetSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const createButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    if (!window.localpets) { setLoading(false); setError(t('桌宠服务尚未连接，请重新打开应用。')); return; }
    let received = false;
    const unsubscribe = window.localpets.onState(snapshot => { received = true; setState(snapshot); });
    void window.localpets.state().then(snapshot => { if (mounted.current && !received) setState(snapshot); })
      .catch(e => { if (mounted.current) setError(message(e)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (creating) { nameInput.current?.focus(); nameInput.current?.scrollIntoView({ block: 'nearest' }); }
  }, [creating]);

  const perform = async (operation: () => Promise<PetSnapshot | void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const snapshot = await operation(); if (snapshot && mounted.current) setState(snapshot); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const save = (input: Partial<Omit<PetPreferences, 'position'>>) => perform(() => window.localpets.save(input));
  const refresh = () => perform(() => window.localpets.refresh());
  const closeCreate = () => { if (busy) return; setCreating(false); createButton.current?.focus(); };
  const draft = { name: name.trim(), description: description.trim() };
  const createInProject = () => {
    if (!draft.name || !draft.description || !onCreateInProject) return;
    void perform(async () => { await onCreateInProject(draft); if (mounted.current) setCreating(false); });
  };
  const importNew = () => {
    if (!draft.name) return;
    void perform(async () => {
      const snapshot = await window.localpets.create(draft);
      if (snapshot.characters.length > (state?.characters.length ?? 0)) { setCreating(false); setName(''); setDescription(''); }
      return snapshot;
    });
  };
  const current = state?.characters.find(character => character.id === state.preferences.selected);
  const shown = !!state?.preferences.enabled;
  const unavailable = busy || !state;

  return <section className="lc-pet-dialog lc-pet-inline" role="region" aria-label={t('桌宠设置')} aria-busy={busy || loading}>
    <header className="lc-pet-page-heading">
      <div><h3>{t('桌宠与虚拟宠物')}</h3><p>{t('让喜欢的角色陪你工作，随时看见任务的进展。')}</p></div>
      <button className="lc-pet-soft-button" type="button" disabled={unavailable || !current?.available} onClick={() => void save({ enabled: !shown })}>{shown ? t('隐藏桌宠') : t('显示桌宠')}</button>
    </header>

    {error && <div className="lc-pet-error" role="alert"><span>{t(error)}</span><button type="button" aria-label={t('关闭桌宠错误提示')} onClick={() => setError('')}><X size={16}/></button></div>}
    {state?.libraryWarning && <p className="lc-pet-library-warning" role="status">{state.libraryWarning}</p>}
    {loading && <p className="lc-pet-loading" role="status">{t('正在加载虚拟宠物…')}</p>}
    {!loading && !state && <button type="button" className="lc-pet-outline-button" onClick={() => void refresh()} disabled={busy}>{t('重新加载')}</button>}

    {state && <>
      <div className={`lc-pet-stage ${!shown ? 'is-hidden' : ''}`} aria-label={t('当前桌宠预览')}>
        <div className="lc-pet-stage-center">
          <div className="lc-pet-stage-character">{shown && current?.available
            ? <PetSprite character={current} size={148} paused={state.preferences.paused}/>
            : <span className="lc-pet-stage-empty"><EyeOff size={27}/><span>{current?.available ? t('桌宠已隐藏') : t('选择一位虚拟宠物')}</span></span>}
          </div>
          <div className="lc-pet-preview-toolbar" role="group" aria-label={t('桌宠预览控制')}>
            <button type="button" title={shown ? t('隐藏桌宠') : t('显示桌宠')} aria-label={shown ? t('隐藏桌宠预览') : t('显示桌宠预览')} disabled={busy || !current?.available} onClick={() => void save({ enabled: !shown })}>{shown ? <Eye size={20}/> : <EyeOff size={20}/>}</button>
            <span aria-hidden="true"/>
            <button type="button" title={state.preferences.paused ? t('继续动画') : t('暂停动画')} aria-label={state.preferences.paused ? t('继续动画') : t('暂停动画')} disabled={busy || !current?.available} onClick={() => void save({ paused: !state.preferences.paused })}>{state.preferences.paused ? <Play size={19}/> : <Pause size={19}/>}</button>
            <span aria-hidden="true"/>
            <button type="button" title={t('桌宠偏好')} aria-label={t('桌宠偏好')} aria-expanded={customizing} aria-controls="lc-pet-preferences" onClick={() => setCustomizing(value => !value)}><ChevronDown size={21} className={customizing ? 'is-open' : ''}/></button>
          </div>
        </div>
        <button className="lc-pet-outline-button lc-pet-customize" type="button" aria-expanded={customizing} aria-controls="lc-pet-preferences" onClick={() => setCustomizing(value => !value)}><SlidersHorizontal size={15}/>{t('自定义')}</button>
      </div>

      {customizing && <section id="lc-pet-preferences" className="lc-pet-options" aria-label={t('桌宠偏好设置')}>
        <div className="lc-pet-panel-heading"><h4>{t('桌宠偏好')}</h4><button type="button" className="lc-pet-icon-button" aria-label={t('收起桌宠偏好')} onClick={() => setCustomizing(false)}><X size={17}/></button></div>
        <div className="lc-pet-option-grid">
          <label><span>{t('显示桌宠')}</span><input aria-label={t('显示桌宠')} type="checkbox" checked={shown} disabled={busy || !current?.available} onChange={e => void save({ enabled: e.target.checked })}/></label>
          <label><span><Pin size={14}/>{t('保持置顶')}</span><input aria-label={t('桌宠保持置顶')} type="checkbox" checked={state.preferences.alwaysOnTop} disabled={busy} onChange={e => void save({ alwaysOnTop: e.target.checked })}/></label>
          <label><span>{t('目光跟随鼠标')}</span><input aria-label={t('桌宠目光跟随')} type="checkbox" checked={state.preferences.followCursor} disabled={busy} onChange={e => void save({ followCursor: e.target.checked })}/></label>
          <label><span>{t('桌宠大小')}</span><select aria-label={t('桌宠大小')} value={state.preferences.size} disabled={busy} onChange={e => void save({ size: Number(e.target.value) as PetPreferences['size'] })}><option value={128}>{t('小')}</option><option value={160}>{t('标准')}</option><option value={192}>{t('大')}</option></select></label>
        </div>
        <div className="lc-pet-option-actions"><button type="button" className="lc-pet-outline-button" disabled={busy} onClick={() => void perform(() => window.localpets.action('reset-position'))}><RotateCcw size={14}/>{t('重置位置')}</button>{current && <button type="button" className="lc-pet-outline-button" disabled={busy} onClick={() => void perform(() => window.localpets.importAtlas(current.id))}><FolderOpen size={14}/>{t('更换当前图集')}</button>}{current?.id.startsWith('custom-') && <button type="button" className="lc-pet-outline-button" disabled={busy} onClick={() => setRemoving(current.id)}><Trash2 size={14}/>{t('移出宠物库')}</button>}</div>
        {current && removing === current.id && <div className="lc-pet-remove-confirm"><p>{t('将“{name}”移出宠物库？原图集仍保留在本机。', { name: petName(current) })}</p><button type="button" className="lc-pet-outline-button" disabled={busy} onClick={() => void perform(async () => { const snapshot = await window.localpets.remove(current.id); setRemoving(undefined); return snapshot; })}>{t('确认移除')}</button><button type="button" className="lc-pet-soft-button" disabled={busy} onClick={() => setRemoving(undefined)}>{t('取消')}</button></div>}
      </section>}

      <div className="lc-pet-library-heading"><h4>{t('我的虚拟宠物')}</h4><div><button className="lc-pet-icon-button" type="button" aria-label={t('刷新虚拟宠物')} title={t('刷新虚拟宠物')} disabled={busy} onClick={() => void refresh()}><RotateCcw size={18}/></button><button ref={createButton} className="lc-pet-soft-button" type="button" aria-expanded={creating} aria-controls="lc-pet-create" disabled={busy} onClick={() => setCreating(value => !value)}><Plus size={16}/>{t('创建虚拟宠物')}</button></div></div>

      {creating && <form id="lc-pet-create" className="lc-pet-create-panel" aria-label={t('创建虚拟宠物')} onSubmit={event => { event.preventDefault(); createInProject(); }}>
        <div className="lc-pet-panel-heading"><div><h4>{t('创造你的旅伴')}</h4><p>{t('描述角色的外观与个性，交给项目里的桌宠定制 Skill。')}</p></div><button type="button" className="lc-pet-icon-button" aria-label={t('取消创建虚拟宠物')} disabled={busy} onClick={closeCreate}><X size={18}/></button></div>
        <label className="lc-pet-field"><span>{t('宠物名称')}</span><input ref={nameInput} aria-label={t('宠物名称')} value={name} maxLength={80} required placeholder={t('例如：云朵')} disabled={busy} onChange={event => setName(event.target.value)}/></label>
        <label className="lc-pet-field"><span>{t('外观与个性')}</span><textarea aria-label={t('外观与个性')} value={description} maxLength={500} rows={3} placeholder={t('一只戴着蓝色围巾的小白猫，圆眼睛，喜欢趴在键盘旁。希望有轻轻摆尾和开心跳跃的动作。')} disabled={busy} onChange={event => setDescription(event.target.value)}/></label>
        <div className="lc-pet-create-actions"><button type="submit" className="lc-pet-primary-button" disabled={busy || !draft.name || !draft.description || !onCreateInProject}><Sparkles size={16}/>{t('在项目中用模型定制')}</button><button type="button" className="lc-pet-outline-button" disabled={busy || !draft.name} onClick={importNew}><FolderOpen size={15}/>{t('导入已有图集')}</button></div>
        <p className="lc-pet-create-note">{hasProject ? t('将准备当前项目的新任务，发送后使用所选模型。') : t('点击后选择项目，再准备定制任务。')}{' '}{t('已有素材可导入 PNG 图集或 pet.json，加入你的宠物库。')}</p>
      </form>}

      <div className="lc-pet-current">
        <span>{t('当前桌宠：{name}', { name: shown && current ? petName(current) : t('无') })}</span>
        <label><input type="checkbox" checked={shown} disabled={busy || (!shown && !current?.available)} onChange={e => void save({ enabled: e.target.checked })}/><span>{t('显示桌宠')}</span></label>
      </div>
      <div className="lc-pet-characters">
        {state.characters.map(character => {
          const selected = shown && state.preferences.selected === character.id;
          return <div key={character.id} className={`lc-pet-character ${selected ? 'selected' : ''}`}>
            <button type="button" disabled={!character.available || busy} aria-label={t('选择{name}', { name: petName(character) })} aria-pressed={selected} onClick={() => void save({ selected: character.id, enabled: true })}>
              <div className="lc-pet-preview">{character.available ? <PetSprite character={character} size={100} paused={state.preferences.paused}/> : <span className="lc-pet-missing"><FolderOpen size={22}/>{t('等待导入图集')}</span>}</div>
              <strong>{petName(character)}{selected && <Check size={15}/>}</strong><small>{(character.description ? (character.id.startsWith('custom-') ? character.description : t(character.description)) : '') || (character.available ? character.source === 'bundled' ? t('随时陪伴你的桌面旅伴') : t('你的专属虚拟宠物') : t('导入图集后即可使用'))}</small>
            </button>
            <button type="button" className="lc-pet-import" disabled={busy} onClick={() => void perform(() => window.localpets.importAtlas(character.id))}><FolderOpen size={13}/>{character.available ? t('更换图集') : t('导入已有图集')}</button>
          </div>;
        })}
      </div>
      <footer>{t('拖动桌宠调整位置，点击状态气泡返回任务。日常陪伴无需调用模型。')}</footer>
    </>}
  </section>;
}

function message(error: unknown): string { return errorText(error); }


function petName(character: PetCharacter): string { return character.id.startsWith('custom-') ? character.name : t(character.name); }
