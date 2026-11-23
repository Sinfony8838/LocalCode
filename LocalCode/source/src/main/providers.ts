import { z } from 'zod';
import { localOllamaUrl, MANAGED_OLLAMA_URL } from '../shared/providers';
import type { ProviderSecret } from '../shared/contracts';
import type { AppLocale } from '../shared/i18n';

const thinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);
const modelSchema = z.object({ id: z.string().trim().min(1).max(200), contextWindow: z.number().int().min(2048).max(2097152), maxTokens: z.number().int().min(128).max(131072), enabled: z.boolean(), supportsImages: z.boolean().optional(), thinkingLevel: thinkingLevelSchema.optional() }).strict()
  .refine(v => v.maxTokens + 1536 < v.contextWindow, '上下文需留出至少 1536 tokens 供压缩和输入使用');
export const providerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().trim().min(1).max(80), kind: z.enum(['ollama', 'openai', 'anthropic', 'responses']),
  baseUrl: z.string().url().refine(value => {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  }, 'Base URL 仅支持不含凭证、查询参数的 HTTP/HTTPS 地址'),
  model: z.string().trim().min(1).max(200), contextWindow: z.number().int().min(2048).max(2097152), maxTokens: z.number().int().min(128).max(131072),
  ollamaMode: z.enum(['managed', 'existing']).optional(), supportsImages: z.boolean().optional(), enabled: z.boolean().optional(), thinkingLevel: thinkingLevelSchema.optional(), maxToolCalls: z.number().int().min(1).max(1000).optional(), models: z.array(modelSchema).min(1).max(100).optional(), apiKey: z.string().trim().min(6).max(4096).optional(),
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

const TITLE_INSTRUCTIONS: Record<AppLocale, string> = {
  'zh-CN': '为下面的用户请求起一个简短标题：不超过 16 个字，概括任务主题。直接输出标题文本本身，不要引号、句号或任何解释。\n\n用户请求：',
  en: 'Create a short title summarizing the user request below (max 6 words). Output only the plain title text without quotes, trailing punctuation, or explanation.\n\nUser request:',
  ja: '次のユーザー依頼の要点を16文字以内の短いタイトルにまとめてください。タイトル本文のみを出力し、引用符・句点・説明は付けないでください。\n\nユーザー依頼：',
  ko: '아래 사용자 요청의 주제를 16자 이내의 짧은 제목으로 요약하세요. 따옴표, 마침표, 설명 없이 제목만 출력하세요.\n\n사용자 요청:',
};

/** OpenCode-style auto session title: one small request, best-effort, never throws. */
export async function generateSessionTitle(provider: ProviderSecret, prompt: string, timeoutMs = 9000, locale: AppLocale = 'zh-CN'): Promise<string | null> {
  const anthropic = provider.kind === 'anthropic';
  const responses = provider.kind === 'responses';
  const endpoint = anthropic ? '/v1/messages' : responses ? '/responses' : '/chat/completions';
  const instruction = (TITLE_INSTRUCTIONS[locale] ?? TITLE_INSTRUCTIONS['zh-CN']) + prompt.slice(0, 500);
  const maxLength = locale === 'en' ? 40 : 24;
  try {
    const response = await fetch(provider.baseUrl.replace(/\/$/, '') + endpoint, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(anthropic ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${provider.apiKey}` }) },
      body: JSON.stringify({ model: provider.model, stream: false, ...(responses
        ? { input: instruction, max_output_tokens: 64 }
        : { messages: [{ role: 'user', content: instruction }], max_tokens: 64, temperature: 0.2 }) }),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 64 * 1024) return null; chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    let data: any;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
    const raw = anthropic ? (Array.isArray(data.content) ? data.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join(' ') : '')
      : responses ? (Array.isArray(data.output) ? data.output.filter((part: any) => part?.type === 'message').flatMap((part: any) => Array.isArray(part.content) ? part.content : []).map((part: any) => part?.text ?? '').join(' ') : '')
        : (data.choices?.[0]?.message?.content ?? '');
    const cleaned = String(raw).replace(/["'`*#「」『』\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.。!！?？]+$/, '').slice(0, maxLength).trim();
    return cleaned.length >= 2 ? cleaned : null;
  } catch {
    return null; // titling is cosmetic; never surface failures to the user
  }
}
