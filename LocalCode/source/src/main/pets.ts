import { BrowserWindow, dialog, screen, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_PET, PET_NAMES, type PetAnimation, type PetCharacter, type PetDragInput, type PetId, type PetPreferences, type PetSnapshot } from '../shared/pets';
import type { AgentEvent } from '../shared/contracts';
import { clampPetPosition, lookDirection, petActivity } from '../core/pet-state';
import { DEFAULT_LOCALE, translate, type AppLocale } from '../shared/i18n';

const prefs = z.object({ enabled: z.boolean(), selected: z.enum(['paimon', 'ronova']), size: z.union([z.literal(128), z.literal(160), z.literal(192)]), alwaysOnTop: z.boolean(), paused: z.boolean(), followCursor: z.boolean(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional() }).strict();
const patch = prefs.omit({ position: true }).partial().strict();
const dragInput = z.object({ id: z.string().uuid(), phase: z.enum(['start', 'move', 'end', 'cancel']), screenX: z.number().finite().min(-100000).max(100000), screenY: z.number().finite().min(-100000).max(100000) }).strict();
export class PetController {
  private window?: BrowserWindow;
  private preferences: PetPreferences = { ...DEFAULT_PET };
  private characters: PetCharacter[] = [];
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
  constructor(private home: string, private dist: string, private mainWindow: () => BrowserWindow | undefined, private openMain: () => void, private locale: () => AppLocale = () => DEFAULT_LOCALE) {}
  private get file() { return path.join(this.home, 'data', 'pets.json'); }
  private async atlas(id: PetId): Promise<{ file: string; source: 'bundled' | 'imported'; bytes: Buffer } | undefined> {
    for (const [file, source] of [[path.join(this.home, 'data/pets', `${id}.png`), 'imported'], [path.join(this.dist, 'renderer/pets', `${id}.png`), 'bundled']] as const) {
      try { const bytes = await fs.readFile(file); this.validateAtlas(bytes); return { file, source, bytes }; }
      catch (error: any) { if (error.code !== 'ENOENT') continue; }
    }
  }
  private validateAtlas(bytes: Buffer) {
    if (bytes.length > 16 * 1024 * 1024 || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 1536 || bytes.readUInt32BE(20) !== 2288 || bytes[24] !== 8 || bytes[25] !== 6) throw new Error('请选择 1536×2288、8 位 RGBA 的 PNG 动画图集。不会执行或转换导入文件。');
  }
  async asset(id: PetId): Promise<Buffer | undefined> { return (await this.atlas(id))?.bytes; }
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
    this.characters = await Promise.all((['paimon', 'ronova'] as PetId[]).map(async id => { const image = await this.atlas(id); return { id, name: PET_NAMES[id], available: !!image, source: image?.source ?? 'missing', version: image ? createHash('sha256').update(image.bytes).digest('hex').slice(0, 16) : '' }; }));
  }
  snapshot(): PetSnapshot { return structuredClone({ locale: this.locale(), preferences: this.preferences, characters: this.characters, ...this.activity, ...(this.dragAnimation ? { animation: this.dragAnimation } : {}), lookDirection: this.direction }); }
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
    const choice = await dialog.showOpenDialog(this.mainWindow()!, { title: translate(this.locale(), '导入 {name} 原始动画图集', { name: translate(this.locale(), PET_NAMES[id]) }), properties: ['openFile'], filters: [{ name: translate(this.locale(), '1536×2288 RGBA 动画图集'), extensions: ['png'] }] });
    if (choice.canceled || !choice.filePaths[0]) return this.snapshot();
    const file = choice.filePaths[0], info = await fs.stat(file);
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('图集必须是小于 16MiB 的 PNG 文件。');
    const bytes = await fs.readFile(file); this.validateAtlas(bytes);
    const destination = path.join(this.home, 'data/pets', `${id}.png`); await fs.mkdir(path.dirname(destination), { recursive: true });
    try { await fs.copyFile(destination, `${destination}.previous-${Date.now()}`); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const temp = `${destination}.${randomUUID()}.tmp`; await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, destination);
    await this.refreshCharacters(); return this.save({ selected: id, enabled: true });
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
    if (method === 'import') return this.importAtlas(z.enum(['paimon', 'ronova']).parse(argument));
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
    this.window?.destroy(); this.window = undefined; await this.persist(); await this.writes;
  }
}
