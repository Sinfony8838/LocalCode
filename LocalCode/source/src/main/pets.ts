import { BrowserWindow, dialog, nativeImage, screen, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_PET, PET_NAMES, type PetAnimation, type PetCharacter, type PetDragInput, type PetId, type PetPreferences, type PetSnapshot } from '../shared/pets';
import type { AgentEvent } from '../shared/contracts';
import { clampPetPosition, lookDirection, petActivity } from '../core/pet-state';
import { DEFAULT_LOCALE, translate, type AppLocale } from '../shared/i18n';
import { PetLibrary, petDetailsSchema, petIdSchema, validatePetAtlasHeader, type CustomPet } from '../core/pet-library';

const prefs = z.object({ enabled: z.boolean(), selected: petIdSchema, size: z.union([z.literal(128), z.literal(160), z.literal(192)]), alwaysOnTop: z.boolean(), paused: z.boolean(), followCursor: z.boolean(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional() }).strict();
const patch = prefs.omit({ position: true }).partial().strict();
const dragInput = z.object({ id: z.string().uuid(), phase: z.enum(['start', 'move', 'end', 'cancel']), screenX: z.number().finite().min(-100000).max(100000), screenY: z.number().finite().min(-100000).max(100000) }).strict();
export class PetController {
  private window?: BrowserWindow;
  private preferences: PetPreferences = { ...DEFAULT_PET };
  private characters: PetCharacter[] = [];
  private library: PetLibrary;
  private libraryWarning?: string;
  private activity = petActivity('idle');
  private direction?: number;
  private interval?: ReturnType<typeof setInterval>;
  private transient?: ReturnType<typeof setTimeout>;
  private moveTimer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  private closing = false;
  private suppressMove = false;
  private fingerprint = '';
  private running = false;
  private dragAnimation?: PetAnimation;
  private cursor?: { x: number; y: number; movedAt: number };
  private pointerDrag?: { id: string; screenX: number; screenY: number; x: number; y: number };
  constructor(private home: string, private dist: string, private mainWindow: () => BrowserWindow | undefined, private openMain: () => void, private locale: () => AppLocale = () => DEFAULT_LOCALE) { this.library = new PetLibrary(path.join(home, 'data/pets'), bytes => this.validateAtlas(bytes)); }
  private get file() { return path.join(this.home, 'data', 'pets.json'); }
  private async atlas(id: PetId): Promise<{ file: string; source: 'bundled' | 'imported'; bytes: Buffer } | undefined> {
    petIdSchema.parse(id);
    const sources: [string, 'imported' | 'bundled'][] = [[path.join(this.home, 'data/pets', `${id}.png`), 'imported']];
    if (id === 'paimon' || id === 'ronova') sources.push([path.join(this.dist, 'renderer/pets', `${id}.png`), 'bundled']);
    for (const [file, source] of sources) {
      let bytes: Buffer;
      try { const info = await fs.stat(file); if (!info.isFile() || info.size > 16 * 1024 * 1024) continue; bytes = await fs.readFile(file); }
      catch { continue; }
      try { this.validateAtlas(bytes); return { file, source, bytes }; }
      catch (error: any) { if (error.code !== 'ENOENT') continue; }
    }
  }
  private validateAtlas(bytes: Buffer) {
    validatePetAtlasHeader(bytes);
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width !== 1536 || size.height !== 2288) throw new Error('PNG 图集无法完整解码，请重新导出或生成。');
  }
  async asset(id: PetId): Promise<Buffer | undefined> { if (!petIdSchema.safeParse(id).success || !this.characters.some(character => character.id === id)) return; return (await this.atlas(id))?.bytes; }
  async init() {
    if (this.closing) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try { this.preferences = prefs.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') await fs.copyFile(this.file, `${this.file}.invalid-${Date.now()}`).catch(() => {}); }
    await this.refreshCharacters();
    if (this.closing) return;
    if (!this.characters.find(c => c.id === this.preferences.selected)?.available) this.preferences.selected = this.characters.find(c => c.available)?.id ?? 'paimon';
    await this.persist(); await this.syncWindow();
    if (this.closing) return;
    this.interval = setInterval(() => this.followCursor(), 180); this.interval.unref();
    screen.on('display-removed', this.reposition); screen.on('display-metrics-changed', this.reposition);
  }
  private async refreshCharacters() {
    let custom: CustomPet[] = [];
    try { custom = await this.library.list(); this.libraryWarning = undefined; }
    catch (error) { this.libraryWarning = (error as Error).message; }
    const entries = [{ id: 'paimon', name: PET_NAMES.paimon, description: '陪你一起探索的旅伴' }, { id: 'ronova', name: PET_NAMES.ronova, description: '安静守候每一次灵感' }, ...custom];
    this.characters = await Promise.all(entries.map(async entry => { const image = await this.atlas(entry.id); return { ...entry, available: !!image, source: image?.source ?? 'missing', version: image ? createHash('sha256').update(image.bytes).digest('hex').slice(0, 16) : '' }; }));
  }
  snapshot(): PetSnapshot { return structuredClone({ locale: this.locale(), preferences: this.preferences, characters: this.characters, ...this.activity, ...(this.dragAnimation ? { animation: this.dragAnimation } : {}), lookDirection: this.direction, libraryWarning: this.libraryWarning }); }
  refreshLocale() { this.window?.setTitle(translate(this.locale(), 'LocalCode 桌宠')); this.broadcast(); }
  private broadcast() {
    const state = this.snapshot(), fingerprint = JSON.stringify(state);
    if (fingerprint === this.fingerprint) return; this.fingerprint = fingerprint;
    for (const w of [this.mainWindow(), this.window]) if (w && !w.isDestroyed()) w.webContents.send('localcode:pet-state', state);
  }
  private persist() {
    const data = JSON.stringify(this.preferences, null, 2);
    const work = async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`; await fs.writeFile(temp, data, { flag: 'wx' });
      for (let attempt = 0; ; attempt++) { try { await fs.rename(temp, this.file); break; } catch (e: any) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 12) throw e; await new Promise(r => setTimeout(r, 75)); } }
    };
    return this.writes = this.writes.then(work, work);
  }
  private dimensions() { return { width: this.preferences.size + 100, height: Math.round(this.preferences.size * 208 / 192) + 106 }; }
  private reposition = () => { if (this.window && !this.window.isDestroyed()) this.positionWindow(); };
  private positionWindow() {
    const size = this.dimensions();
    const area = this.preferences.position ? screen.getDisplayMatching({ ...this.preferences.position, ...size }).workArea : screen.getPrimaryDisplay().workArea;
    const position = clampPetPosition(this.preferences.position ?? { x: area.x + area.width - size.width - 30, y: area.y + area.height - size.height - 20 }, area, size.width, size.height);
    this.suppressMove = true; this.window?.setBounds({ ...position, ...size }); this.suppressMove = false;
    this.preferences.position = position;
  }
  private async syncWindow() {
    if (this.closing) return;
    if (!this.preferences.enabled || !this.characters.find(c => c.id === this.preferences.selected)?.available) { await this.finishPointerDrag(); this.window?.hide(); this.broadcast(); return; }
    if (!this.window || this.window.isDestroyed()) {
      const w = this.window = new BrowserWindow({ ...this.dimensions(), title: translate(this.locale(), 'LocalCode 桌宠'), transparent: true, frame: false, hasShadow: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: this.preferences.alwaysOnTop, show: false, backgroundColor: '#00000000', autoHideMenuBar: true, webPreferences: { preload: path.join(this.dist, 'pet-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
      w.setIgnoreMouseEvents(true, { forward: true });
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.webContents.on('will-navigate', event => event.preventDefault());
      w.on('close', event => { if (!this.closing) { event.preventDefault(); void this.save({ enabled: false }); } });
      w.on('blur', () => { void this.finishPointerDrag().catch(() => {}); });
      w.on('move', () => {
        if (this.closing || this.suppressMove || !this.window) return;
        const previous = this.preferences.position; const [x, y] = w.getPosition(); this.preferences.position = { x, y }; this.direction = undefined;
        if (previous && Math.abs(previous.x - x) > 1) this.dragAnimation = x > previous.x ? 'running-right' : 'running-left';
        this.broadcast(); if (this.moveTimer) clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => { if (this.pointerDrag) return; this.dragAnimation = undefined; this.positionWindow(); this.broadcast(); void this.persist().catch(() => {}); }, 240);
      });
      this.positionWindow();
      try { await w.loadURL('localcode://app/pet.html'); }
      catch (error) { if (this.window === w) this.window = undefined; if (!w.isDestroyed()) w.destroy(); if (this.closing) return; throw error; }
      if (this.closing || w.isDestroyed()) return;
    }
    this.positionWindow(); this.window.setAlwaysOnTop(this.preferences.alwaysOnTop); this.window.showInactive(); this.broadcast();
  }
  async save(input: Partial<Omit<PetPreferences, 'position'>>) {
    if (this.closing) throw new Error('应用正在关闭。');
    const parsed = patch.parse(input);
    if (parsed.selected && !this.characters.find(c => c.id === parsed.selected)?.available) throw new Error('此角色的原始图集尚未导入。');
    this.preferences = { ...this.preferences, ...parsed };
    if (!this.preferences.followCursor || this.preferences.paused) this.direction = undefined;
    await this.persist(); await this.syncWindow(); this.broadcast(); return this.snapshot();
  }
  async importAtlas(id: PetId) {
    petIdSchema.parse(id);
    const character = this.characters.find(entry => entry.id === id);
    if (!character) throw new Error('宠物不存在，请刷新列表。');
    const choice = await dialog.showOpenDialog(this.mainWindow()!, { title: translate(this.locale(), '导入 {name} 原始动画图集', { name: id.startsWith('custom-') ? character.name : translate(this.locale(), character.name) }), properties: ['openFile'], filters: [{ name: translate(this.locale(), '1536×2288 RGBA 动画图集'), extensions: ['png'] }] });
    if (choice.canceled || !choice.filePaths[0]) return this.snapshot();
    if (this.closing) throw new Error('应用正在关闭。');
    await this.library.replace(id, choice.filePaths[0]);
    await this.refreshCharacters(); return this.save({ selected: id, enabled: true });
  }
  async create(input: { name: string; description?: string }) {
    const details = petDetailsSchema.parse(input);
    const choice = await dialog.showOpenDialog(this.mainWindow()!, { title: translate(this.locale(), '导入新的虚拟宠物'), properties: ['openFile'], filters: [{ name: translate(this.locale(), '宠物清单或动画图集'), extensions: ['json', 'png'] }] });
    if (choice.canceled || !choice.filePaths[0]) return this.snapshot();
    if (this.closing) throw new Error('应用正在关闭。');
    const character = await this.library.create(choice.filePaths[0], details);
    await this.refreshCharacters(); return this.save({ selected: character.id, enabled: true });
  }
  async refresh() {
    await this.refreshCharacters();
    if (!this.characters.some(character => character.id === this.preferences.selected && character.available)) {
      this.preferences.selected = this.characters.find(character => character.available)?.id ?? 'paimon';
      await this.persist();
    }
    await this.syncWindow(); this.broadcast(); return this.snapshot();
  }
  async remove(id: PetId) {
    await this.library.remove(id); return this.refresh();
  }
  onAgentEvent(event: AgentEvent) {
    if (this.closing) return;
    if (event.type !== 'status' && event.type !== 'settled' && event.type !== 'approval') return;
    const status = event.type === 'approval' ? 'awaiting_approval' : event.status;
    this.running = status === 'running' || status === 'awaiting_approval'; this.activity = petActivity(status); this.direction = undefined;
    if (this.transient) clearTimeout(this.transient);
    if (['completed', 'failed', 'interrupted'].includes(status)) this.transient = setTimeout(() => { this.activity = petActivity('idle'); this.broadcast(); }, 8500);
    this.broadcast();
  }
  private followCursor() {
    if (this.pointerDrag || !this.window?.isVisible() || this.preferences.paused || !this.preferences.followCursor || this.activity.animation !== 'idle') return;
    const point = screen.getCursorScreenPoint(), bounds = this.window.getBounds();
    if (!this.cursor || this.cursor.x !== point.x || this.cursor.y !== point.y) this.cursor = { ...point, movedAt: Date.now() };
    const direction = Date.now() - this.cursor.movedAt > 1800 ? undefined : lookDirection(point.x - bounds.x - bounds.width / 2, point.y - bounds.y - bounds.height * .57);
    if (direction !== this.direction) { this.direction = direction; this.broadcast(); }
  }
  private async finishPointerDrag() {
    if (!this.pointerDrag) return;
    this.pointerDrag = undefined;
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = undefined; }
    this.dragAnimation = undefined;
    if (this.window && !this.window.isDestroyed()) { const [x, y] = this.window.getPosition(); this.preferences.position = { x, y }; }
    this.broadcast(); await this.persist();
  }
  private async drag(input: PetDragInput) {
    const w = this.window;
    if (this.closing || !w || w.isDestroyed() || !w.isVisible()) return;
    if (input.phase === 'start') {
      if (this.pointerDrag) return;
      const [x, y] = w.getPosition(); this.pointerDrag = { ...input, x, y };
      this.direction = undefined; w.setIgnoreMouseEvents(false); return;
    }
    const gesture = this.pointerDrag;
    if (!gesture || gesture.id !== input.id) return;
    if (input.phase !== 'cancel') {
      const size = this.dimensions(), area = screen.getDisplayNearestPoint({ x: Math.round(input.screenX), y: Math.round(input.screenY) }).workArea;
      const next = clampPetPosition({ x: gesture.x + input.screenX - gesture.screenX, y: gesture.y + input.screenY - gesture.screenY }, area, size.width, size.height);
      const previous = this.preferences.position; this.preferences.position = next;
      if (previous && next.x !== previous.x) this.dragAnimation = next.x > previous.x ? 'running-right' : 'running-left';
      this.suppressMove = true; w.setPosition(next.x, next.y); this.suppressMove = false; this.broadcast();
    }
    if (input.phase === 'end' || input.phase === 'cancel') await this.finishPointerDrag();
  }
  async invoke(event: IpcMainInvokeEvent, method: unknown, argument: unknown) {
    const sender = event.sender, main = this.mainWindow();
    if ((sender !== main?.webContents && sender !== this.window?.webContents) || event.senderFrame !== sender.mainFrame || !event.senderFrame?.url.startsWith('localcode://app/')) throw new Error('桌宠调用来源无效。');
    if (method === 'state') { z.undefined().parse(argument); return this.snapshot(); }
    if (method === 'save') return this.save(patch.parse(argument));
    if (['import', 'create', 'refresh', 'remove'].includes(String(method))) {
      if (sender !== main?.webContents) throw new Error('仅主窗口可管理宠物库。');
      if (this.closing) throw new Error('应用正在关闭。');
      if (method === 'import') return this.importAtlas(petIdSchema.parse(argument));
      if (method === 'create') return this.create(petDetailsSchema.parse(argument));
      if (method === 'remove') return this.remove(petIdSchema.parse(argument));
      z.undefined().parse(argument); return this.refresh();
    }
    if (method === 'interactive') { const value = z.boolean().parse(argument); if (sender !== this.window?.webContents) throw new Error('仅桌宠窗口可调整自身鼠标穿透。'); this.window.setIgnoreMouseEvents(!value && !this.pointerDrag, { forward: true }); return; }
    if (method === 'drag') { if (sender !== this.window?.webContents) throw new Error('仅桌宠窗口可拖动自身位置。'); return this.drag(dragInput.parse(argument)); }
    if (method === 'action') {
      const action = z.enum(['open-main', 'hide', 'reset-position']).parse(argument);
      if (action === 'open-main') this.openMain();
      else if (action === 'hide') await this.save({ enabled: false });
      else { await this.finishPointerDrag(); delete this.preferences.position; this.positionWindow(); await this.persist(); this.broadcast(); }
      return;
    }
    throw new Error('无效桌宠操作。');
  }
  async dispose() {
    this.closing = true; if (this.interval) clearInterval(this.interval); if (this.transient) clearTimeout(this.transient); if (this.moveTimer) clearTimeout(this.moveTimer);
    await this.finishPointerDrag();
    screen.removeListener('display-removed', this.reposition); screen.removeListener('display-metrics-changed', this.reposition);
    this.window?.destroy(); this.window = undefined; await this.persist(); await this.writes; await this.library.settled();
  }
}
