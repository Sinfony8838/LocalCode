import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedTransport, retryDelay } from '../src/agent/transport';
import { RequestScheduler } from '../src/main/request-scheduler';
import { APP_LOCALES, translate } from '../src/shared/i18n';

afterEach(() => vi.useRealTimers());
function harness(mockFetch: typeof fetch, extra: Record<string, unknown> = {}) {
  const controller = new AbortController(); const release = vi.fn(); const progress = vi.fn(); const telemetry = vi.fn(); const failure = vi.fn();
  const transport = managedTransport({ signal: controller.signal, acquire: async () => ({ release }), progress, telemetry, failure, fetch: mockFetch, backoffs: [0, 0], random: () => 0, ...extra });
  return { ...transport, controller, release, progress, telemetry, failure };
}
describe('bounded HTTP recovery', () => {
  it.each(APP_LOCALES)('localizes composed %s failures while preserving raw provider diagnostics', async locale => {
    const detail = '原始 provider detail {untouched}';
    const h = harness(async () => new Response(JSON.stringify({ request_id: 'request-unchanged', error: { code: 'original-code', message: detail } }), { status: 401 }), { locale });
    const error = await h.fetch('https://fixture.invalid').catch(value => value as unknown);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected localized transport failure');
    expect(error.message).toContain(translate(locale, '供应商鉴权或权限检查失败。'));
    expect(error.message).toContain(translate(locale, '已完成的文件修改仍保留。'));
    expect(error.message).toContain('HTTP 401 · original-code · request ID: request-unchanged');
    expect(error.message).toContain(detail);
  });
  it('honors retry headers and rejects invalid hints', () => {
    expect(retryDelay(new Headers({ 'retry-after-ms': '250', 'retry-after': '7' }), 0)).toBe(250);
    expect(retryDelay(new Headers({ 'retry-after': '2' }), 0)).toBe(2000);
    expect(retryDelay(new Headers({ 'retry-after': new Date(Date.now() + 10000).toUTCString() }), 0)).toBeGreaterThan(8000);
    expect(retryDelay(new Headers({ 'retry-after-ms': '-3', 'retry-after': 'invalid' }), 1, undefined, () => 0)).toBe(15000);
  });
  it('retries exactly the rejected HTTP request and keeps its body', async () => {
    const bodies: unknown[] = []; let calls = 0;
    const h = harness(async (_url, init) => { bodies.push(init?.body); return ++calls < 3 ? new Response('{}', { status: 429 }) : new Response('success'); });
    expect(await (await h.fetch('https://fixture.invalid', { method: 'POST', body: 'same-body' })).text()).toBe('success');
    expect(bodies).toEqual(['same-body', 'same-body', 'same-body']); expect(h.release).toHaveBeenCalledTimes(3);
    expect(h.telemetry.mock.calls.filter(([type]) => type === 'request_retry')).toHaveLength(2);
  });
  it('stops after two retries, retains diagnostics, and never retries auth errors', async () => {
    for (const status of [429, 401]) {
      const f = vi.fn(async () => new Response(JSON.stringify({ request_id: 'req-test', error: { code: 'RequestBurstTooFast', message: 'detail' } }), { status }));
      const h = harness(f);
      await expect(h.fetch('https://fixture.invalid')).rejects.toThrow('req-test');
      expect(f).toHaveBeenCalledTimes(status === 429 ? 3 : 1); expect(h.failure).toHaveBeenCalled();
    }
  });
  it('does not wait beyond 120 seconds or retry when forbidden', async () => {
    for (const headers of [new Headers({ 'retry-after': '121' }), new Headers({ 'x-should-retry': 'false' })]) {
      const f = vi.fn(async () => new Response('{}', { status: 429, headers }));
      await expect(harness(f).fetch('https://fixture.invalid')).rejects.toThrow('429'); expect(f).toHaveBeenCalledTimes(1);
    }
  });
  it('cancels during retry sleep without another request', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } }));
    const h = harness(f); const task = h.fetch('https://fixture.invalid'); const failed = expect(task).rejects.toThrow('取消');
    await vi.waitFor(() => expect(h.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'retry' })));
    h.controller.abort(); await failed; expect(f).toHaveBeenCalledTimes(1);
  });
  it('does not retry a broken accepted stream and releases its slot', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const f = vi.fn(async () => new Response(new ReadableStream({ start(c) { body = c; c.enqueue(new TextEncoder().encode('partial')); } })));
    const h = harness(f); const reader = (await h.fetch('https://fixture.invalid')).body!.getReader();
    await reader.read(); body.error(new Error('broken-stream'));
    await expect(reader.read()).rejects.toThrow('broken-stream'); expect(f).toHaveBeenCalledTimes(1); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it('counts useful thinking as progress, ignores heartbeats, and aborts idle reads', async () => {
    vi.useFakeTimers();
    const h = harness(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })), { idleMs: 120 });
    const reader = (await h.fetch('https://fixture.invalid')).body!.getReader(); await reader.read();
    await vi.advanceTimersByTimeAsync(100); h.observe({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'progress' } });
    await vi.advanceTimersByTimeAsync(100); h.observe({ type: 'ping' });
    const read = expect(reader.read()).rejects.toThrow('没有有效进展');
    await vi.advanceTimersByTimeAsync(21); await read; expect(h.release).toHaveBeenCalledTimes(1); expect(h.failure).toHaveBeenCalled();
  });
  it('does not apply model idle timeout while waiting for a permit', async () => {
    vi.useFakeTimers(); let grant!: () => void;
    const h = harness(async () => new Response('ok'), { idleMs: 100, acquire: () => new Promise(resolve => { grant = () => resolve({ release() {} }); }) });
    const result = h.fetch('https://fixture.invalid'); await vi.advanceTimersByTimeAsync(1000); grant();
    expect(await (await result).text()).toBe('ok');
  });
});
describe('cross-worker FIFO request leases', () => {
  it('serializes a credential group, preserves other groups and fences releases', async () => {
    vi.useFakeTimers(); const scheduler = new RequestScheduler(1000); const grants: string[] = [];
    scheduler.acquire('group', 'a', 'a1', () => grants.push('a1'));
    scheduler.acquire('group', 'b', 'b1', () => grants.push('b1'));
    scheduler.acquire('other', 'c', 'c1', () => grants.push('c1'));
    expect(grants).toEqual(['a1', 'c1']); scheduler.release('group', 'b', 'a1');
    await vi.advanceTimersByTimeAsync(2000); expect(grants).toHaveLength(2);
    scheduler.release('group', 'a', 'a1', Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(4999); expect(grants).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(grants).toEqual(['a1', 'c1', 'b1']);
    scheduler.cancel('b'); scheduler.cancel('c');
  });
  it('removes cancelled waiters and crashed holders without affecting another owner', async () => {
    vi.useFakeTimers(); const scheduler = new RequestScheduler(0); const calls = vi.fn();
    scheduler.acquire('g', 'a', '1', () => {}); scheduler.acquire('g', 'b', '2', calls); scheduler.acquire('g', 'c', '3', () => calls('c'));
    scheduler.cancel('b'); scheduler.cancel('a'); expect(calls.mock.calls).toEqual([['c']]); scheduler.cancel('c');
  });
});
