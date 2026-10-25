import { describe, expect, it } from 'vitest';
import { clampPetPosition, lookDirection, petActivity } from '../src/core/pet-state';
describe('desktop companion behavior', () => {
  it('distinguishes waiting, working, failure, cancellation and completion', () => {
    expect(petActivity('awaiting_approval').animation).toBe('waiting');
    expect(petActivity('running').animation).toBe('running');
    expect(petActivity('completed').animation).toBe('review');
    expect(petActivity('failed').animation).toBe('failed');
    expect(petActivity('interrupted').label).toContain('停止');
    expect(petActivity('idle').animation).toBe('idle');
  });
  it('maps all sixteen cursor directions to the original look cells', () => {
    for (let i = 0; i < 16; i++) { const radians = i * Math.PI / 8; expect(lookDirection(Math.sin(radians) * 150, -Math.cos(radians) * 150)).toBe(i); }
    expect(lookDirection(0, 0)).toBeUndefined();
  });
  it('keeps a companion reachable when a monitor is removed', () => {
    expect(clampPetPosition({ x: 2500, y: -800 }, { x: 0, y: 0, width: 1920, height: 1040 }, 260, 280)).toEqual({ x: 1660, y: 0 });
    expect(clampPetPosition({ x: 10, y: 10 }, { x: 0, y: 0, width: 100, height: 100 }, 260, 280)).toEqual({ x: 0, y: 0 });
  });
  it('preserves negative-coordinate monitors and valid return-to-origin placement', () => {
    expect(clampPetPosition({ x: -1300, y: 90 }, { x: -1920, y: -200, width: 1920, height: 1080 }, 260, 280)).toEqual({ x: -1300, y: 90 });
    expect(clampPetPosition({ x: 0, y: 0 }, { x: 0, y: 0, width: 1920, height: 1080 }, 260, 280)).toEqual({ x: 0, y: 0 });
  });
});
