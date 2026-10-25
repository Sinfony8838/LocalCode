import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Eye, Pause, Play, Pin, X } from 'lucide-react';
import type { PetSnapshot } from '../shared/pets';
import { PetSprite } from './PetSprite';
import './pets.css';

function FloatingPet() {
  const [state, setState] = useState<PetSnapshot>(), [error, setError] = useState(''), [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ id: string; pointerId: number; screenX: number; screenY: number } | undefined>(undefined);
  const pendingFrame = useRef<number | undefined>(undefined);
  useEffect(() => { void window.localpets.state().then(setState).catch(e => setError(String(e))); return window.localpets.onState(setState); }, []);
  const character = state?.characters.find(c => c.id === state.preferences.selected);
  const report = (promise: Promise<unknown>) => { void promise.catch(e => setError((e as Error).message)); };
  const interactive = (value: boolean) => { setHover(value); report(window.localpets.interactive(value)); };
  const finishDrag = (phase: 'end' | 'cancel', point?: { screenX: number; screenY: number }) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = undefined;
    if (pendingFrame.current !== undefined) { cancelAnimationFrame(pendingFrame.current); pendingFrame.current = undefined; }
    setDragging(false);
    report(window.localpets.drag({ id: active.id, phase, screenX: point?.screenX ?? active.screenX, screenY: point?.screenY ?? active.screenY }));
  };
  useEffect(() => {
    const blur = () => finishDrag('cancel'); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current); const active = gesture.current; gesture.current = undefined; if (active) void window.localpets.drag({ id: active.id, screenX: active.screenX, screenY: active.screenY, phase: 'cancel' }).catch(() => {}); };
  }, []);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const active = { id: crypto.randomUUID(), pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY };
    gesture.current = active; setDragging(true); interactive(true);
    report(window.localpets.drag({ id: active.id, phase: 'start', screenX: active.screenX, screenY: active.screenY }));
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.screenX = event.screenX; active.screenY = event.screenY;
    if (pendingFrame.current !== undefined) return;
    pendingFrame.current = requestAnimationFrame(() => { pendingFrame.current = undefined; const latest = gesture.current; if (latest) report(window.localpets.drag({ id: latest.id, phase: 'move', screenX: latest.screenX, screenY: latest.screenY })); });
  };
  if (!state || !character?.available) return null;
  return <div className={`lc-floating-pet ${hover ? 'hover' : ''}`} onMouseLeave={() => interactive(false)}>
    <div className="lc-pet-toolbar" onMouseEnter={() => interactive(true)}>
      <button aria-label="打开 LocalCode" title="打开 LocalCode" onClick={() => report(window.localpets.action('open-main'))}><Eye size={13}/></button>
      <button aria-label={state.preferences.paused ? '继续桌宠动画' : '暂停桌宠动画'} title={state.preferences.paused ? '继续动画' : '暂停动画'} onClick={() => report(window.localpets.save({ paused: !state.preferences.paused }))}>{state.preferences.paused ? <Play size={12}/> : <Pause size={12}/>}</button>
      <button aria-label="切换桌宠置顶" title="切换置顶" aria-pressed={state.preferences.alwaysOnTop} onClick={() => report(window.localpets.save({ alwaysOnTop: !state.preferences.alwaysOnTop }))}><Pin size={12}/></button>
      {state.characters.filter(c => c.available).map(c => <button className="lc-pet-switch" key={c.id} title={`切换为${c.name}`} aria-label={`切换为${c.name}`} aria-pressed={state.preferences.selected === c.id} onClick={() => report(window.localpets.save({ selected: c.id }))}>{c.name.slice(0, 1)}</button>)}
      <button aria-label="隐藏桌宠" title="隐藏桌宠（可在应用内重新打开）" onClick={() => report(window.localpets.action('hide'))}><X size={13}/></button>
    </div>
    <button className="lc-pet-balloon" onMouseEnter={() => interactive(true)} title="点击查看任务" onClick={() => report(window.localpets.action('open-main'))}>{error || state.label}</button>
    <div className={`lc-pet-drag ${dragging ? 'dragging' : ''}`} role="button" aria-label={`拖动${character.name}`} tabIndex={0}
      onMouseEnter={() => interactive(true)} onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={e => {
        if (gesture.current?.pointerId !== e.pointerId) return;
        finishDrag('end', e);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        const bounds = e.currentTarget.getBoundingClientRect();
        interactive(e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom);
      }}
      onPointerCancel={() => finishDrag('cancel')} onLostPointerCapture={() => finishDrag('cancel')}
      onDoubleClick={() => report(window.localpets.action('open-main'))}
      onKeyDown={e => { if (e.key === 'Enter') report(window.localpets.action('open-main')); }}>
      <PetSprite character={character} animation={state.animation} size={state.preferences.size} paused={state.preferences.paused} direction={state.lookDirection}/>
    </div>
    <span className="lc-pet-shadow"/>
    <div className="lc-pet-leave" onMouseEnter={() => interactive(false)}/>
  </div>;
}
document.documentElement.classList.add('lc-pet-window');
createRoot(document.getElementById('root')!).render(<FloatingPet/>);
