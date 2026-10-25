import type { RunProgress } from '../shared/contracts';

export interface RequestLease { release(cooldownUntil?: number): void }
export interface TransportOptions {
  signal: AbortSignal;
  acquire(signal: AbortSignal): Promise<RequestLease>;
  progress(value: RunProgress): void;
  telemetry(type: string, fields?: Record<string, unknown>): void;
  failure?(message: string): void;
  fetch?: typeof fetch;
  idleMs?: number;
  backoffs?: number[];
  random?: () => number;
}
const now = () => new Date().toISOString();
const abortError = () => new DOMException('请求已取消。', 'AbortError');
export function retryDelay(headers: Headers, attempt: number, backoffs = [5000, 15000], random = Math.random): number {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const after = headers.get('retry-after');
  if (after?.trim()) {
    const seconds = Number(after);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  return (backoffs[attempt] ?? 15000) + Math.floor(random() * 1000);
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function errorDescription(status: number, raw: string, headers: Headers): string {
  let code = ''; let requestId = headers.get('x-request-id') ?? ''; let detail = raw;
  try { const data = JSON.parse(raw); code = data.error?.code ?? data.error?.type ?? ''; requestId ||= data.request_id ?? data.error?.request_id ?? ''; detail = data.error?.message ?? raw; } catch { /* retain bounded raw data */ }
  const hint = status === 429 ? '供应商请求限流，自动恢复未成功，请稍后继续。' : status === 401 || status === 403 ? '供应商鉴权或权限检查失败。' : `供应商请求失败（HTTP ${status}）。`;
  return `${hint} 已完成的文件修改仍保留。\nHTTP ${status}${code ? ` · ${code}` : ''}${requestId ? ` · request ID: ${requestId}` : ''}\n${String(detail).slice(0, 4096)}`;
}

/** Wraps the SDK's actual HTTP boundary, never retries an accepted/partial stream. */
export function managedTransport(options: TransportOptions) {
  let touch: (() => void) | undefined;
  let close: (() => void) | undefined;
  const emit = (phase: RunProgress['phase'], extra = {}) => options.progress({ phase, since: now(), ...extra });
  const observed = new Set<string>();
  function observe(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const e = value as any;
    const delta = e.choices?.[0]?.delta;
    const useful = (e.type === 'content_block_delta' && (e.delta?.thinking || e.delta?.text || e.delta?.partial_json))
      || (e.type === 'content_block_start' && (e.content_block?.text || e.content_block?.thinking))
      || (typeof e.type === 'string' && /(?:text|arguments)\.delta$/.test(e.type) && e.delta)
      || delta?.content || delta?.reasoning_content || delta?.reasoning || delta?.tool_calls?.length;
    if (useful || e.type === 'message_start' || e.type === 'response.created') touch?.();
  }
  const wrappedFetch: typeof fetch = async (input, init) => {
    const parentSignal = init?.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal;
    for (let attempt = 0; ; attempt++) {
      parentSignal.throwIfAborted();
      emit('queued');
      const lease = await options.acquire(parentSignal);
      if (parentSignal.aborted) { lease.release(); throw abortError(); }
      const controller = new AbortController();
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined; let released = false; let idle = false;
      const release = (cooldown?: number) => { if (released) return; released = true; clearTimeout(timer); if (touch === arm) touch = undefined; if (close === dispose) close = undefined; lease.release(cooldown); };
      const dispose = () => { controller.abort(); release(); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; controller.abort(new Error('模型请求超过 120 秒没有有效进展，已停止。已完成的文件修改仍保留。')); }, options.idleMs ?? 120000); };
      touch = arm; close = dispose; arm(); emit('waiting');
      options.telemetry('request_start', { attempt: attempt + 1 });
      try {
        const response = await (options.fetch ?? fetch)(input, { ...init, signal, redirect: 'error' });
        if (!observed.has('response')) { observed.add('response'); options.telemetry('first_response'); }
        if (!response.ok) {
          // Bound retained provider-controlled error data and release its body before retry.
          const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          if (reader) try {
            while (size < 65536) { const item = await reader.read(); if (item.done) break; const piece = item.value.slice(0, 65536 - size); chunks.push(piece); size += piece.length; }
          } finally { await reader.cancel().catch(() => {}); }
          const raw = Buffer.concat(chunks).toString('utf8');
          if (response.status === 429) {
            const wait = retryDelay(response.headers, attempt, options.backoffs, options.random);
            const until = Date.now() + wait;
            release(until);
            if (attempt < 2 && wait <= 120000 && response.headers.get('x-should-retry') !== 'false') {
              options.telemetry('request_retry', { attempt: attempt + 1, delayMs: wait, status: 429 });
              emit('retry', { retryAt: until, attempt: attempt + 1 });
              await sleep(wait, parentSignal); continue;
            }
            const extra = wait > 120000 ? `服务端要求等待 ${Math.ceil(wait / 1000)} 秒，超过自动等待上限。\n` : '';
            throw new Error(extra + errorDescription(429, raw, response.headers));
          }
          throw new Error(errorDescription(response.status, raw, response.headers));
        }
        const reader = response.body?.getReader();
        if (!reader) { release(); return response; }
        let finished = false;
        const clean = () => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); release(); };
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const abort = () => { if (finished) return; const reason = idle ? controller.signal.reason : abortError(); if (idle) options.failure?.(String(reason?.message ?? reason)); clean(); streamController.error(reason); void reader.cancel().catch(() => {}); };
        const body = new ReadableStream<Uint8Array>({
          start(c) { streamController = c; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
          async pull(c) {
            try { const item = await reader.read(); if (finished) return; if (item.done) { clean(); c.close(); } else c.enqueue(item.value); }
            catch (error) { if (!finished) { clean(); c.error(idle ? controller.signal.reason : error); } }
          },
          async cancel() { clean(); controller.abort(); await reader.cancel().catch(() => {}); },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        release();
        if (!parentSignal.aborted) options.failure?.(String((idle ? controller.signal.reason : error)?.message ?? error));
        if (idle) throw controller.signal.reason;
        throw error;
      }
    }
  };
  return { fetch: wrappedFetch, observe, close: () => close?.() };
}
