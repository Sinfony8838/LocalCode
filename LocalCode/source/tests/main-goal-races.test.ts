import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { transformSync } from 'esbuild';
import * as goals from '../src/core/goals';
import { selectProviderModel } from '../src/shared/providers';

// Execute the actual main-process functions with inert Electron/disk adapters.
// Deferred persistence exposes races that normal, fast disk writes conceal.
const mainSource=fs.readFileSync(path.resolve('src/main/main.ts'),'utf8').replace(/\n}\ntry \{ initializeApplication\(\); }/, '\n(globalThis as any).testMain={invoke,runs,starting,sessionGrants,userRevisions,continuations,scheduleContinuation};\n}\ntry { initializeApplication(); }');
const compiled = transformSync(mainSource,{loader:'ts',format:'cjs',target:'es2022'}).code;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; };
function harness() {
  const session:any = {id:'session',projectId:null,providerId:'cloud',modelId:'model',messages:[],tools:[],status:'completed',workMode:'execute',approvalMode:'auto',goal:{id:'goal',objective:'verify',status:'active',budgetMs:7200000,activeMs:1}};
  const provider = {id:'cloud',kind:'openai',name:'fixture',baseUrl:'http://localhost:1234',model:'model',maxTokens:1024,contextWindow:32768,hasKey:true};
  const state = {session,updateGate:undefined as Promise<void>|undefined,replaceGate:undefined as Promise<void>|undefined,attachmentGate:undefined as Promise<void>|undefined,begins:0};
  class Store {
    settings() {return {locale:'zh-CN'};}
    session() { return session; } sessions() { return [session]; } provider() { return provider; } encryptedKey() { return 'fixture'; }
    async updateGoal(_session:string,id:string,patch:any) { if(session.goal?.id!==id)return false;Object.assign(session.goal,patch);await state.updateGate;return true; }
    async replaceGoal(_session:string,goal:any) {session.goal=goal;await state.replaceGate;}
    async beginRun() {state.begins++;throw new Error('Unexpected worker admission');}
  }
  class Attachments {async resolveForSend(){await state.attachmentGate;return [];}async resolveHistory(){return [];}}
  const noop = () => {};
  const inertClass = class {};
  const modules:Record<string,unknown> = {
    electron:{app:{setPath:noop,setAppLogsPath:noop,requestSingleInstanceLock:()=>false,quit:noop,exit:noop},dialog:{showErrorBox:noop},protocol:{registerSchemesAsPrivileged:noop},safeStorage:{decryptString:()=> 'fixture-secret'}},
    'node:fs':{mkdirSync:noop,createWriteStream:()=>({write:noop,on:noop})},'node:fs/promises':{},'node:path':path,'node:crypto':crypto,
    './startup-storage':{prepareStartupStorage:()=>({dataDir:'D:\\isolated-main-test\\data',cacheDir:'D:\\isolated-main-test\\cache',logsDir:'D:\\isolated-main-test\\logs',logPath:'test.log',logFd:1})},
    './store':{Store},'./attachments':{AttachmentStore:Attachments},'./request-scheduler':{RequestScheduler:inertClass},'./artifacts':{ArtifactController:inertClass},'./pets':{PetController:inertClass},
    '../core/goals':goals,'../shared/providers':{selectProviderModel},'./providers':{providerSchema:{}},'../core/artifacts':{},'../core/workspace':{},'../core/command':{},
    zod,
  };
  const context:any = {require:(name:string)=>modules[name]??{},exports:{},process:{env:{LOCALCODE_HOME:'D:\\isolated-main-test'},platform:'win32'},Buffer,URL,Response,AbortSignal,performance,setTimeout,clearTimeout,setInterval,clearInterval,console,__dirname:'D:\\isolated-main-test'};
  vm.runInNewContext(compiled,context);
  return {...context.testMain,state};
}
import * as zod from 'zod';
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('main-process goal admission races',()=>{
  it('invalidates approval and session grants before awaiting pause persistence',async()=>{
    const h=harness(),gate=deferred();h.state.updateGate=gate.promise;
    const messages:any[]=[];h.state.session.approval={id:'approval',runId:'run',permissionKey:'grant'};
    h.runs.set('session',{sessionId:'session',runId:'run',child:{postMessage:(message:any)=>messages.push(message)}});
    const stop=h.invoke('stop','session');
    expect(h.runs.get('session').cancelRequested).toBe(true);
    await expect(h.invoke('approve',{runId:'run',approvalId:'approval',allow:true,scope:'session'})).rejects.toThrow('失效');
    expect(h.sessionGrants.size).toBe(0);expect(messages.every(message=>message.type==='abort')).toBe(true);
    h.runs.delete('session');gate.resolve();await stop;
  });
  it('does not resume after a stop wins during durable activation',async()=>{
    const h=harness(),gate=deferred();h.state.session.goal.status='paused';h.state.replaceGate=gate.promise;
    const resumed=h.invoke('controlGoal',{sessionId:'session',goalId:'goal',action:'resume'});
    await Promise.resolve();await h.invoke('stop','session');gate.resolve();
    await expect(resumed).rejects.toThrow('恢复已取消');expect(h.state.begins).toBe(0);expect(h.state.session.goal.status).toBe('paused');
  });
  it('preserves a pending continuation when the user adjusts its budget',async()=>{
    vi.useFakeTimers();const h=harness();
    h.scheduleContinuation({sessionId:'session',goalId:'goal',workCalls:1,automatic:true},'completed');
    const revision=h.userRevisions.get('session');
    await h.invoke('controlGoal',{sessionId:'session',goalId:'goal',action:'budget',budgetMs:8000000});
    expect(h.continuations.size).toBe(1);expect(h.userRevisions.get('session')).toBe(revision);
    expect(h.state.session.goal.budgetMs).toBe(8000000);
  });
  it('a stale goal control cannot cancel the current goal continuation',async()=>{
    vi.useFakeTimers();const h=harness();h.scheduleContinuation({sessionId:'session',goalId:'goal',workCalls:1,automatic:true},'completed');
    await expect(h.invoke('controlGoal',{sessionId:'session',goalId:'old',action:'pause'})).rejects.toThrow('失效');
    expect(h.continuations.size).toBe(1);expect(h.state.session.goal.status).toBe('active');
  });
  it('automatic startup cancellation cannot overwrite the user pause with blocked',async()=>{
    vi.useFakeTimers();const h=harness(),gate=deferred();h.state.attachmentGate=gate.promise;
    h.scheduleContinuation({sessionId:'session',goalId:'goal',workCalls:1,automatic:true},'completed');
    await vi.advanceTimersByTimeAsync(150);expect(h.starting.has('session')).toBe(true);
    const stopped=h.invoke('stop','session');gate.resolve();await vi.advanceTimersByTimeAsync(50);await stopped;
    expect(h.state.session.goal.status).toBe('paused');expect(h.state.begins).toBe(0);expect(h.starting.size).toBe(0);
  });
});
