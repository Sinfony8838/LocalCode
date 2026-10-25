import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, screen, shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store';
import { prepareStartupStorage, STARTUP_STORAGE_ERROR, LOG_STORAGE_ERROR } from './startup-storage';
import { RequestScheduler } from './request-scheduler';
import { AttachmentStore } from './attachments';
import { GoalClock, canContinueGoal, continuationPrompt, DEFAULT_GOAL_BUDGET_MS, WORK_TOOLS } from '../core/goals';
import { ArtifactController } from './artifacts';
import { PREVIEW_SCHEME, resolveArtifactPath, externalBrowserUrl } from '../core/artifacts';
import { createHash, randomUUID } from 'node:crypto';
import { inspectLocalModel, localModelProbeSchema } from './local-model-health';
import { managedOllamaState, startManagedOllama } from './managed-ollama';
import { providerSchema, testConnection } from './providers';
import { selectProviderModel } from '../shared/providers';
import { translate } from '../shared/i18n';
import { PetController } from './pets';
import { listWorkspaceFiles, readWorkspaceFile, getChanges, undoChange, previewChangeCheckpoint, checkpointChange } from '../core/workspace';
import { cleanupOwnedCommands } from '../core/command';
import type { AgentEvent, AppEvent, ModelHealth, ProviderSecret, WorkerCommand, TransportMessage, TransportGrant, SendInput, GoalState, WorkMode } from '../shared/contracts';

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
  { scheme: 'localcode-attachment', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const store = new Store(dataDir);
const tr = (source: string, values?: Record<string, string | number>) => translate(store.settings().locale, source, values);
const artifacts = new ArtifactController();
let window: BrowserWindow | undefined;
const pets = new PetController(home, __dirname, () => window, () => { window?.restore(); window?.show(); window?.focus(); }, () => store.settings().locale);
const attachments = new AttachmentStore(dataDir);
type ActiveRun = { runId: string; sessionId: string; apiKey?: string; child: UtilityProcess; requestGroup: string; goalId?: string; clock?: GoalClock; workMode?: WorkMode; automatic?: boolean; cancelRequested?: boolean; workCalls: number; goalResult?: {status: 'complete' | 'blocked' | 'paused'; reason: string} };
const requestScheduler = new RequestScheduler();
const runs = new Map<string, ActiveRun>();
const workers = new Map<string, UtilityProcess>();
const starting = new Map<string, { cancelled: boolean; automatic?: boolean }>();
const sessionGrants = new Map<string, Set<string>>();
const userRevisions = new Map<string, number>();
const continuations = new Map<string, ReturnType<typeof setTimeout>>();
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
let visionCache: {key: string; at: number; value: boolean} | undefined;
let visionRequest: {key: string; result: Promise<boolean>} | undefined;
async function localVision(): Promise<boolean> {
  const local=store.provider('local'); const key=JSON.stringify([local.baseUrl,local.model,local.ollamaMode]);
  if (visionCache?.key === key && Date.now() - visionCache.at < 30000) return visionCache.value;
  if (visionRequest?.key === key) return visionRequest.result;
  const result=(async () => {
    let value = false;
    try { const base=localModelProbeSchema.parse({baseUrl:local.baseUrl,model:local.model,contextWindow:local.contextWindow,ollamaMode:local.ollamaMode}); const endpoint=new URL(base.baseUrl);endpoint.pathname='/api/show';const response = await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:local.model}),signal:AbortSignal.timeout(4000)}); value = response.ok && (await response.json()).capabilities?.includes('vision') === true; } catch { /* Capability discovery never invokes a model. */ }
    visionCache = {key,at:Date.now(),value}; return value;
  })().finally(() => { if (visionRequest?.key===key) visionRequest=undefined; });
  visionRequest={key,result};return result;
}

async function health(): Promise<ModelHealth> {
  const local = store.provider('local');
  return inspectLocalModel({ baseUrl: local.baseUrl, model: local.model, contextWindow: local.contextWindow, ollamaMode: local.ollamaMode }, { managedState: () => managedOllamaState(home) });
}
function cancelContinuation(sessionId: string) {
  clearTimeout(continuations.get(sessionId)); continuations.delete(sessionId);
  userRevisions.set(sessionId, (userRevisions.get(sessionId) ?? 0) + 1);
}
/** Invalidate approvals synchronously, before any durable-state await. */
function markCancelling(sessionId: string) {
  const pending = starting.get(sessionId); if (pending) pending.cancelled = true;
  const active = runs.get(sessionId);
  if (!active || active.cancelRequested) return;
  active.cancelRequested = true; active.clock?.setActive(false);
  try { post(active,{type:'abort',runId:active.runId}); } catch { /* Worker exit recovery owns cleanup. */ }
}
async function accountGoal(active: ActiveRun, stop = false) {
  if (!active.goalId || !active.clock) return;
  const used = stop ? active.clock.stop() : active.clock.used();
  const goal = store.session(active.sessionId).goal;
  if (goal?.id === active.goalId) await store.updateGoal(active.sessionId, goal.id, { activeMs: Math.max(goal.activeMs, used) });
}
async function expireGoal(sessionId: string, goalId: string, runId: string) {
  const active = runs.get(sessionId); const goal = store.session(sessionId).goal;
  if (!active || active.runId !== runId || active.goalId !== goalId || goal?.id !== goalId || goal.status !== 'active') return;
  cancelContinuation(sessionId);
  markCancelling(sessionId);
  // Commit the terminal budget state before sending abort, so late completion cannot win.
  await store.updateGoal(sessionId, goalId, { status: 'budget_limited', activeMs: Math.max(goal.budgetMs, active.clock?.used() ?? goal.activeMs), reason: '已达到目标运行时间预算。' });
  emit({ type: 'state_changed' }); await stopRun(sessionId);
}
function scheduleContinuation(active: ActiveRun, status: string) {
  if (active.cancelRequested) return;
  const session = store.session(active.sessionId);
  if (!canContinueGoal({ goal: session.goal, goalId: active.goalId, mode: session.workMode, automatic: !!active.automatic, workCalls: active.workCalls, status })) return;
  const revision = userRevisions.get(session.id) ?? 0; const goalId = session.goal!.id;
  const timer = setTimeout(() => {
    continuations.delete(session.id);
    if (quitting || (userRevisions.get(session.id) ?? 0) !== revision) return;
    const current = store.session(session.id); const goal = current.goal;
    if (!goal || goal.id !== goalId || goal.status !== 'active' || current.workMode === 'plan' || current.question || current.approval || runs.has(session.id) || starting.has(session.id)) return;
    void startRun({ sessionId: current.id, prompt: continuationPrompt(goal), providerId: current.providerId, modelId: current.modelId,
      approvalMode: current.approvalMode, workMode: 'execute' }, { goalId, revision }).catch(async error => {
      const latest = store.session(current.id).goal;
      if (latest?.id === goalId && latest.status === 'active' && (userRevisions.get(current.id) ?? 0) === revision) await store.updateGoal(current.id, goalId, { status: 'blocked', reason: (error as Error).message });
      emit({ type: 'state_changed' });
    });
  }, 150);
  continuations.set(session.id, timer);
}
async function startRun(arg: SendInput, automatic?: {goalId: string; revision: number}) {
  if (changingFiles) throw new Error(tr('正在保存文件修改记录，请稍后再开始任务。'));
  const locale=store.settings().locale;
  if (!automatic) {
    cancelContinuation(arg.sessionId);
    const pending = starting.get(arg.sessionId);
    if (pending?.automatic) { pending.cancelled = true; while (starting.get(arg.sessionId) === pending) await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  if (quitting || runs.has(arg.sessionId) || starting.has(arg.sessionId)) throw new Error('此会话已有任务运行中，请先停止或等待完成。');
  // Atomic admission: no await between checking and reserving the per-session start slot.
  const startup = { cancelled: false, automatic: !!automatic }; starting.set(arg.sessionId, startup);
  let active: ActiveRun | undefined; let begun: {id: string; runId?: string} | undefined;
  try {
    await recovering.get(arg.sessionId); await eventQueue;
    const current = store.session(arg.sessionId);
    const mode = arg.workMode ?? current.workMode ?? 'execute';
    const check = () => {
      if (quitting || startup.cancelled) throw new Error('启动已取消。');
      if (automatic && ((userRevisions.get(arg.sessionId) ?? 0) !== automatic.revision || current.goal?.id !== automatic.goalId || current.goal.status !== 'active' || current.workMode === 'plan')) throw new Error('自动续跑已取消。');
    };
    check();
    const provider = selectProviderModel(store.provider(arg.providerId), arg.modelId);
    if (provider.kind === 'ollama') {
      if (arg.goal || automatic) throw new Error('本地模型不支持目标模式，请选择云端模型。');
      if (current.goal?.status === 'active') await store.updateGoal(current.id, current.goal.id, { status: 'paused', reason: '已切换到本地模型。' });
      const h = await health(); if (!h.online || !h.modelAvailable) throw new Error(h.message || '本地模型不可用');
    }
    const cipher = store.encryptedKey(provider.id);
    const secret: ProviderSecret = { ...provider, apiKey: provider.kind === 'ollama' ? 'ollama' : cipher ? safeStorage.decryptString(Buffer.from(cipher, 'base64')) : '' };
    if (provider.kind !== 'ollama' && !secret.apiKey) throw new Error('请先在设置中保存此 API 的密钥。');
    const fresh = await attachments.resolveForSend(arg.draftKey ?? arg.sessionId, arg.attachmentIds ?? [], arg.sessionId);
    const historyIds = [...new Set(current.messages.flatMap(message => message.attachments?.map(item => item.id) ?? []))];
    const history = await attachments.resolveHistory(arg.sessionId, historyIds);
    const availableIds = new Set(history.map(item=>item.id));
    const unavailableFolders = current.messages.flatMap(message=>message.attachments??[]).filter(item=>item.kind==='folder'&&!availableIds.has(item.id));
    const resources = [...new Map([...history, ...fresh].map(item => [item.id, item])).values()];
    if (resources.some(item => item.kind === 'image')) {
      if (provider.kind === 'ollama') secret.supportsImages = await localVision();
      if (!secret.supportsImages) throw new Error('当前模型未声明支持图片。请在模型设置开启图片输入，或切换支持视觉的模型。');
    }
    if (!arg.prompt.trim() && !fresh.length && !arg.goal) throw new Error('请输入内容或添加附件。');
    check();
    if (arg.goal) {
      if (current.goal && !['complete'].includes(current.goal.status)) throw new Error('当前会话已有目标，请先清除或完成后创建新目标。');
      await store.replaceGoal(current.id, { id: randomUUID(), objective: arg.goal.objective, budgetMs: arg.goal.budgetMs ?? DEFAULT_GOAL_BUDGET_MS,
        activeMs: 0, status: 'active', updatedAt: new Date().toISOString() });
    }
    check();
    const prompt = arg.prompt.trim() || (arg.goal ? arg.goal.objective : '请根据附件内容帮助我。');
    const publicAttachments = fresh.map(({storagePath: _privatePath, ...metadata}) => metadata);
    const session = await store.beginRun(arg.sessionId, prompt, arg.providerId, provider.model, { attachments: publicAttachments, approvalMode: arg.approvalMode, workMode: mode, automatic: !!automatic });
    begun = session; check();
    const child = createWorker(session.id, provider.kind !== 'ollama' ? secret.apiKey : undefined);
    const goal = session.goal?.status === 'active' && provider.kind !== 'ollama' ? session.goal : undefined;
    active = { runId: session.runId!, sessionId: session.id, apiKey: provider.kind !== 'ollama' ? secret.apiKey : undefined, child,
      requestGroup: new URL(provider.baseUrl).origin + ':' + createHash('sha256').update(secret.apiKey).digest('hex'), goalId: goal?.id,
      workMode: mode, automatic: !!automatic, workCalls: 0 };
    runs.set(session.id, active);
    if (unavailableFolders.length) emit({type:'notice',runId:active.runId,sessionId:session.id,message:`历史文件夹暂不可用，已跳过其读取权限：${[...new Set(unavailableFolders.map(item=>item.name))].join('、')}。需要使用时请重新添加。`});
    if (goal && mode !== 'plan') {
      active.clock = new GoalClock(goal.budgetMs, goal.activeMs, () => { void expireGoal(session.id, goal.id, session.runId!).catch(error => log.write(`Goal expiry: ${error.message}\n`)); });
      active.clock.setActive(true);
    }
    check();
    post(active, { type: 'run', runId: session.runId!, sessionId: session.id, projectPath: session.projectId ? store.project(session.projectId).path : '', dataDir,
      piFile: session.piFile, provider: secret, prompt, locale, approvalMode: session.approvalMode, workMode: mode, grants: [...(sessionGrants.get(session.id) ?? [])],
      attachments: resources, newAttachmentIds: fresh.map(item => item.id), goal: goal ? {id: goal.id, objective: goal.objective} : undefined, automatic: !!automatic });
    emit({ type: 'state_changed' }); return {runId: session.runId!};
  } catch (error) {
    if (active) await processEvent({type:'settled',runId:active.runId,sessionId:active.sessionId,status:quitting||startup.cancelled?'interrupted':'failed',error:(error as Error).message});
    else if (begun?.runId) emit(await store.event({type:'settled',runId:begun.runId,sessionId:begun.id,status:'failed',error:(error as Error).message}) ?? {type:'state_changed'});
    throw error;
  } finally { starting.delete(arg.sessionId); }
}
async function processEvent(raw: AgentEvent) {
  const active = runs.get(raw.sessionId);
  if (!active || raw.runId !== active.runId || raw.sessionId !== active.sessionId) return;
  let event = raw;
  if (active.apiKey && active.apiKey.length >= 6) event = JSON.parse(JSON.stringify(raw).split(active.apiKey).join('[密钥已隐藏]'));
  if (event.type === 'tool_start' && WORK_TOOLS.has(event.name)) active.workCalls++;
  if (event.type === 'goal_update') {
    if (event.goalId !== active.goalId || store.session(event.sessionId).goal?.id !== event.goalId) return;
    active.goalResult = {status:event.status,reason:event.reason};
  }
  if (event.type === 'approval' || event.type === 'question' || event.type === 'progress' && ['queued', 'retry'].includes(event.progress.phase)) active.clock?.setActive(false);
  else if (!active.cancelRequested && (event.type === 'approval_resolved' || event.type === 'question_resolved' || event.type === 'tool_start' || event.type === 'progress' && !['queued', 'retry'].includes(event.progress.phase))) active.clock?.setActive(true);
  if (['approval', 'question', 'status', 'approval_resolved', 'question_resolved', 'settled'].includes(event.type)) await accountGoal(active, event.type === 'settled');
  // The worker emits settled only after inference, approvals and commands are cleaned up.
  // Keep the run locked until the final disk snapshot and durable summary settle.
  // Otherwise an undo from another idle session can race the final file scan.
  event = await store.event(event) ?? event;
  if (event.type === 'settled') {
    requestScheduler.cancel(active.runId); runs.delete(event.sessionId);
    const goal = store.session(active.sessionId).goal;
    if (goal && goal.id === active.goalId && goal.status === 'active') {
      if (active.cancelRequested) await store.updateGoal(active.sessionId,goal.id,{status:'paused',reason:'运行已由用户停止。'});
      else if (active.goalResult && event.status === 'completed') await store.updateGoal(active.sessionId, goal.id, active.goalResult);
      else if (event.status !== 'completed') await store.updateGoal(active.sessionId, goal.id, {status:event.status === 'interrupted' ? 'paused' : 'blocked',reason:event.error || '运行已停止。'});
      else if (active.automatic && !active.workCalls && active.workMode !== 'plan') await store.updateGoal(active.sessionId, goal.id, {status:'blocked',reason:'本轮没有可验证的工具进展，等待你继续或补充信息。'});
    }
  }
  if (['status', 'settled', 'approval', 'approval_resolved'].includes(event.type)) {
    const sessions = store.sessions();
    const other = sessions.find(session => session.status === 'awaiting_approval') || sessions.find(session => session.status === 'running');
    pets.onAgentEvent(other ? { type: 'status', runId: other.runId!, sessionId: other.id, status: other.status } : event);
  }
  emit(event);
  // Each worker owns exactly one run, including its commands and credentials.
  if (event.type === 'settled') { active.child.kill(); emit({type:'state_changed'}); scheduleContinuation(active, event.status); }
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
      run.clock?.setActive(false);
      requestScheduler.acquire(run.requestGroup, run.runId, event.requestId, () => {
        if (runs.get(sessionId) === run && !run.cancelRequested) { run.clock?.setActive(true); child.postMessage({ type: 'request_grant', runId: run.runId, requestId: event.requestId } satisfies TransportGrant); }
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
  markCancelling(sessionId);
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
  bootstrap: z.undefined(), pickProject: z.undefined(), createSession: id.nullish(), openSession: id,
  moveSession: z.object({ sessionId: id, projectId: id }).strict(),
  setProjectPinned: z.object({ projectId: id, pinned: z.boolean() }).strict(),
  setSidebar: z.object({ pinnedCollapsed: z.boolean(), projectsCollapsed: z.boolean(), recentCollapsed: z.boolean(), collapsedProjects: z.array(id).max(1000) }).partial().strict(),
  renameSession: z.object({ sessionId: id, title: z.string().trim().min(1).max(100) }).strict(),
  send: z.object({ sessionId: id, prompt: z.string().trim().max(30000), providerId, modelId: z.string().min(1).max(200).optional(), draftKey: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/).optional(),
    attachmentIds: z.array(id).max(10).optional(), approvalMode: z.enum(['ask','auto','full']).optional(), workMode: z.enum(['execute','plan']).optional(),
    goal: z.object({objective:z.string().trim().min(1).max(10000),budgetMs:z.number().int().min(900000).max(86400000)}).strict().optional() }).strict(), stop: id,
  approve: z.object({ runId: id, approvalId: z.string().min(1).max(200), allow: z.boolean(), scope: z.enum(['once','session']).optional() }).strict(),
  pickAttachments: z.object({draftKey:z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),folders:z.boolean().optional()}).strict(),
  importAttachments: z.object({draftKey:z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),files:z.array(z.object({name:z.string().min(1).max(250),data:z.string().max(14*1024*1024)}).strict()).min(1).max(10)}).strict(),
  answerQuestion: z.object({sessionId:id,runId:id,questionId:z.string().min(1).max(200),answers:z.array(z.array(z.string().max(4000)).max(20)).max(3).nullable()}).strict(),
  acceptPlan: z.object({sessionId:id,planId:z.string().min(1).max(200),providerId,modelId:z.string().min(1).max(200).optional()}).strict(),
  controlGoal: z.object({sessionId:id,goalId:id,action:z.enum(['pause','resume','clear','budget']),budgetMs:z.number().int().min(900000).max(86400000).optional(),providerId:providerId.optional(),modelId:z.string().min(1).max(200).optional()}).strict(),
  listFiles: z.object({ projectId: id, directory: z.string().max(2048).optional() }).strict(), readFile: z.object({ projectId: id, path: relPath }).strict(),
  artifactInfo: z.object({ projectId: id, path: z.string().min(1).max(4096), inputKind: z.enum(['path', 'reference']).optional() }).strict(),
  artifactAction: z.object({ projectId: id, path: z.string().min(1).max(4096), action: z.enum(['open', 'choose-app', 'reveal', 'copy-path']), inputKind: z.enum(['path', 'reference']).optional() }).strict(),
  openExternal: z.string().min(1).max(4096),
  copyText: z.string().max(2 * 1024 * 1024),
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
/** Explicit UI file actions may open an external file only if this project's
 * journal already records that exact resource. This does not grant tool access. */
async function artifactTarget(projectId: string, input: string, inputKind: 'path' | 'reference' = 'path') {
  const root = store.project(projectId).path;
  try { const target = await resolveArtifactPath(root,input,inputKind); return {root,relative:target.relative,display:target.relative}; }
  catch (original) {
    if (!path.isAbsolute(input) || /[\0\r\n]/.test(input)) throw original;
    const absolute = path.resolve(input);
    for (const session of store.sessions().filter(s=>s.projectId===projectId)) {
      const changes = await getChanges(dataDir,session.id);
      if (changes.some(change=>path.isAbsolute(change.path)&&path.resolve(change.path)===absolute)) {
        const externalRoot = path.dirname(absolute); const relative = path.basename(absolute);
        await resolveArtifactPath(externalRoot,relative);
        return {root:externalRoot,relative,display:absolute};
      }
    }
    throw original;
  }
}
async function invoke(method: string, arg: any) {
  switch (method) {
    case 'bootstrap': { const [currentHealth,vision] = await Promise.all([health(),localVision()]); await eventQueue; const settings = store.settings(); const local = settings.providers.find(p => p.kind === 'ollama'); if (local) local.supportsImages = vision; return { projects: store.projects(), sessions: store.sessions(), settings, health: currentHealth, version: app.getVersion() }; }
    case 'pickProject': { const choice = await dialog.showOpenDialog(window!, { title: tr('选择编程项目'), properties: ['openDirectory'] }); if (choice.canceled || !choice.filePaths[0]) return null; const p = await store.addProject(choice.filePaths[0]); emit({ type: 'state_changed' }); return p; }
    case 'createSession': return store.createSession(arg);
    case 'moveSession': {
      if (runs.has(arg.sessionId) || starting.has(arg.sessionId) || recovering.has(arg.sessionId)) throw new Error('请等待任务结束后再移入项目。');
      const moved = await store.moveSession(arg.sessionId, arg.projectId); emit({ type: 'state_changed' }); return moved;
    }
    case 'setProjectPinned': { const project = await store.setProjectPinned(arg.projectId, arg.pinned); emit({ type: 'state_changed' }); return project; }
    case 'setSidebar': { const sidebar = await store.setSidebar(arg); emit({ type: 'state_changed' }); return sidebar; }
    case 'openSession': await eventQueue; return structuredClone(store.session(arg));
    case 'renameSession': return store.renameSession(arg.sessionId, arg.title);
    case 'copyText': await clipboard.writeText(arg); return;
    case 'send': return startRun(arg);
    case 'stop': {
      cancelContinuation(arg); markCancelling(arg); const goal = store.session(arg).goal;
      if (goal?.status === 'active') await store.updateGoal(arg, goal.id, {status:'paused',reason:'已由用户停止。'});
      await stopRun(arg); emit({type:'state_changed'}); return;
    }
    case 'approve': {
      const active = [...runs.values()].find(run => run.runId === arg.runId);
      if (!active || active.cancelRequested || stopping.has(active.runId)) throw new Error('审批已失效，操作未执行。');
      const approval = store.session(active.sessionId).approval;
      if (!approval || approval.id !== arg.approvalId || approval.runId !== arg.runId) throw new Error('审批不匹配或已失效。');
      if (arg.allow && arg.scope === 'session' && approval.permissionKey) {
        const grants = sessionGrants.get(active.sessionId) ?? new Set<string>(); grants.add(approval.permissionKey); sessionGrants.set(active.sessionId, grants);
      }
      post(active, { type:'approve', ...arg }); return;
    }
    case 'pickAttachments': {
      const choice = await dialog.showOpenDialog(window!, {title:arg.folders?'添加只读文件夹上下文':'添加图片或文本文件',properties:arg.folders?['openDirectory','multiSelections']:['openFile','multiSelections']});
      if (choice.canceled) return []; return attachments.importPaths(arg.draftKey,choice.filePaths,!!arg.folders);
    }
    case 'importAttachments': return attachments.importBytes(arg.draftKey,arg.files);
    case 'answerQuestion': {
      const active = runs.get(arg.sessionId); const question = store.session(arg.sessionId).question;
      if (!active || active.cancelRequested || !question || active.runId !== arg.runId || question.id !== arg.questionId || question.runId !== arg.runId) throw new Error('问题已失效。');
      if (arg.answers && (arg.answers.length !== question.questions.length || arg.answers.some((answers:string[],index:number) => !answers.length || (!question.questions[index].multiple && answers.length !== 1)))) throw new Error('请回答每个问题。');
      post(active,{type:'answer',runId:arg.runId,questionId:arg.questionId,answers:arg.answers}); return;
    }
    case 'acceptPlan': {
      if (runs.has(arg.sessionId) || starting.has(arg.sessionId)) throw new Error('请等待当前计划轮结束。');
      const session = store.session(arg.sessionId); const plan = session.plan;
      if (!plan || plan.id !== arg.planId || plan.status !== 'proposed') throw new Error('计划已失效。');
      const result = await startRun({sessionId:arg.sessionId,prompt:`请实施以下已确认的计划：\n${plan.text}`,providerId:arg.providerId,modelId:arg.modelId,workMode:'execute',approvalMode:session.approvalMode});
      await store.acceptPlan(arg.sessionId,arg.planId); emit({type:'state_changed'}); return result;
    }
    case 'controlGoal': {
      const session = store.session(arg.sessionId); const goal = session.goal;
      if (!goal || goal.id !== arg.goalId) throw new Error('目标已失效。');
      if (arg.action !== 'budget') cancelContinuation(arg.sessionId);
      if (arg.action === 'pause' || arg.action === 'clear') {
        markCancelling(session.id);
        if (goal.status === 'active') await store.updateGoal(session.id,goal.id,{status:'paused',reason:'已由用户暂停。'});
        await stopRun(session.id);
        if (arg.action === 'clear' && store.session(session.id).goal?.id === goal.id) await store.replaceGoal(session.id);
      } else if (arg.action === 'budget') {
        if (!arg.budgetMs) throw new Error('请设置目标时间预算。');
        const active = runs.get(session.id); if (active) await accountGoal(active);
        const current = store.session(session.id).goal!;
        await store.replaceGoal(session.id,{...current,budgetMs:arg.budgetMs,status:current.status === 'budget_limited' && arg.budgetMs > current.activeMs?'paused':!active && current.activeMs >= arg.budgetMs?'budget_limited':current.status,updatedAt:new Date().toISOString()});
        active?.clock?.setBudget(arg.budgetMs);
      } else {
        const selected = selectProviderModel(store.provider(arg.providerId ?? session.providerId),arg.modelId ?? session.modelId);
        if (selected.kind === 'ollama') throw new Error('本地模型不支持目标模式。');
        if (runs.has(session.id) || starting.has(session.id)) throw new Error('请等待当前运行结束。');
        if (goal.status === 'complete') throw new Error('已完成目标不能恢复，请创建新目标。');
        if (goal.activeMs >= goal.budgetMs) throw new Error('预算已用完，请先增加预算。');
        const resumeRevision = userRevisions.get(session.id) ?? 0;
        // Explicit user resume may reopen a budget-limited state after an increase.
        await store.replaceGoal(session.id,{...goal,status:'active',reason:undefined,updatedAt:new Date().toISOString()});
        const latest = store.session(session.id).goal;
        if (quitting || (userRevisions.get(session.id) ?? 0) !== resumeRevision || latest?.id !== goal.id || latest.status !== 'active') throw new Error('目标恢复已取消。');
        try { await startRun({sessionId:session.id,prompt:continuationPrompt(goal),providerId:selected.id,modelId:selected.model,workMode:session.workMode,approvalMode:session.approvalMode}); }
        catch (error) { const current = store.session(session.id).goal; if (current?.id === goal.id && current.status === 'active' && (userRevisions.get(session.id) ?? 0) === resumeRevision + 1) await store.updateGoal(session.id,goal.id,{status:'blocked',reason:(error as Error).message}); throw error; }
      }
      emit({type:'state_changed'}); return;
    }
    case 'listFiles': return listWorkspaceFiles(store.project(arg.projectId).path, arg.directory || '');
    case 'readFile': { const target=await artifactTarget(arg.projectId,arg.path);return {...await readWorkspaceFile(target.root,target.relative),path:target.display}; }
    case 'artifactInfo': {
      const target=await artifactTarget(arg.projectId,arg.path,arg.inputKind); const info=await artifacts.info(target.root,target.relative);
      // An external write authorizes this UTF-8 file, not adjacent HTML assets.
      return {...info,path:target.display,...(path.isAbsolute(target.display)?{kind:'text',previewUrl:undefined}:{})};
    }
    case 'artifactAction': { const target=await artifactTarget(arg.projectId,arg.path,arg.inputKind);return artifacts.action(target.root,target.relative,arg.action); }
    case 'openExternal': await shell.openExternal(externalBrowserUrl(arg)); return;
    case 'changes': return store.session(arg).projectId ? getChanges(dataDir, arg) : [];
    case 'previewCheckpoint': assertChangesIdle(); if (!store.session(arg.sessionId).projectId) throw new Error('此任务未指定工作区，没有可操作的项目文件。'); return previewChangeCheckpoint(dataDir, arg.sessionId, arg.path);
    case 'undo':
    case 'checkpoint': {
      assertChangesIdle(); if (!store.session(arg.sessionId).projectId) throw new Error('此任务未指定工作区，没有可操作的项目文件。');
      // Reserve synchronously, before any await, so a new send cannot race this operation.
      changingFiles = true;
      try {
        if (method === 'undo') await undoChange(dataDir, arg.sessionId, arg.path);
        else await checkpointChange(dataDir, arg.sessionId, arg.path, arg.expectedHash, arg.expectedRecordHash);
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
  protocol.handle('localcode-attachment', request => attachments.response(request));
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
      return new Response(await fs.readFile(filename), { headers: { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: localcode-preview: localcode-attachment:; font-src 'self'; connect-src 'self'; frame-src localcode-preview:; object-src 'none'; base-uri 'none'" } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(1200, Math.floor(workArea.width * .9));
  const height = Math.min(800, Math.floor(workArea.height * .9));
  window = new BrowserWindow({ width, height, x: workArea.x + Math.floor((workArea.width - width) / 2), y: workArea.y + Math.floor((workArea.height - height) / 2), minWidth: Math.min(960, width), minHeight: Math.min(700, height), fullscreen: false, title: 'LocalCode', icon: path.join(__dirname, 'renderer/branding/localcode.ico'), backgroundColor: '#ffffff', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(({ url, referrer }) => { if (referrer.url.startsWith('localcode://app/') && /^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
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
  for (const sessionId of runs.keys()) markCancelling(sessionId);
  for (const timer of continuations.values()) clearTimeout(timer); continuations.clear();
  for (const session of store.sessions()) if (session.goal?.status === 'active') await store.updateGoal(session.id,session.goal.id,{status:'paused',reason:'应用已退出，目标已暂停。'});
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
    await store.init(); await attachments.init(); await cleanupCommands();
    const goalCheckpoint = setInterval(() => { if (!quitting) for (const active of runs.values()) void accountGoal(active).catch(error => log.write(`Goal accounting: ${error.message}\n`)); }, 15000);
    goalCheckpoint.unref();
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
