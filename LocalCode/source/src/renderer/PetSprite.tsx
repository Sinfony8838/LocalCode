import { t, useLocale } from './i18n';
import React, { useEffect, useState } from 'react';
import { PET_ROWS, type PetAnimation, type PetCharacter } from '../shared/pets';
export function PetSprite({ character, animation = 'idle', size = 160, paused = false, direction }: { character: PetCharacter; animation?: PetAnimation; size?: number; paused?: boolean; direction?: number }) {
  useLocale();
  const [frame, setFrame] = useState(0);
  const [reduced, setReduced] = useState(false);
  const state = PET_ROWS[animation];
  useEffect(() => { const media = matchMedia('(prefers-reduced-motion: reduce)'); const update = () => setReduced(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => {
    setFrame(0); if (paused || reduced || direction !== undefined) return;
    const interval = setInterval(() => setFrame(value => (value + 1) % state.frames), 1000 / state.fps);
    return () => clearInterval(interval);
  }, [character.id, animation, state.frames, state.fps, paused, reduced, direction]);
  const row = direction === undefined || paused ? state.row : direction < 8 ? 9 : 10;
  const column = direction === undefined || paused ? frame : direction % 8;
  const height = size * 208 / 192;
  const animationLabels: Record<PetAnimation, string> = { idle: '待机', 'running-right': '向右移动', 'running-left': '向左移动', waving: '挥手', jumping: '跳跃', failed: '遇到问题', waiting: '等待确认', running: '正在处理', review: '查看结果' };
  return <span className="pet-sprite" role="img" aria-label={`${character.id.startsWith('custom-') ? character.name : t(character.name)} · ${t(animationLabels[animation])}`} data-character={character.id} data-animation={animation} data-frame={column}
    style={{ display: 'block', width: size, height, backgroundImage: `url("./pets/${character.id}.png?v=${character.version}")`, backgroundSize: `${size * 8}px ${height * 11}px`, backgroundPosition: `${-size * column}px ${-height * row}px`, backgroundRepeat: 'no-repeat' }} />;
}
