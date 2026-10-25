import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, AppSettings, Project, ProviderConfig, SessionView, Theme } from '../shared/contracts';
import { reduceAgentEvent } from '../shared/session-events';
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE } from '../shared/contracts';

interface Index { version: 1; projects: Project[]; sessions: SessionView[]; settings: AppSettings; keys: Record<string, string> }
const local: ProviderConfig = { id: 'local', name: 'Ollama 本地模型', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'localcode-agent:latest', contextWindow: 8192, maxTokens: 1024, hasKey: false };
export class Store {
  private state!: Index;
  private writes = Promise.resolve();
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private backgroundError?: unknown;
  readonly indexFile: string;
  constructor(readonly dataDir: string) { this.indexFile = path.join(dataDir, 'index.json'); }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const text = await fs.readFile(this.indexFile, 'utf8');
      this.state = JSON.parse(text);
      if (this.state.version !== 1 || !Array.isArray(this.state.projects) || !Array.isArray(this.state.sessions) || !Array.isArray(this.state.settings?.providers) || !this.state.keys) throw new Error('数据索引格式不正确，原文件已保留。');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      let profile = { contextWindow: 8192, maxTokens: 1024 };
      try {
        const schema = z.object({ contextWindow: z.number().int().min(4096).max(131072), maxTokens: z.number().int().min(128).max(32768) }).strict().refine(v => v.maxTokens + 1536 < v.contextWindow);
        profile = schema.parse(JSON.parse(await fs.readFile(path.join(this.dataDir, '..', 'model-profile.json'), 'utf8')));
      } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('本地模型配置无效，请检查 model-profile.json。'); }
      this.state = { version: 1, projects: [], sessions: [], settings: { theme: 'light', fontSize: DEFAULT_FONT_SIZE, defaultProviderId: 'local', providers: [{ ...local, ...profile, id: 'local' }] }, keys: {} };
    }
    const fontSize = this.state.settings.fontSize;
    if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) this.state.settings.fontSize = DEFAULT_FONT_SIZE;
    for (const session of this.state.sessions) {
      if (session.status === 'running' || session.status === 'awaiting_approval') {
        session.status = 'interrupted'; session.error = '上次运行被中断。不会自动重放命令，可以发送新消息继续。';
      }
      session.messages.filter(m => m.partial).forEach(m => { m.partial = false; });
      for (const message of session.messages) for (const part of message.parts ?? []) if (part.state === 'streaming') { part.state = 'interrupted'; part.endedAt = new Date().toISOString(); }
      delete session.progress;
      session.tools.filter(t => t.status === 'running').forEach(t => { t.status = 'failed'; t.isError = true; t.result = '应用退出，执行状态未确认。不会自动重试。'; });
      delete session.approval;
    }
    await this.persist();
  }
  persist() {
    clearTimeout(this.deltaTimer); this.deltaTimer = undefined;
    const snapshot = JSON.stringify(this.state, null, 2);
    const write = async () => {
      const tmp = this.indexFile + '.' + randomUUID() + '.tmp';
      await fs.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.indexFile); break; }
        catch (error: any) {
          // Windows readers/scanners can briefly hold a file without FILE_SHARE_DELETE.
          // Keep the previous index intact; never replace atomic rename with truncating writes.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 + attempt * 10));
        }
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
  async flush() { if (this.deltaTimer) await this.persist(); await this.writes; if (this.backgroundError) throw this.backgroundError; }
  projects() { return structuredClone(this.state.projects); }
  sessions() { return structuredClone(this.state.sessions); }
  settings() { return structuredClone(this.state.settings); }
  project(id: string) { const p = this.state.projects.find(p => p.id === id); if (!p) throw new Error('项目不存在'); return p; }
  session(id: string) { const s = this.state.sessions.find(s => s.id === id); if (!s) throw new Error('会话不存在'); return s; }
  provider(id: string) { const p = this.state.settings.providers.find(p => p.id === id); if (!p) throw new Error('模型配置不存在'); return p; }
  encryptedKey(id: string) { return this.state.keys[id]; }
  async addProject(folder: string) {
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('请选择文件夹');
    const existing = this.state.projects.find(p => p.path.toLowerCase() === canonical.toLowerCase());
    if (existing) return structuredClone(existing);
    const project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: new Date().toISOString() };
    this.state.projects.push(project); await this.persist(); return structuredClone(project);
  }
  async createSession(projectId: string) {
    this.project(projectId);
    const now = new Date().toISOString();
    const session: SessionView = { id: randomUUID(), projectId, title: '新会话', createdAt: now, updatedAt: now, providerId: 'local', status: 'idle', messages: [], tools: [] };
    this.state.sessions.unshift(session); await this.persist(); return structuredClone(session);
  }
  async renameSession(id: string, title: string) { const s = this.session(id); s.title = title; await this.persist(); return structuredClone(s); }
  async beginRun(sessionId: string, prompt: string, providerId: string, modelId?: string) {
    const s = this.session(sessionId); this.provider(providerId);
    s.runId = randomUUID(); s.status = 'running'; s.providerId = providerId; s.error = undefined; s.approval = undefined;
    delete s.progress;
    s.modelId = modelId;
    s.updatedAt = new Date().toISOString();
    if (s.title === '新会话') s.title = prompt.replace(/\s+/g, ' ').slice(0, 36);
    s.messages.push({ id: randomUUID(), role: 'user', text: prompt, createdAt: s.updatedAt });
    await this.persist(); return structuredClone(s);
  }
  async event(event: AgentEvent) {
    const index = this.state.sessions.findIndex(s => s.id === event.sessionId);
    if (index === -1 || this.state.sessions[index].runId !== event.runId) return;
    this.state.sessions[index] = reduceAgentEvent(this.state.sessions[index], event);
    if (event.type === 'part_delta' || event.type === 'text_delta' || event.type === 'progress') {
      this.deltaTimer ??= setTimeout(() => { this.deltaTimer = undefined; void this.persist().catch(error => { this.backgroundError = error; }); }, 500);
      return;
    }
    await this.persist();
  }
  async saveProvider(provider: ProviderConfig, encryptedKey?: string | null) {
    if (provider.kind === 'ollama' && provider.id !== 'local') throw new Error('Ollama 使用内置本地配置；其他服务请添加兼容 API。');
    if (provider.id === 'local') {
      if (provider.kind !== 'ollama' || provider.baseUrl !== local.baseUrl || provider.model !== local.model) throw new Error('内置本地模型的地址和名称不可更改');
      provider.contextWindow = this.provider('local').contextWindow;
      provider.maxTokens = this.provider('local').maxTokens;
      provider.enabled = true;
      delete provider.models;
    }
    if (encryptedKey === null) delete this.state.keys[provider.id];
    else if (encryptedKey !== undefined) this.state.keys[provider.id] = encryptedKey;
    provider.hasKey = !!this.state.keys[provider.id];
    const i = this.state.settings.providers.findIndex(p => p.id === provider.id);
    if (i >= 0) this.state.settings.providers[i] = provider; else this.state.settings.providers.push(provider);
    await this.persist(); return structuredClone(provider);
  }
  async deleteProvider(id: string) {
    if (id === 'local') throw new Error('内置本地模型不可删除。');
    this.provider(id);
    this.state.settings.providers = this.state.settings.providers.filter(p => p.id !== id);
    delete this.state.keys[id];
    if (this.state.settings.defaultProviderId === id) this.state.settings.defaultProviderId = 'local';
    await this.persist();
  }
  async setTheme(theme: Theme) { this.state.settings.theme = theme; await this.persist(); }
  async setFontSize(fontSize: number) {
    if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) throw new Error('字号必须是 12–20 之间的整数。');
    this.state.settings.fontSize = fontSize;
    await this.persist();
  }
}
