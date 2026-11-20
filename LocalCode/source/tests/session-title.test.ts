import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateSessionTitle } from '../src/main/providers';
import type { ProviderSecret } from '../src/shared/contracts';

afterEach(() => { vi.restoreAllMocks(); });

const cloud: ProviderSecret = { id: 'p', name: 'P', kind: 'openai', baseUrl: 'https://api.example.test/v1', model: 'm', contextWindow: 8192, maxTokens: 1024, hasKey: true, apiKey: 'k' };

function jsonResponse(payload: unknown, ok = true) {
  return new Response(JSON.stringify(payload), { status: ok ? 200 : 500 });
}

describe('generateSessionTitle', () => {
  it('extracts a bounded, punctuation-free title from an OpenAI-compatible reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: ' 修复登录页面的超时问题。 ' } }] })));
    const title = await generateSessionTitle(cloud, '修复登录页面的超时问题，谢谢');
    expect(title).toBe('修复登录页面的超时问题');
  });

  it('reads Anthropic content blocks and caps the length at 24 chars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: '"把'.repeat(30) + '"' }] })));
    const title = await generateSessionTitle({ ...cloud, kind: 'anthropic', baseUrl: 'https://api.example.test' }, 'x');
    expect(title).not.toBeNull();
    expect((title as string).length).toBeLessThanOrEqual(24);
    expect((title as string).includes('"')).toBe(false);
  });

  it('returns null on HTTP errors, malformed JSON, and network failures without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, false)));
    await expect(generateSessionTitle(cloud, 'x')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(generateSessionTitle(cloud, 'x')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(generateSessionTitle(cloud, 'x')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: '...' } }] })));
    await expect(generateSessionTitle(cloud, 'x')).resolves.toBeNull();
  });

  it('never sends more than 500 characters of the prompt to the provider', async () => {
    let captured = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { captured = init.body; return jsonResponse({ choices: [{ message: { content: '标题' } }] }); }));
    await generateSessionTitle(cloud, '很长的提示'.repeat(300));
    const body = JSON.parse(captured) as { messages: { content: string }[] };
    expect(body.messages[0].content.length).toBeLessThanOrEqual(570);
  });
});
