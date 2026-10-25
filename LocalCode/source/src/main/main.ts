import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, screen, shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store';
import { prepareStartupStorage, STARTUP_STORAGE_ERROR, LOG_STORAGE_ERROR } from './startup-storage';
import { RequestScheduler } from './request-scheduler';
import { ArtifactController } from './artifacts';
import { PREVIEW_SCHEME, externalBrowserUrl } from '../core/artifacts';
import { createHash } from 'node:crypto';
import { inspectLocalModel, localModelProbeSchema } from './local-model-health';
import { managedOllamaState, startManagedOllama } from './managed-ollama';
import { providerSchema, testConnection } from './providers';
import { selectProviderModel } from '../shared/providers';
import { translate } from '../shared/i18n';
import { PetController } from './pets';
import { workspaceBoundary } from '../core/workspace-context';
import { listWorkspaceFiles, readWorkspaceFile, getChanges, undoChange, previewChangeCheckpoint, checkpointChange } from '../core/workspace';
import { cleanupOwnedCommands } from '../core/command';
import type { AgentEvent, AppEvent, ModelHealth, ProviderSecret, WorkerCommand, TransportMessage, TransportGrant } from '../shared/contracts';

function initializeApplication() {
const home = path.resolve(process.env.LOCALCODE_HOME || app.getPath('userData'));
const { dataDir, cacheDir, logsDir, logPath, logFd } = prepareStartupStorage(home);
app.setPath('userData', path.join(dataDir, 'electron'));
app.setPath('sessionData', path.join(cacheDir, 'chromium'));
app.setPath('crashDumps', path.join(cacheDir, 'crashes'));
app.setAppLogsPath(logsDir);
process.env.TEMP = cacheDir; process.env.TMP = cacheDir;
protocol.registerSchemesAsPrivileged([
  { scheme: 'localcode', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const store = new Store(dataDir);
const tr = (source: string, values?: Record<string, string | number>) => translate(store.settings().locale, source, values);
const artifacts = new ArtifactController();
let window: BrowserWindow | undefined;
const pets = new PetController(home, __dirname, () => window, () => { window?.restore(); window?.show(); window?.focus(); }, () => store.settings().locale);
type ActiveRun = { runId: string; sessionId: string; apiKey?: string; child: UtilityProcess; requestGroup: string };
const requestScheduler = new RequestScheduler();
const runs = new Map<string, ActiveRun>();
const workers = new Map<string, UtilityProcess>();
const starting = new Map<string, { cancelled: boolean }>();
const recovering = new Map<string, Promise<void>>();
let quitting = false;
let quitReady = false;
let eventQueue = Promise.resolve();
const stopping = new Map<string, Promise<void>>();
let cleanupQueue = Promise.resolve();
let changingFiles = false;
let localServiceStart: Promise<ModelHealth> | undefined;
function cleanupCommands(workerPid?: number) {
  cleanupQueue = cleanupQueue.catch(() => {}).then(() => cleanupOwnedCommands(dataDir, workerPid));
  return cleanupQueue;
}
const log = createWriteStream(logPath, { fd: logFd, flags: 'a', autoClose: true });
let logErrorShown = false;
log.on('error', () => {
  if (logErrorShown) return;
  logErrorShown = true;
  // A later logging failure must not become an uncaught error or kill an active task.
  try { dialog.showErrorBox('LocalCode 日志不可写', LOG_STORAGE_ERROR); } catch { /* Preserve active work even if the native dialog is unavailable. */ }
});
const id = z.string().uuid();
const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const relPath = z.string().min(1).max(2048);
const emit = (event: AppEvent) => { if (window && !window.isDestroyed()) window.webContents.send('localcode:event', event); };
const post = (run: ActiveRun, command: WorkerCommand) => run.child.postMessage(command);

async function health(): Promise<ModelHealth> {
  const local = store.provider('local');
  return inspectLocalModel({ baseUrl: local.baseUrl, model: local.model, contextWindow: local.contextWindow, ollamaMode: local.ollamaMode }, { managedState: () => managedOllamaState(home) });
}
async function processEvent(raw: AgentEvent) {
  const active = runs.get(raw.sessionId);
  if (!active || raw.runId !== active.runId || raw.sessionId !== active.sessionId) return;
  let event = raw;
  if (active.apiKey && active.apiKey.length >= 6) event = JSON.parse(JSON.stringify(raw).split(active.apiKey).join('[密钥已隐藏]'));
  // The worker emits settled only after inference, approvals and commands are cleaned up.
  // Keep the run locked until the final disk snapshot and durable summary settle.
  // Otherwise an undo from another idle session can race the final file scan.
  event = await store.event(event) ?? event;
  if (event.type === 'settled') { requestScheduler.cancel(active.runId); runs.delete(event.sessionId); }
  if (['status', 'settled', 'approval', 'approval_resolved'].includes(event.type)) {
    const sessions = store.sessions();
    const other = sessions.find(session => session.status === 'awaiting_approval') || sessions.find(session => session.status === 'running');
    pets.onAgentEvent(other ? { type: 'status', runId: other.runId!, sessionId: other.id, status: other.status } : event);
  }
  emit(event);
  // Each worker owns exactly one run, including its commands and credentials.
  if (event.type === 'settled') active.child.kill();
}
function createWorker(sessionId: string, apiKey?: string) {
  const child = utilityProcess.fork(path.join(__dirname, 'worker.mjs'), [], { serviceName: 'LocalCode Agent', stdio: 'pipe', env: { ...process.env, LOCALCODE_DATA_DIR: dataDir, TEMP: cacheDir, TMP: cacheDir } });
  workers.set(sessionId, child);
  let workerPid: number | undefined;
  child.once('spawn', () => { workerPid = child.pid; });
  const write = (buffer: Buffer) => { let text = buffer.toString(); if (apiKey && apiKey.length >= 6) text = text.split(apiKey).join('[密钥已隐藏]'); log.write(text); };
  child.stdout?.on('data', write); child.stderr?.on('data', write);
  child.on('message', (event: AgentEvent | TransportMessage) => {
    const run = runs.get(sessionId);
    if (!run || run.child !== child || event.sessionId !== sessionId || event.runId !== run.runId) return;
    // Permits must never await inside the event persistence queue: the holder needs it too.
    if (event.type === 'request_acquire') {
      requestScheduler.acquire(run.requestGroup, run.runId, event.requestId, () => {
        if (runs.get(sessionId) === run) child.postMessage({ type: 'request_grant', runId: run.runId, requestId: event.requestId } satisfies TransportGrant);
        else requestScheduler.cancel(run.runId);
      }); return;
    }
    if (event.type === 'request_release') { requestScheduler.release(run.requestGroup, run.runId, event.requestId, Number.isFinite(event.cooldownUntil) ? event.cooldownUntil : 0); return; }
    if (event.type === 'request_cancel') { requestScheduler.cancel(run.runId, event.requestId); return; }
    eventQueue = eventQueue.then(() => { if (runs.get(sessionId)?.child === child) return processEvent(event); }).catch(error => { log.write(`Agent event: ${error.message}\n`); });
  });
  child.on('exit', code => {
    const active = runs.get(sessionId);
    const ended = active?.child === child ? { runId: active.runId, sessionId: active.sessionId } : undefined;
    if (ended) requestScheduler.cancel(ended.runId);
    if (workers.get(sessionId) === child) workers.delete(sessionId);
    eventQueue = eventQueue.then(async () => {
      // Never sweep another live session's command ownership records.
      if (workerPid) await cleanupCommands(workerPid);
      if (ended && runs.get(sessionId)?.child === child && runs.get(sessionId)?.runId === ended.runId) await processEvent({ type: 'settled', ...ended, status: 'interrupted', error: tr('Agent 进程退出（{code}），未自动重放任何命令。', { code: code ?? 'unknown' }) });
    }).catch(error => { log.write(`Worker exit: ${error.message}\n`); });
    const recovery = eventQueue;
    recovering.set(sessionId, recovery);
    void recovery.finally(() => { if (recovering.get(sessionId) === recovery) recovering.delete(sessionId); });
  });
  return child;
}
async function stopRun(sessionId: string) {
  const pending = starting.get(sessionId);
  if (pending) {
    pending.cancelled = true;
    while (starting.get(sessionId) === pending) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const active = runs.get(sessionId);
  if (!active || active.sessionId !== sessionId) return;
  const runId = active.runId;
  const existing = stopping.get(runId);
  if (existing) return existing;
  const operation = stopRunOnce(sessionId);
  stopping.set(runId, operation);
  try { await operation; } finally { stopping.delete(runId); }
}
async function stopRunOnce(sessionId: string) {
  const active = runs.get(sessionId);
  if (!active || active.sessionId !== sessionId) return;
  const runId = active.runId;
  post(active, { type: 'abort', runId });
  const until = Date.now() + 15000;
  while (runs.get(sessionId)?.runId === runId && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  if (runs.get(sessionId)?.runId === runId) {
    const stoppedWorker = active.child;
    if (stoppedWorker) {
      const exited = new Promise<void>(resolve => stoppedWorker.once('exit', () => resolve()));
      stoppedWorker.kill();
      await exited;
      await recovering.get(sessionId);
    }
    await processEvent({ type: 'settled', runId, sessionId, status: 'interrupted', error: tr('任务已强制停止。未自动重试命令。') });
  }
}

const schemas: Record<string, z.ZodType> = {
  bootstrap: z.undefined(), pickProject: z.undefined(), createSession: id, openSession: id,
  renameSession: z.object({ sessionId: id, title: z.string().trim().min(1).max(100) }).strict(),
  send: z.object({ sessionId: id, prompt: z.string().trim().min(1).max(30000), providerId, modelId: z.string().min(1).max(200).optional() }).strict(), stop: id,
  approve: z.object({ runId: id, approvalId: z.string().min(1).max(200), allow: z.boolean() }).strict(),
  listFiles: z.object({ projectId: id, directory: z.string().max(2048).optional() }).strict(), readFile: z.object({ projectId: id, path: relPath }).strict(),
  artifactInfo: z.object({ projectId: id, path: z.string().min(1).max(4096), inputKind: z.enum(['path', 'reference']).optional() }).strict(),
  artifactAction: z.object({ projectId: id, path: z.string().min(1).max(4096), action: z.enum(['open', 'choose-app', 'reveal', 'copy-path']), inputKind: z.enum(['path', 'reference']).optional() }).strict(),
  openExternal: z.string().min(1).max(4096),
  changes: id, undo: z.object({ sessionId: id, path: relPath }).strict(),
  previewCheckpoint: z.object({ sessionId: id, path: relPath }).strict(),
  checkpoint: z.object({ sessionId: id, path: relPath, expectedHash: z.string().regex(/^[a-f0-9]{64}$/), expectedRecordHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  saveProvider: providerSchema,
  inspectLocalModel: localModelProbeSchema, startLocalService: z.undefined(),
  deleteProvider: providerId,
  testProvider: z.object({ providerId, modelId: z.string().min(1).max(200).optional() }).strict(),
  setTheme: z.enum(['light', 'dark']), setLocale: z.enum(['zh-CN', 'en', 'ja', 'ko']), setFontSize: z.number().int().min(12).max(20), health: z.undefined(), openDataFolder: z.undefined(),
};
function assertChangesIdle() {
  if (runs.size || starting.size || recovering.size || changingFiles) throw new Error(tr('请等待所有任务及恢复操作结束，再撤销文件修改或确认新起点。'));
}
async function invoke(method: string, arg: any) {
  switch (method) {
    case 'bootstrap': { const currentHealth = await health(); await eventQueue; return { projects: store.projects(), sessions: store.sessions(), settings: store.settings(), health: currentHealth, version: app.getVersion() }; }
    case 'pickProject': { const choice = await dialog.showOpenDialog(window!, { title: tr('选择编程项目'), properties: ['openDirectory'] }); if (choice.canceled || !choice.filePaths[0]) return null; const p = await store.addProject(choice.filePaths[0]); emit({ type: 'state_changed' }); return p; }
    case 'createSession': return store.createSession(arg);
    case 'openSession': await eventQueue; return structuredClone(store.session(arg));
    case 'renameSession': return store.renameSession(arg.sessionId, arg.title);
    case 'send': {
      if (changingFiles) throw new Error(tr('正在保存文件修改记录，请稍后再开始任务。'));
      if (quitting || runs.has(arg.sessionId) || starting.has(arg.sessionId)) throw new Error(tr('此会话已有任务运行中，请先停止或等待完成。'));
      // A turn retains the language selected when Send was accepted, even if
      // settings change while its workspace/model preflight is still pending.
      const locale = store.settings().locale;
      const startup = { cancelled: false };
      starting.set(arg.sessionId, startup);
      let active: ActiveRun | undefined;
      let begun: { id: string; runId?: string } | undefined;
      try {
      await recovering.get(arg.sessionId);
      await eventQueue;
      await workspaceBoundary(store.sessionWorkspace(arg.sessionId));
      const provider = selectProviderModel(store.provider(arg.providerId), arg.modelId);
      if (provider.kind === 'ollama') { const h = await health(); if (!h.online || !h.modelAvailable) throw new Error(h.message || tr('本地模型不可用')); }
      const cipher = store.encryptedKey(provider.id);
      const secret: ProviderSecret = { ...provider, apiKey: provider.kind === 'ollama' ? 'ollama' : cipher ? safeStorage.decryptString(Buffer.from(cipher, 'base64')) : '' };
      if (provider.kind !== 'ollama' && !secret.apiKey) throw new Error(tr('请先在设置中保存此 API 的密钥。'));
      if (quitting || startup.cancelled) throw new Error(tr('启动已取消。'));
      const session = await store.beginRun(arg.sessionId, arg.prompt, arg.providerId, provider.model);
      begun = session;
      const child = createWorker(session.id, provider.kind !== 'ollama' ? secret.apiKey : undefined);
      const requestGroup = new URL(provider.baseUrl).origin + ':' + createHash('sha256').update(secret.apiKey).digest('hex');
      active = { runId: session.runId!, sessionId: session.id, apiKey: provider.kind !== 'ollama' ? secret.apiKey : undefined, child, requestGroup };
      runs.set(session.id, active);
      if (quitting || startup.cancelled) throw new Error(tr('启动已取消，任务未执行。'));
      post(active, { type: 'run', runId: session.runId!, sessionId: session.id, ...store.sessionWorkspace(session.id), piFile: session.piFile, provider: secret, prompt: arg.prompt, locale });
      emit({ type: 'state_changed' }); return { runId: session.runId };
      } catch (error) {
        if (active) await processEvent({ type: 'settled', runId: active.runId, sessionId: active.sessionId, status: quitting || startup.cancelled ? 'interrupted' : 'failed', error: (error as Error).message });
        else if (begun?.runId) {
          const event: AgentEvent = { type: 'settled', runId: begun.runId, sessionId: begun.id, status: 'failed', error: (error as Error).message };
          emit(await store.event(event) ?? event);
        }
        throw error;
      } finally { starting.delete(arg.sessionId); }
    }
    case 'stop': await stopRun(arg); return;
    case 'approve': { const active = [...runs.values()].find(run => run.runId === arg.runId); if (!active) throw new Error(tr('审批已失效，命令未执行。')); const approval = store.session(active.sessionId).approval; if (!approval || approval.id !== arg.approvalId || approval.runId !== arg.runId) throw new Error(tr('审批不匹配或已失效。')); post(active, { type: 'approve', ...arg }); return; }
    case 'listFiles': return listWorkspaceFiles(store.workspace(arg.projectId), arg.directory || '');
    case 'readFile': return readWorkspaceFile(store.workspace(arg.projectId), arg.path);
    case 'artifactInfo': return artifacts.info(store.workspace(arg.projectId), arg.path, arg.inputKind);
    case 'artifactAction': return artifacts.action(store.workspace(arg.projectId), arg.path, arg.action, arg.inputKind);
    case 'openExternal': await shell.openExternal(externalBrowserUrl(arg)); return;
    case 'changes': return getChanges(store.sessionWorkspace(arg), arg);
    case 'previewCheckpoint': assertChangesIdle(); store.session(arg.sessionId); return previewChangeCheckpoint(store.sessionWorkspace(arg.sessionId), arg.sessionId, arg.path);
    case 'undo':
    case 'checkpoint': {
      assertChangesIdle(); store.session(arg.sessionId);
      // Reserve synchronously, before any await, so a new send cannot race this operation.
      changingFiles = true;
      try {
        if (method === 'undo') await undoChange(store.sessionWorkspace(arg.sessionId), arg.sessionId, arg.path);
        else await checkpointChange(store.sessionWorkspace(arg.sessionId), arg.sessionId, arg.path, arg.expectedHash, arg.expectedRecordHash);
        emit({ type: 'state_changed' });
      } finally { changingFiles = false; }
      return;
    }
    case 'saveProvider': { if (runs.size || starting.size || localServiceStart) throw new Error(tr('任务或本地服务启动期间不能修改模型配置。')); const { apiKey, ...publicData } = arg; let cipher: string | undefined; if (apiKey) { if (!safeStorage.isEncryptionAvailable()) throw new Error(tr('Windows 密钥加密暂不可用，未保存密钥。')); cipher = safeStorage.encryptString(apiKey).toString('base64'); } const p = await store.saveProvider({ ...publicData, hasKey: false }, cipher); emit({ type: 'state_changed' }); return p; }
    case 'deleteProvider': { if (runs.size || starting.size) throw new Error(tr('任务运行时不能删除供应商。')); await store.deleteProvider(arg); emit({ type: 'state_changed' }); return; }
    case 'testProvider': {
      if (runs.size || starting.size) throw new Error(tr('请等待当前任务结束后测试连接。'));
      const provider = selectProviderModel(store.provider(arg.providerId), arg.modelId);
      if (provider.kind === 'ollama') throw new Error(tr('请使用 Ollama 状态刷新。'));
      const cipher = store.encryptedKey(provider.id);
      if (!cipher) throw new Error(tr('请先保存 API Key。'));
      try { return await testConnection({ ...provider, apiKey: safeStorage.decryptString(Buffer.from(cipher, 'base64')) }); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const status = /^HTTP (\d{3}) · (.+)$/.exec(message);
        if (status) throw new Error(`HTTP ${status[1]} · ${tr(status[2])}`);
        throw error;
      }
    }
    case 'setTheme': await store.setTheme(arg); return;
    case 'setLocale': await store.setLocale(arg); pets.refreshLocale(); emit({ type: 'state_changed' }); return;
    case 'setFontSize': await store.setFontSize(arg); return;
    case 'health': return health();
    case 'inspectLocalModel': return inspectLocalModel(arg, { managedState: () => managedOllamaState(home) });
    case 'startLocalService': {
      if (runs.size || starting.size) throw new Error(tr('请等待当前任务结束后启动本地服务。'));
      if (store.provider('local').ollamaMode === 'existing') throw new Error(tr('已有 Ollama 由你自行管理，应用不会启动或停止它。'));
      if (localServiceStart) return localServiceStart;
      localServiceStart = startManagedOllama(home).then(() => health());
      try { return await localServiceStart; } finally { localServiceStart = undefined; }
    }
    case 'openDataFolder': await shell.openPath(dataDir); return;
  }
}
async function createWindow() {
  const rendererRoot = path.join(__dirname, 'renderer');
  protocol.handle(PREVIEW_SCHEME, request => artifacts.response(request));
  protocol.handle('localcode', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403 });
      const petAsset = /^\/pets\/(paimon|ronova)\.png$/.exec(url.pathname);
      if (petAsset) { const bytes = await pets.asset(petAsset[1] as 'paimon' | 'ronova'); return bytes ? new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } }) : new Response('Pet asset unavailable', { status: 404 }); }
      const filename = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname || '/index.html'));
      if (!filename.startsWith(rendererRoot + path.sep)) return new Response('Forbidden', { status: 403 });
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      return new Response(await fs.readFile(filename), { headers: { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: localcode-preview:; font-src 'self'; connect-src 'self'; frame-src localcode-preview:; object-src 'none'; base-uri 'none'" } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1200, Math.floor(workArea.width * .9));
  const height = Math.min(800, Math.floor(workArea.height * .9));
  window = new BrowserWindow({ width, height, x: workArea.x + Math.floor((workArea.width - width) / 2), y: workArea.y + Math.floor((workArea.height - height) / 2), minWidth: Math.min(1050, width), minHeight: Math.min(700, height), fullscreen: false, title: 'LocalCode', backgroundColor: '#f9edf1', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  // Only explicit main-frame IPC opens browser links; preview popups never do.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame || !event.url.startsWith(`${PREVIEW_SCHEME}://`)) event.preventDefault();
  });
  // CSP blocks asset traffic; also prevent document navigation and browser requests
  // from preview frames reaching the network or raw file URLs.
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (details, callback) => {
    callback({ cancel: details.webContentsId === window?.webContents.id });
  });
  window.webContents.session.on('will-download', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.on('close', event => { if (!quitReady) { event.preventDefault(); void shutdown(); } });
  window.webContents.on('render-process-gone', (_event, details) => { log.write(`Renderer gone: ${details.reason}\n`); for (const pending of starting.values()) pending.cancelled = true; for (const sessionId of runs.keys()) void stopRun(sessionId); });
  await window.loadURL('localcode://app/index.html');
}
async function shutdown() {
  if (quitting) return;
  quitting = true;
  const petShutdown = pets.dispose().catch(error => { log.write(`Pet shutdown: ${error.message}\n`); });
  for (const pending of starting.values()) pending.cancelled = true;
  while (starting.size) await new Promise(resolve => setTimeout(resolve, 50));
  try { await Promise.all([...runs.keys()].map(stopRun)); for (const child of workers.values()) child.kill(); await eventQueue; await Promise.all(recovering.values()); await cleanupCommands(); await store.flush(); } catch (error: any) { log.write(`Shutdown: ${error.message}\n`); }
  await petShutdown;
  for (const child of workers.values()) child.kill(); workers.clear(); quitReady = true; app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', event => { if (!quitReady) { event.preventDefault(); void shutdown(); } });
  app.whenReady().then(async () => {
    await store.init(); await cleanupCommands();
    ipcMain.handle('localcode:pet', (event, method, argument) => pets.invoke(event, method, argument));
    ipcMain.handle('localcode:invoke', async (event, method: string, argument: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame?.url.startsWith('localcode://app/')) throw new Error(tr('无效调用来源'));
      if (typeof method !== 'string' || !Object.hasOwn(schemas, method)) throw new Error(tr('无效操作'));
      const parsed = schemas[method].safeParse(argument);
      if (!parsed.success) throw new Error(tr('参数无效：{details}', { details: parsed.error.issues.map(i => tr(i.message)).join('; ') }));
      try { return await invoke(method, parsed.data); }
      catch (error) {
        // Zod's default JSON error includes unlocalized custom messages. Expose
        // only translated issue messages, never validation input or credentials.
        if (error instanceof z.ZodError) throw new Error(error.issues.map(issue => tr(issue.message)).join('\n'));
        throw error;
      }
    });
    await createWindow();
    if (quitting) return;
    try { await pets.init(); }
    catch (error: any) { if (!quitting) log.write(`Pet unavailable (main window remains usable): ${error.message}\n`); }
  }).catch(error => {
    if (quitting) { log.write(`Startup cancelled during shutdown: ${error.message}\n`); return; }
    log.write(`Startup failure: ${error.stack}\n`); dialog.showErrorBox('LocalCode 启动失败', error.message); quitReady = true; app.quit();
  });
}

}
try { initializeApplication(); }
catch {
  // Electron explicitly supports this native dialog before app.ready on Windows:
  // https://www.electronjs.org/docs/latest/api/dialog#dialogshowerrorboxtitle-content
  try { dialog.showErrorBox('LocalCode 无法启动：文件夹不可写', STARTUP_STORAGE_ERROR); }
  catch { console.error(STARTUP_STORAGE_ERROR); }
  finally { app.exit(1); }
}
