import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentEngine, agentSystemPrompt, finalSummaryPrompt, isolatedResourceLoader, responseLanguagePolicy } from '../src/agent/engine';
import type { AgentEvent, RunRequest } from '../src/shared/contracts';
import { APP_LOCALES, type AppLocale } from '../src/shared/i18n';
import { workspaceContext } from '../src/core/workspace-context';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('interaction language policy', () => {
  it.each(APP_LOCALES)('uses %s for normal replies and budget summaries while allowing explicit requests', locale => {
    const policy = responseLanguagePolicy(locale);
    expect(agentSystemPrompt(locale)).toContain(policy);
    expect(finalSummaryPrompt(locale)).toContain(policy);
    expect(isolatedResourceLoader(locale).getSystemPrompt()).toContain(policy);
    expect(policy).toContain('explicitly request a different response language');
    expect(policy).toContain("language of the user's input alone does not override this setting");
    expect(agentSystemPrompt(locale)).not.toContain('中文编程助手');
    expect(agentSystemPrompt(locale)).not.toContain('中文最终总结');
    expect(finalSummaryPrompt(locale)).not.toContain('简短中文总结');
  });

  it('defaults old worker requests and invalid stored values to Simplified Chinese', () => {
    expect(responseLanguagePolicy()).toContain('Response language: Simplified Chinese');
    expect(responseLanguagePolicy('invalid' as AppLocale)).toBe(responseLanguagePolicy('zh-CN'));
  });

  it.each([false, true])('sends the current language to the real SDK on every resumed turn without rewriting user requests (projectless=%s)', async projectless => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'localcode-language-')); temporary.push(root);
    const project = path.join(root, 'project'), data = path.join(root, 'data');
    await mkdir(project); await mkdir(data);
    const payloads: { messages: { role: string; content: unknown }[] }[] = [];
    const server = createServer(async (incoming, response) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      payloads.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'mock response' }, null], [{}, 'stop']] as const) {
        response.write(`data: ${JSON.stringify({ id: 'language-test', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const events: AgentEvent[] = [];
    const engine = new AgentEngine(event => events.push(event));
    const base: RunRequest = { type: 'run', runId: 'language-0', sessionId: 'language-session', ...workspaceContext(projectless ? '' : await realpath(project), data), prompt: '请介绍这个项目',
      provider: { id: 'mock', name: 'Mock', kind: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'mock-model', contextWindow: 8192, maxTokens: 1024, hasKey: true, apiKey: 'language-fixture-key' } };
    const prompts = ['请介绍这个项目', '请继续介绍', '请用英文回复这个中文问题', 'Explain the code'];
    let piFile: string | undefined;
    try {
      for (const [index, locale] of APP_LOCALES.entries()) {
        await engine.handle({ ...base, locale, runId: `language-${index}`, piFile, prompt: prompts[index] });
        expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed' });
        const saved = events.find(event => event.type === 'session_file');
        if (saved?.type !== 'session_file') throw new Error('Session file not published');
        piFile = saved.file;
        const system = payloads[index].messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
        expect(system).toContain(responseLanguagePolicy(locale));
        for (const other of APP_LOCALES.filter(value => value !== locale)) expect(system).not.toContain(responseLanguagePolicy(other));
        const currentUser = payloads[index].messages.filter(message => message.role === 'user').at(-1);
        expect(JSON.stringify(currentUser)).toContain(prompts[index]);
      }
      expect(payloads).toHaveLength(4);
    } finally {
      await engine.shutdown(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
