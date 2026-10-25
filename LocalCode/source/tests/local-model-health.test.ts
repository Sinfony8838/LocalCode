import { describe, expect, it, vi } from 'vitest';
import { inspectLocalModel, localModelProbeSchema } from '../src/main/local-model-health';
import { providerSchema } from '../src/main/providers';
import { localOllamaUrl, MANAGED_OLLAMA_URL } from '../src/shared/providers';

const probe = { baseUrl: MANAGED_OLLAMA_URL, model: 'small', contextWindow: 4096, ollamaMode: 'existing' as const };
const config = { ...probe, id: 'local', name: 'Local', kind: 'ollama', maxTokens: 512 };
const ready = async () => 'ready' as const;
function fixture(tags: unknown = { models: [{ name: 'small:latest' }, { name: 'large:latest' }] }) {
  return vi.fn<typeof fetch>(async url => {
    const pathname = new URL(String(url)).pathname;
    return Response.json(pathname === '/api/tags' ? tags : pathname === '/api/version' ? { version: '0.40.10' } : { models: [{ name: 'small:latest', size: 100, size_vram: 0 }] });
  });
}
describe('explicit local model configuration', () => {
  it('permits only credential-free loopback URLs and explicit existing-service ports', () => {
    expect(localOllamaUrl('http://localhost:11500/v1/')).toBe('http://127.0.0.1:11500/v1');
    expect(localOllamaUrl('http://[::1]:11434/v1')).toBe('http://[::1]:11434/v1');
    for (const baseUrl of ['https://example.com/v1', 'http://192.168.1.1/v1', 'http://127.0.0.1.evil.test/v1', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?key=secret', 'http://127.0.0.1/v1#secret', 'http://localhost/proxy/v1', 'file:///v1']) {
      expect(localModelProbeSchema.safeParse({ ...probe, baseUrl }).success, baseUrl).toBe(false);
      expect(providerSchema.safeParse({ ...config, baseUrl }).success, baseUrl).toBe(false);
    }
    expect(providerSchema.safeParse({ ...config, baseUrl: 'http://localhost:11500/v1' }).success).toBe(true);
    expect(providerSchema.safeParse({ ...config, baseUrl: 'http://localhost:11500/v1', ollamaMode: 'managed' }).success).toBe(false);
    expect(providerSchema.safeParse({ ...config, apiKey: 'never-store-this' }).success).toBe(false);
    expect(providerSchema.safeParse({ ...config, id: 'another-local' }).success).toBe(false);
    expect(providerSchema.safeParse({ ...config, kind: 'openai' }).success).toBe(false);
  });
  it('reads model names, version and metrics without loading, downloading or generating', async () => {
    const request = fixture();
    const result = await inspectLocalModel({ ...probe, baseUrl: 'http://localhost:11500/v1' }, { managedState: ready, request });
    expect(result).toMatchObject({ status: 'ready', online: true, modelAvailable: true, installedModels: ['large:latest', 'small:latest'], version: '0.40.10', gpuPercent: 0 });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:11500/api/tags', 'http://127.0.0.1:11500/api/version', 'http://127.0.0.1:11500/api/ps']);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) });
      expect(init?.body).toBeUndefined(); expect(init?.headers).toBeUndefined();
    }
  });
  it('does not probe an invalid address or silently reuse an unverified managed service', async () => {
    const request = fixture(); const managedState = vi.fn(async () => 'unverified' as const);
    expect(await inspectLocalModel({ ...probe, baseUrl: 'http://remote.test/v1' }, { managedState, request })).toMatchObject({ status: 'invalid_config' });
    expect(managedState).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(await inspectLocalModel({ ...probe, ollamaMode: 'managed' }, { managedState, request })).toMatchObject({ status: 'unverified_service', online: false });
    expect(request).not.toHaveBeenCalled();
    expect(await inspectLocalModel({ ...probe, ollamaMode: undefined }, { managedState: async () => 'missing_runtime', request })).toMatchObject({ status: 'missing_runtime' });
    expect(await inspectLocalModel({ ...probe, ollamaMode: undefined }, { managedState: async () => 'stopped', request })).toMatchObject({ status: 'offline' });
    expect(request).not.toHaveBeenCalled();
  });
  it('separates a missing model from server connectivity and tolerates optional metric failures', async () => {
    const request = fixture({ models: [{ name: 'other:latest' }] });
    expect(await inspectLocalModel(probe, { managedState: ready, request })).toMatchObject({ status: 'missing_model', online: true, modelAvailable: false, installedModels: ['other:latest'] });
    const optionalFailure = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'small:latest' }] });
      throw new Error('optional metric is unavailable');
    });
    expect(await inspectLocalModel(probe, { managedState: ready, request: optionalFailure })).toMatchObject({ status: 'ready', online: true, modelAvailable: true });
  });
  it('bounds and validates provider-controlled bodies and never echoes response text', async () => {
    const secretText = 'remote-private-server-details';
    for (const response of [new Response(secretText, { status: 500 }), new Response(secretText), Response.json({ models: 'unexpected' }), Response.json({ models: Array.from({ length: 1001 }, () => ({ name: 'x' })) }), new Response('x'.repeat(1024 * 1024 + 1))]) {
      const result = await inspectLocalModel(probe, { managedState: ready, request: vi.fn<typeof fetch>(async () => response) });
      expect(result.status).toBe('invalid_response'); expect(JSON.stringify(result)).not.toContain(secretText);
    }
    const request = vi.fn<typeof fetch>(async () => { throw new Error(secretText); });
    const result = await inspectLocalModel(probe, { managedState: ready, request });
    expect(result.status).toBe('offline'); expect(JSON.stringify(result)).not.toContain(secretText);
  });
  it('aborts an unresponsive inspection within the four-second request deadline', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const before = Date.now();
    expect(await inspectLocalModel(probe, { managedState: ready, request })).toMatchObject({ status: 'offline' });
    expect(Date.now() - before).toBeLessThan(5000);
    expect(request).toHaveBeenCalledTimes(1);
  }, 6000);
});
