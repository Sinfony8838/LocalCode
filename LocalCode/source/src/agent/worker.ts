import { AgentEngine } from './engine.js';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, WorkerCommand, TransportMessage, TransportGrant } from '../shared/contracts.js';

// Electron utilityProcess and child_process.fork deliberately share the same typed protocol.
const parentPort = (process as typeof process & { parentPort?: {
  on(event: 'message', handler: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
} }).parentPort;
function emit(event: AgentEvent | TransportMessage): void {
  if (parentPort) parentPort.postMessage(event);
  else if (process.connected) process.send?.(event);
}
const permits = new Map<string, { runId: string; resolve(): void }>();
const engine = new AgentEngine(emit, { acquireRequest: (request, signal) => new Promise((resolve, reject) => {
  const requestId = randomUUID();
  const identity = { runId: request.runId, sessionId: request.sessionId, requestId };
  const abort = () => { permits.delete(requestId); emit({ type: 'request_cancel', ...identity }); reject(new Error('请求已取消。')); };
  if (signal.aborted) { reject(new Error('请求已取消。')); return; }
  permits.set(requestId, { runId: request.runId, resolve: () => {
    permits.delete(requestId); signal.removeEventListener('abort', abort);
    resolve({ release: cooldownUntil => emit({ type: 'request_release', ...identity, cooldownUntil }) });
  } });
  signal.addEventListener('abort', abort, { once: true });
  emit({ type: 'request_acquire', ...identity });
}) });
let shuttingDown = false;
async function receive(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  if (value.type === 'request_grant') {
    const grant = value as TransportGrant; const permit = permits.get(grant.requestId);
    if (permit?.runId === grant.runId) permit.resolve();
    return;
  }
  const command = value as WorkerCommand;
  if (!['run', 'approve', 'abort', 'shutdown'].includes(command.type)) return;
  try {
    await engine.handle(command);
    if (command.type === 'shutdown') process.exit(0);
  } catch (error) {
    if (command.type === 'run') {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', runId: command.runId, sessionId: command.sessionId, message });
      emit({ type: 'settled', runId: command.runId, sessionId: command.sessionId, status: 'failed', error: message });
    }
  }
}
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await engine.shutdown();
  process.exit(0);
}
if (parentPort) parentPort.on('message', event => { void receive(event.data); });
else process.on('message', message => { void receive(message); });
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
