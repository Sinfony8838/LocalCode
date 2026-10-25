export type PetId = 'paimon' | 'ronova';
export type PetAnimation = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
export interface PetPreferences {
  enabled: boolean;
  selected: PetId;
  size: 128 | 160 | 192;
  alwaysOnTop: boolean;
  paused: boolean;
  followCursor: boolean;
  position?: { x: number; y: number };
}
export interface PetCharacter { id: PetId; name: string; available: boolean; version: string; source: 'bundled' | 'imported' | 'missing' }
export interface PetSnapshot {
  preferences: PetPreferences;
  characters: PetCharacter[];
  animation: PetAnimation;
  label: string;
  lookDirection?: number;
}
export interface PetDragInput { id: string; phase: 'start' | 'move' | 'end' | 'cancel'; screenX: number; screenY: number }
export interface PetApi {
  state(): Promise<PetSnapshot>;
  save(input: Partial<Omit<PetPreferences, 'position'>>): Promise<PetSnapshot>;
  action(action: 'open-main' | 'hide' | 'reset-position'): Promise<void>;
  importAtlas(id: PetId): Promise<PetSnapshot>;
  interactive(value: boolean): Promise<void>;
  drag(input: PetDragInput): Promise<void>;
  onState(listener: (snapshot: PetSnapshot) => void): () => void;
}
export const PET_NAMES: Record<PetId, string> = { paimon: '自定义旅伴 A', ronova: '自定义旅伴 B' };
export const PET_ROWS: Record<PetAnimation, { row: number; frames: number; fps: number }> = {
  idle: { row: 0, frames: 6, fps: 4 },
  'running-right': { row: 1, frames: 8, fps: 8 },
  'running-left': { row: 2, frames: 8, fps: 8 },
  waving: { row: 3, frames: 4, fps: 5 }, jumping: { row: 4, frames: 5, fps: 6 },
  failed: { row: 5, frames: 8, fps: 4 }, waiting: { row: 6, frames: 6, fps: 3 },
  running: { row: 7, frames: 6, fps: 4 }, review: { row: 8, frames: 6, fps: 4 },
};
export const DEFAULT_PET: PetPreferences = { enabled: false, selected: 'paimon', size: 160, alwaysOnTop: true, paused: false, followCursor: true };
declare global { interface Window { localpets: PetApi } }
