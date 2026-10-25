import { z } from 'zod';
import { localOllamaUrl, MANAGED_OLLAMA_URL } from '../shared/providers';
import type { ProviderSecret } from '../shared/contracts';

const modelSchema = z.object({ id: z.string().trim().min(1).max(200), contextWindow: z.number().int().min(2048).max(2097152), maxTokens: z.number().int().min(128).max(131072), enabled: z.boolean(), supportsImages: z.boolean().optional() }).strict()
  .refine(v => v.maxTokens + 1536 < v.contextWindow, '上下文需留出至少 1536 tokens 供压缩和输入使用');
export const providerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().trim().min(1).max(80), kind: z.enum(['ollama', 'openai', 'anthropic', 'responses']),
  baseUrl: z.string().url().refine(value => {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  }, 'Base URL 仅支持不含凭证、查询参数的 HTTP/HTTPS 地址'),
  model: z.string().trim().min(1).max(200), contextWindow: z.number().int().min(2048).max(2097152), maxTokens: z.number().int().min(128).max(131072),
  ollamaMode: z.enum(['managed', 'existing']).optional(), supportsImages: z.boolean().optional(), enabled: z.boolean().optional(), models: z.array(modelSchema).min(1).max(100).optional(), apiKey: z.string().trim().min(6).max(4096).optional(),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.kind === 'ollama') {
    try {
      const localUrl = localOllamaUrl(v.baseUrl);
      if (v.id !== 'local') issue('Ollama 使用内置本地配置。');
      if (v.ollamaMode !== 'existing' && localUrl !== MANAGED_OLLAMA_URL) issue('托管 Ollama 的地址不可更改；请显式选择已有 Ollama。');
    } catch { issue('本地 Ollama 需要不含凭证的回环地址，路径为 /v1。'); }
    if (v.apiKey) issue('本地 Ollama 不需要 API Key。');
  } else if (v.ollamaMode) issue('仅本地 Ollama 可选择服务来源。');
  if (v.maxTokens + 1536 >= v.contextWindow) issue('输出预算过大，请为上下文留出压缩空间');
  if (v.models) {
    if (new Set(v.models.map(m => m.id)).size !== v.models.length) issue('模型 ID 不能重复');
    const primary = v.models.find(m => m.id === v.model);
    if (!primary || primary.contextWindow !== v.contextWindow || primary.maxTokens !== v.maxTokens) issue('默认模型参数与模型列表不一致');
  }
  let u: URL;
  try { u = new URL(v.baseUrl); } catch { return; }
  if (/^ark\.cn-beijing\.volces\.com$/i.test(u.hostname) && u.pathname.startsWith('/api/coding')) {
    const expected = v.kind === 'anthropic' ? '/api/coding' : '/api/coding/v3';
    if (u.pathname.replace(/\/$/, '') !== expected) issue('火山 Coding Plan 的 Base URL 与 API 格式不匹配，请使用对应预设地址');
  }
  if (/\/(chat\/completions|messages|responses)\/?$/.test(u.pathname)) issue('请填写 Base URL，勿包含 messages、chat/completions 或 responses 接口路径');
});

/** Explicit user action only. Never returns remote response/error text or credentials. */
export async function testConnection(provider: ProviderSecret): Promise<{ message: string }> {
  const anthropic = provider.kind === 'anthropic';
  const responses = provider.kind === 'responses';
  const endpoint = anthropic ? '/v1/messages' : responses ? '/responses' : '/chat/completions';
  try {
    const response = await fetch(provider.baseUrl.replace(/\/$/, '') + endpoint, {
      method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(anthropic ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${provider.apiKey}` }) },
      body: JSON.stringify({ model: provider.model, stream: false, ...(responses
        ? { input: 'Reply OK.', max_output_tokens: 16 }
        : { messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16 }) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 401 || response.status === 403 ? '请检查密钥与套餐权限' : response.status === 404 ? '请检查 Base URL 与模型 ID' : response.status === 429 ? '请求限流或套餐额度不足' : '请检查供应商状态和模型参数';
      throw new Error(`HTTP ${response.status} · ${hint}`);
    }
    // Limit provider-controlled data retained in the desktop process.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('接口未返回内容');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('测试响应过大'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    let data: any;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('接口未返回有效 JSON，请核对 API 格式'); }
    const valid = anthropic ? data.type === 'message' && Array.isArray(data.content) : responses ? data.object === 'response' && Array.isArray(data.output) : Array.isArray(data.choices) && data.choices.length > 0;
    if (!valid || data.error) throw new Error('响应格式不匹配，请核对 API 格式');
    return { message: '连接测试成功。已收到模型响应；工具调用需在任务中验证。' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/^(HTTP \d{3}|接口未返回|测试响应过大|响应格式不匹配)/.test(message)) throw error;
    throw new Error('连接失败或超过 30 秒，请检查网络、Base URL 和服务状态。');
  }
}
