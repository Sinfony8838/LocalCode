import React, { useEffect, useState } from 'react';
import { Check, FolderOpen, Pause, Pin, Play, RotateCcw } from 'lucide-react';
import type { PetSnapshot, PetPreferences } from '../shared/pets';
import { PetSprite } from './PetSprite';
import './pets.css';

export default function PetControls() {
  const [state, setState] = useState<PetSnapshot>(), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { if (!window.localpets) return; void window.localpets.state().then(setState).catch(() => {}); return window.localpets.onState(setState); }, []);
  const save = async (input: Partial<Omit<PetPreferences, 'position'>>) => { const previous = state; setState(value => value ? { ...value, preferences: { ...value.preferences, ...input } } : value); setSaving(true); setError(''); try { setState(await window.localpets.save(input)); } catch (e) { setState(previous); setError(String((e as Error).message)); } finally { setSaving(false); } };
  return <section className="lc-pet-dialog lc-pet-inline" role="region" aria-label="桌宠设置">
      <header><div><h3>选择你的旅伴</h3></div></header>
      <p className="lc-pet-intro">在桌面陪你思考，任务进度与等待确认一眼可见。</p>
      <div className="lc-pet-characters">{state?.characters.map(character => <div key={character.id} className={`lc-pet-character ${state.preferences.selected === character.id ? 'selected' : ''}`}>
        <button disabled={!character.available || saving} aria-label={`选择${character.name}`} aria-pressed={state.preferences.selected === character.id} onClick={() => void save({ selected: character.id, enabled: true })}>
          <div className="lc-pet-preview">{character.available ? <PetSprite character={character} size={100} paused={state.preferences.paused}/> : <span className="lc-pet-missing">等待原始素材</span>}</div><strong>{character.name}{state.preferences.selected === character.id && <Check size={14}/>}</strong><small>{character.available ? '已保存的原始动画' : '需要 1536×2288 PNG 图集'}</small>
        </button><button className="lc-pet-import" disabled={saving} onClick={async () => { setError(''); try { setState(await window.localpets.importAtlas(character.id)); } catch (e) { setError((e as Error).message); } }}><FolderOpen size={12}/>{character.available ? '更换图集' : '导入已有图集'}</button>
      </div>)}</div>
      {state && <div className="lc-pet-options">
        <label><span>显示桌宠</span><input aria-label="显示桌宠" type="checkbox" checked={state.preferences.enabled} disabled={saving} onChange={e => void save({ enabled: e.target.checked })}/></label>
        <label><span><Pin size={14}/>保持置顶</span><input aria-label="桌宠保持置顶" type="checkbox" checked={state.preferences.alwaysOnTop} disabled={saving} onChange={e => void save({ alwaysOnTop: e.target.checked })}/></label>
        <label><span>目光跟随鼠标</span><input aria-label="桌宠目光跟随" type="checkbox" checked={state.preferences.followCursor} disabled={saving} onChange={e => void save({ followCursor: e.target.checked })}/></label>
        <label><span>桌宠大小</span><select aria-label="桌宠大小" value={state.preferences.size} disabled={saving} onChange={e => void save({ size: Number(e.target.value) as PetPreferences['size'] })}><option value={128}>小</option><option value={160}>标准</option><option value={192}>大</option></select></label>
        <div className="lc-pet-option-actions"><button disabled={saving} onClick={() => void save({ paused: !state.preferences.paused })}>{state.preferences.paused ? <Play size={14}/> : <Pause size={14}/>} {state.preferences.paused ? '继续动画' : '暂停动画'}</button><button onClick={() => void window.localpets.action('reset-position')}><RotateCcw size={14}/>重置位置</button></div>
      </div>}
      {error && <p className="lc-pet-error" role="alert">{error}</p>}
      <footer>拖动角色移动位置；点击上方状态气泡回到 LocalCode。桌宠不调用模型。</footer>
    </section>;
}
