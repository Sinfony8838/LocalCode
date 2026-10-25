import type { ModelConfig, ProviderConfig } from './contracts';

export const ARK_ANTHROPIC_URL = 'https://ark.cn-beijing.volces.com/api/coding';
export const ARK_OPENAI_URL = `${ARK_ANTHROPIC_URL}/v3`;
export function providerModels(provider: ProviderConfig): ModelConfig[] {
  return provider.models ?? [{ id: provider.model, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens, enabled: true }];
}
export function selectProviderModel(provider: ProviderConfig, modelId?: string): ProviderConfig {
  if (provider.enabled === false) throw new Error('此供应商已停用，请在模型设置中启用。');
  const model = providerModels(provider).find(model => model.id === (modelId ?? provider.model));
  if (!model || !model.enabled) throw new Error('模型不存在或已停用，请重新选择模型。');
  return { ...provider, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, supportsImages: model.supportsImages ?? provider.supportsImages ?? false };
}

export const MANAGED_OLLAMA_URL = 'http://127.0.0.1:11434/v1';
/** Local discovery and inference never accept credentials, remote hosts or proxy paths. */
export function localOllamaUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') {
    throw new Error('本地 Ollama 仅支持 http://127.0.0.1:端口/v1、http://localhost:端口/v1 或 http://[::1]:端口/v1，不含凭证或其他路径。');
  }
  // Never resolve a hostname when contacting the local service.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin + '/v1';
}
