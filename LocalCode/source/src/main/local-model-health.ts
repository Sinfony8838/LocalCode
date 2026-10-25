import { z } from 'zod';
import type { LocalModelProbe, ModelHealth } from '../shared/contracts';
import { localOllamaUrl, MANAGED_OLLAMA_URL } from '../shared/providers';

export const localModelProbeSchema = z.object({
  baseUrl: z.string().max(2048), model: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(2048).max(2097152), ollamaMode: z.enum(['managed', 'existing']).optional(),
}).strict().superRefine((value, ctx) => {
  try {
    const url = localOllamaUrl(value.baseUrl);
    if (value.ollamaMode !== 'existing' && url !== MANAGED_OLLAMA_URL) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: '请选择已有 Ollama 并填写有效回环地址（/v1），或使用本套托管地址。' }); }
});
export type ManagedServiceState = 'ready' | 'missing_runtime' | 'stopped' | 'unverified';
const modelName = z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const tagsSchema = z.object({ models: z.array(z.object({ name: modelName })).max(1000) });
const psSchema = z.object({ models: z.array(z.object({ name: modelName, size: z.number().finite().nonnegative().optional(), size_vram: z.number().finite().nonnegative().optional() })).max(1000) });
const versionSchema = z.object({ version: z.string().min(1).max(80).regex(/^[\w.+-]+$/) });

async function readJson(url: string, signal: AbortSignal, request: typeof fetch): Promise<unknown> {
  const response = await request(url, { method: 'GET', signal, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('invalid_response'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error('invalid_response');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid_response'); }
}
const sameModel = (a: string, b: string) => (a.includes(':') ? a : a + ':latest') === (b.includes(':') ? b : b + ':latest');

/** Read-only inspection: never starts a service, pulls a model or generates tokens. */
export async function inspectLocalModel(input: LocalModelProbe, options: {
  managedState: () => Promise<ManagedServiceState>; request?: typeof fetch;
}): Promise<ModelHealth> {
  const base: ModelHealth = { online: false, modelAvailable: false, model: input.model, contextWindow: input.contextWindow, installedModels: [] };
  if (!localModelProbeSchema.safeParse(input).success) return { ...base, status: 'invalid_config', message: '本地配置无效。仅允许本机回环地址，路径为 /v1；其他服务请配置自定义 API。' };
  const origin = new URL(localOllamaUrl(input.baseUrl)).origin;
  if (input.ollamaMode !== 'existing') {
    let state: ManagedServiceState;
    try { state = await options.managedState(); } catch { state = 'unverified'; }
    if (state !== 'ready') return { ...base, status: state === 'missing_runtime' ? 'missing_runtime' : state === 'stopped' ? 'offline' : 'unverified_service', message:
      state === 'missing_runtime' ? '尚未安装本套 Ollama。便携版运行 Install-LocalModel.cmd；源码版运行 Setup.cmd。已有 Ollama 可在下方显式选择；仅用云端 API 无需安装本地模型。' :
      state === 'stopped' ? '本套 Ollama 尚未启动。点击“启动本套 Ollama”或运行 Ollama/Start.cmd，然后刷新；仅用云端 API 不受影响。' :
      '无法确认本套 Ollama 的进程和端口归属，未连接此服务。如需使用自己安装的 Ollama，请显式选择“已有 Ollama”；不会自动复用或停止其他服务。' };
  }
  const signal = AbortSignal.timeout(4000);
  const request = options.request ?? fetch;
  let models: string[];
  try {
    const data = tagsSchema.safeParse(await readJson(origin + '/api/tags', signal, request));
    if (!data.success) throw new Error('invalid_response');
    models = [...new Set(data.data.models.map(model => model.name))].sort();
  } catch (error) {
    const invalid = error instanceof Error && error.message === 'invalid_response';
    return { ...base, status: invalid ? 'invalid_response' : 'offline', message: invalid ? '服务未返回有效 Ollama 模型列表。请核对端口是否为 Ollama；响应已限制大小，未加载模型。' : 'Ollama 无法连接或检查超过 4 秒。请确认服务已启动、地址和端口正确，再刷新。云端 API 无需本地服务。' };
  }
  // Optional runtime metrics must not make an installed model appear offline.
  const [version, ps] = await Promise.all([
    readJson(origin + '/api/version', signal, request).then(data => versionSchema.safeParse(data)).catch(() => undefined),
    readJson(origin + '/api/ps', signal, request).then(data => psSchema.safeParse(data)).catch(() => undefined),
  ]);
  const loaded = ps?.success ? ps.data.models.find(model => sameModel(model.name, input.model)) : undefined;
  const gpuPercent = loaded?.size && loaded.size_vram !== undefined ? Math.min(100, Math.round(loaded.size_vram / loaded.size * 100)) : undefined;
  const found = models.some(name => sameModel(name, input.model));
  return { ...base, online: true, modelAvailable: found, installedModels: models, status: found ? 'ready' : 'missing_model', version: version?.success ? version.data.version : undefined, gpuPercent,
    message: !found ? 'Ollama 已连接，但所选模型尚未安装。请选择下方已安装模型，或自行安装所需模型后刷新。保存和检查均不会下载模型。' :
      gpuPercent === 0 ? '模型已安装，当前以 CPU 运行，响应可能较慢。可尝试更小模型或更低上下文；本检查不验证工具调用能力。' : '所选模型已安装。本检查仅读取服务信息，不加载模型；实际性能和工具调用需在任务中验证。' };
}
