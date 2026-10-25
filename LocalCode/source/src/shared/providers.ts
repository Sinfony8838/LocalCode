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
  return { ...provider, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}
