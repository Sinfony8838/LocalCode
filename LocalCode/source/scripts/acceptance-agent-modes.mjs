import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

// Isolated application data and localhost protocol fixtures; no paid model calls.
const root = path.resolve(`../evidence/agent-modes-${Date.now()}`);
const executable = process.argv[2];
const projectPath = path.join(root, 'project'), externalPath = path.join(root, 'external');
await fs.mkdir(path.join(root, 'data'), {recursive:true}); await fs.mkdir(projectPath); await fs.mkdir(externalPath);
await fs.writeFile(path.join(root, 'data/pets.json'),JSON.stringify({version:1,enabled:false}));
await fs.writeFile(path.join(projectPath,'seed.txt'),'fixture seed');
const key = 'agent-modes-fixture-not-real'; const fixture = await providerFixture(key);
const env = {...process.env,LOCALCODE_HOME:root,LOCALCODE_SKIP_OLLAMA_START:'1'}; delete env.ELECTRON_RUN_AS_NODE;
const errors = [], checks = []; let app, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function poll(fn,label,timeout=45000) { const until=Date.now()+timeout; while(Date.now()<until) {const value=await fn();if(value)return value;await sleep(60);}throw new Error(`Timed out: ${label}`); }
const api = (method,arg) => page.evaluate(({method,arg})=>window.localcode[method](arg),{method,arg});
const chat = id => api('openSession',id);
const settle = id => poll(async()=>{const s=await chat(id);if(['failed','interrupted'].includes(s.status))throw new Error(s.error||s.status);return s.status==='completed'&&s;},'settled');
async function launch() {
  app=await electron.launch({executablePath:executable?path.resolve(executable):path.resolve('node_modules/electron/dist/electron.exe'),args:executable?[]:[process.cwd()],env,timeout:60000});
  page=await poll(()=>app.windows().find(p=>/\/index\.html$/.test(p.url())),'main page');
  page.on('pageerror',error=>errors.push(error.stack)); await page.getByLabel('任务输入',{exact:true}).waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>/\/index\.html$/.test(w.webContents.getURL()))?.setContentSize(1280,900));
}
let project, goalSession, approvalSession;
try {
  await launch();
  for(const kind of ['openai','anthropic','responses']) await api('saveProvider',{id:kind,name:kind,kind,baseUrl:fixture.baseUrl,model:'mock',contextWindow:32768,maxTokens:1024,supportsImages:true,apiKey:key});
  await api('saveProvider',{id:'text-only',name:'text-only',kind:'openai',baseUrl:fixture.baseUrl,model:'text',contextWindow:32768,maxTokens:1024,supportsImages:false,apiKey:key});
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},projectPath);
  project=await api('pickProject');
  const png=(await fs.readFile('src/renderer/public/branding/localcode-logo.png')).toString('base64');
  for(const kind of ['openai','anthropic','responses']) {
    const s=await api('createSession',null); const [image]=await api('importAttachments',{draftKey:s.id,files:[{name:'reference.png',data:png}]});
    fixture.queue.push({text:'图片已收到。'}); const before=fixture.requests.length;
    await api('send',{sessionId:s.id,prompt:'',providerId:kind,attachmentIds:[image.id]}); const done=await settle(s.id);
    assert.equal(done.messages[0].attachments[0].id,image.id);
    const body=JSON.stringify(fixture.requests[before].body);
    assert.match(body,kind==='responses'?/input_image/:kind==='anthropic'?/"type":"image"/:/image_url/);
    if(kind==='openai') {
      await assert.rejects(()=>api('send',{sessionId:s.id,prompt:'continue',providerId:'text-only'}),/图片/);
      const imageOk=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();return image.naturalWidth>0;},image.previewUrl);assert(imageOk);
    }
  }
  checks.push('image-only messages reach real pi SDK protocol serializers for OpenAI/Anthropic/Responses; preview protocol loads; switching image history to text-only fails explicitly');

  const planSession=await api('createSession',project.id);
  fixture.queue.push({tool:{name:'ask_question',args:{questions:[{header:'范围',question:'请选择实现范围',options:[{label:'小范围',description:'单个文件'},{label:'较大范围',description:'多个文件'}]}]}}},
    {tool:{name:'propose_plan',args:{text:'1. 读取 seed.txt。\n2. 创建 accepted.txt。\n3. 检查内容。'}}},{text:'计划已准备好，等待开始实施。'});
  const planBefore=fixture.requests.length;
  await api('send',{sessionId:planSession.id,prompt:'先制定计划',providerId:'openai',workMode:'plan',approvalMode:'full'});
  const asked=await poll(async()=>{const s=await chat(planSession.id);return s.question&&s;},'question card');
  const offered=fixture.requests[planBefore].body.tools.map(t=>t.function.name);
  assert(!offered.includes('write_file')&&!offered.includes('edit_file')&&!offered.includes('powershell'));
  const other=await api('createSession',project.id);
  await assert.rejects(()=>api('answerQuestion',{sessionId:other.id,runId:asked.runId,questionId:asked.question.id,answers:[['小范围']]}),/失效/);
  await api('answerQuestion',{sessionId:asked.id,runId:asked.runId,questionId:asked.question.id,answers:[['小范围']]});
  const planned=await settle(asked.id); assert.equal(planned.plan.status,'proposed');
  fixture.queue.push({tool:{name:'write_file',args:{path:'accepted.txt',content:'approved plan'}}},{text:'实施完成。'});
  await api('acceptPlan',{sessionId:planned.id,planId:planned.plan.id,providerId:'openai'}); await settle(planned.id);
  assert.equal(await fs.readFile(path.join(projectPath,'accepted.txt'),'utf8'),'approved plan'); assert.equal((await chat(planned.id)).workMode,'execute');
  checks.push('plan+full cannot advertise write/shell tools; question IDs reject cross-session answers; explicit plan acceptance enables implementation');

  approvalSession=await api('createSession',project.id);
  const command="Write-Output 'approval-ok'";
  fixture.queue.push({tool:{name:'powershell',args:{command}}},{text:'command accepted'});
  await api('send',{sessionId:approvalSession.id,prompt:'需要审批的命令',providerId:'openai',approvalMode:'auto'});
  const waiting=await poll(async()=>{const s=await chat(approvalSession.id);return s.approval&&s;},'command approval');
  await assert.rejects(()=>api('approve',{runId:waiting.runId,approvalId:'wrong',allow:true}),/失效/);
  await api('approve',{runId:waiting.runId,approvalId:waiting.approval.id,allow:true,scope:'session'});await settle(waiting.id);
  fixture.queue.push({tool:{name:'powershell',args:{command}}},{text:'same exact grant reused'});
  await api('send',{sessionId:waiting.id,prompt:'重复同一明确许可',providerId:'openai',approvalMode:'auto'});await settle(waiting.id);
  fixture.queue.push({tool:{name:'powershell',args:{command}}},{text:'rejection respected'});
  await api('send',{sessionId:other.id,prompt:'另一个会话',providerId:'openai',approvalMode:'auto'});
  const otherWait=await poll(async()=>{const s=await chat(other.id);return s.approval&&s;},'separate approval');
  await api('approve',{runId:otherWait.runId,approvalId:otherWait.approval.id,allow:false});await settle(otherWait.id);
  checks.push('exact session approval is reusable, wrong IDs rejected, and grants never cross sessions');

  const ext=await api('createSession',project.id); const file=path.join(externalPath,'outside.txt');
  fixture.queue.push({tool:{name:'write_file',args:{path:file,content:'external approved'}}},{text:'external done'});
  await api('send',{sessionId:ext.id,prompt:'写项目外文件',providerId:'openai',approvalMode:'ask'});
  const extWait=await poll(async()=>{const s=await chat(ext.id);return s.approval&&s;},'external approval');
  assert.equal(extWait.approval.kind,'write'); await assert.rejects(()=>fs.stat(file));
  await api('approve',{runId:extWait.runId,approvalId:extWait.approval.id,allow:true});await settle(ext.id);
  assert.equal(await fs.readFile(file,'utf8'),'external approved');assert((await api('changes',ext.id)).some(c=>c.path===file));
  assert.equal((await api('artifactInfo',{projectId:project.id,path:file})).absolutePath,file);
  assert.equal((await api('readFile',{projectId:project.id,path:file})).content,'external approved');
  await api('undo',{sessionId:ext.id,path:file});await assert.rejects(()=>fs.stat(file));
  checks.push('external writes require explicit approval, record their absolute resource identity and remain undoable');

  const long=await api('createSession',project.id);
  for(let i=0;i<14;i++)fixture.queue.push({tool:{name:'write_file',args:{path:`step-${i}.txt`,content:String(i)}}});fixture.queue.push({text:'14 tools completed'});
  await api('send',{sessionId:long.id,prompt:'超过12次工具调用',providerId:'openai'});const longDone=await settle(long.id);
  assert.equal(longDone.tools.filter(t=>t.name==='write_file'&&t.status==='completed').length,14);
  checks.push('ordinary cloud runs execute more than 12 tools without an artificial turn cap');

  goalSession=await api('createSession',project.id);
  await assert.rejects(()=>api('send',{sessionId:goalSession.id,prompt:'local goal',providerId:'local',goal:{objective:'not allowed',budgetMs:7200000}}),/本地模型不支持/);
  fixture.queue.push({tool:{name:'read_file',args:{path:'seed.txt'}}},{text:'已读取，继续验证。'},
    {tool:{name:'update_goal',args:{status:'complete',reason:'seed.txt 已读取并确认内容为 fixture seed。'}}},{text:'目标已完成。'});
  await api('send',{sessionId:goalSession.id,prompt:'验证目标续跑',providerId:'openai',goal:{objective:'读取并核对 seed.txt 内容',budgetMs:7200000}});
  const complete=await poll(async()=>{const s=await chat(goalSession.id);return s.goal?.status==='complete'&&s.status==='completed'&&s;},'goal completion');
  assert.equal(complete.runs.length,2);assert(complete.messages.some(m=>m.automatic));assert(complete.goal.activeMs>0);
  const blocked=await api('createSession',project.id);
  fixture.queue.push({text:'我将继续。'},{text:'仍然只有说明。'});
  await api('send',{sessionId:blocked.id,prompt:'空转测试',providerId:'openai',goal:{objective:'不能空转',budgetMs:7200000}});
  const stopped=await poll(async()=>{const s=await chat(blocked.id);return s.goal?.status==='blocked'&&s;},'no tool loop stopped');
  assert.equal(stopped.runs.length,2);
  checks.push('local goals rejected; cloud goal continues only after settlement, completes through structured evidence, and stops tool-free continuation');

  const paused=await api('createSession',project.id);
  fixture.queue.push({tool:{name:'powershell',args:{command:"Write-Output 'waiting goal'"}}});
  await api('send',{sessionId:paused.id,prompt:'等待审批期间暂停计时',providerId:'openai',goal:{objective:'等待用户',budgetMs:7200000}});
  const beforePause=await poll(async()=>{const s=await chat(paused.id);return s.approval&&s;},'goal waiting approval');
  await sleep(700); const afterPause=await chat(paused.id);assert(Math.abs(afterPause.goal.activeMs-beforePause.goal.activeMs)<100);
  await api('controlGoal',{sessionId:paused.id,goalId:beforePause.goal.id,action:'pause'});
  await poll(async()=>!['running','awaiting_approval','awaiting_input'].includes((await chat(paused.id)).status),'pause cleanup');
  assert.equal((await chat(paused.id)).goal.status,'paused');
  await page.reload();await page.getByLabel('任务输入',{exact:true}).waitFor();await page.screenshot({path:path.join(root,'desktop.png')});
  await app.close();app=undefined;
  // Move only this isolated fixture's persisted counter near its real 2h limit.
  // Production has no clock override or test-only IPC that can bypass a budget.
  const indexPath=path.join(root,'data/index.json');const persisted=JSON.parse(await fs.readFile(indexPath,'utf8'));
  const timedSession=persisted.sessions.find(s=>s.id===paused.id);timedSession.goal.activeMs=timedSession.goal.budgetMs-2000;timedSession.approvalMode='full';
  await fs.writeFile(indexPath,JSON.stringify(persisted));await launch();
  assert.equal((await chat(paused.id)).goal.status,'paused');assert.equal((await chat(paused.id)).approval,undefined);
  fixture.queue.push({tool:{name:'powershell',args:{command:'Start-Sleep -Seconds 30'}}});
  await api('controlGoal',{sessionId:paused.id,goalId:beforePause.goal.id,action:'resume'});
  const timed=await poll(async()=>{const s=await chat(paused.id);return s.goal?.status==='budget_limited'&&!['running','awaiting_approval','awaiting_input'].includes(s.status)&&s;},'live budget abort',25000);
  assert(timed.goal.activeMs>=timed.goal.budgetMs);assert.notEqual(timed.goal.status,'complete');
  checks.push('a real persisted 2h deadline cancels in-flight work and remains budget_limited through late cleanup');
  fixture.queue.push({tool:{name:'powershell',args:{command}}});
  await api('send',{sessionId:approvalSession.id,prompt:'重启后许可失效',providerId:'openai',approvalMode:'auto'});
  await poll(async()=>(await chat(approvalSession.id)).approval,'restart clears grants');await api('stop',approvalSession.id);
  checks.push('approval wait is excluded from budget, pause cancels work, restart stays paused and clears session grants');
  assert.deepEqual(errors,[]); assert.deepEqual(fixture.errors,[]);
  const result={passed:true,at:new Date().toISOString(),version:(await api('bootstrap')).version,root,checks,requests:fixture.requests.length,realModelCalls:0};
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} catch(error) {
  await fs.writeFile(path.join(root,'failure.txt'),error.stack||String(error));await page?.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});throw error;
} finally {await app?.close().catch(()=>{});fixture.close();}
