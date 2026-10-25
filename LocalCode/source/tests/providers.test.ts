import { describe, expect, it } from 'vitest';
import { providerSchema } from '../src/main/providers';
import { ARK_ANTHROPIC_URL, ARK_OPENAI_URL, providerModels, selectProviderModel } from '../src/shared/providers';
import type { ProviderConfig } from '../src/shared/contracts';

const provider: ProviderConfig = { id: 'ark', name: '火山', kind: 'anthropic', baseUrl: ARK_ANTHROPIC_URL, model: 'ark-code-latest', contextWindow: 32768, maxTokens: 4096, hasKey: false };
const { hasKey, ...input } = provider;
describe('provider configuration and model routing', () => {
  it('keeps legacy single-model providers usable and selects exact enabled models', () => {
    expect(providerModels(provider)).toEqual([{ id: 'ark-code-latest', contextWindow: 32768, maxTokens: 4096, enabled: true }]);
    const multiple = { ...provider, models: [...providerModels(provider), { id: 'second', contextWindow: 65536, maxTokens: 8192, enabled: true }] };
    expect(selectProviderModel(multiple, 'second')).toMatchObject({ model: 'second', contextWindow: 65536, maxTokens: 8192 });
    expect(() => selectProviderModel(multiple, 'unknown')).toThrow('不存在');
    expect(() => selectProviderModel({ ...multiple, enabled: false }, 'second')).toThrow('停用');
    expect(() => selectProviderModel({ ...multiple, models: multiple.models.map(m => ({ ...m, enabled: false })) }, 'second')).toThrow('停用');
  });
  it('validates each protocol and rejects mismatched Ark endpoints and full endpoint URLs', () => {
    expect(providerSchema.safeParse(input).success).toBe(true);
    for (const kind of ['openai', 'responses']) expect(providerSchema.safeParse({ ...input, kind, baseUrl: ARK_OPENAI_URL }).success).toBe(true);
    for (const change of [
      { baseUrl: ARK_OPENAI_URL }, { kind: 'openai' }, { baseUrl: 'https://example.com/v1/messages' },
      { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { baseUrl: 'file:///tmp' }, { baseUrl: 'oops' },
      { contextWindow: 4096, maxTokens: 4096 },
      { models: [providerModels(provider)[0], providerModels(provider)[0]] },
      { models: [{ ...providerModels(provider)[0], maxTokens: 8192 }] },
      { models: [{ ...providerModels(provider)[0], contextWindow: 2048, maxTokens: 1024 }] },
    ]) expect(providerSchema.safeParse({ ...input, ...change }).success, JSON.stringify(change)).toBe(false);
  });
});
