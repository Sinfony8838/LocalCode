#!/usr/bin/env node
// Headless LocalCode AgentEngine runner for benchmark workspaces.
// Drives LocalCode/source/dist/worker.mjs directly over IPC so benchmarks can run
// reproducibly from the CLI in either `--mode closed-loop` (terminal enabled) or
// `--mode edit-only` (no terminal/subprocess execution).
//
// Example with benchmarks/run.mjs:
//   node benchmarks/run.mjs run --out /tmp/bench --agent localcode-1 \
//     --cmd "node <repo>/benchmarks/localcode-runner.mjs --prompt-file {promptFile} --data-dir /tmp/bench/lc-data --mode closed-loop"
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultWorker = path.resolve(__dirname, '..', 'LocalCode', 'source', 'dist', 'worker.mjs');

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    'prompt-file': { type: 'string' },
    workspace: { type: 'string' },
    'data-dir': { type: 'string' },
    mode: { type: 'string', default: 'closed-loop' }, // 'closed-loop' | 'edit-only'
    kind: { type: 'string', default: process.env.LOCALCODE_PROVIDER_KIND || 'openai' },
    'base-url': { type: 'string', default: process.env.LOCALCODE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3' },
    model: { type: 'string', default: process.env.LOCALCODE_MODEL || 'kimi-k3.1-pro' },
    'api-key': { type: 'string', default: process.env.LOCALCODE_API_KEY || process.env.OPENAI_API_KEY || '' },
    thinking: { type: 'string', default: process.env.LOCALCODE_THINKING || 'off' },
    worker: { type: 'string', default: defaultWorker },
  },
});

if (!values['prompt-file']) {
  console.error('Usage: node localcode-runner.mjs --prompt-file <PROMPT.md> [--workspace <dir>] [--data-dir <dir>] [--mode closed-loop|edit-only]');
  process.exit(2);
}

const promptFile = path.resolve(values['prompt-file']);
const workspaceDir = path.resolve(values.workspace || process.cwd());
const dataDir = path.resolve(values['data-dir'] || path.join(path.dirname(workspaceDir), '_lc-data'));
const mode = values.mode === 'edit-only' ? 'edit-only' : 'closed-loop';

let prompt = await fs.readFile(promptFile, 'utf8');
if (mode === 'edit-only') {
  prompt += '\n\n约束：禁止使用任何终端、shell、子进程或执行脚本工具；仅允许使用文件读取、搜索与编辑工具完成任务，测试验证由外部评分器执行。';
}

await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
await fs.mkdir(path.join(dataDir, 'sessions'), { recursive: true });

const runId = randomUUID();
const sessionId = randomUUID();

// Worker trust boundary (core/workspace-context.ts): the request must carry the
// same protectedRoots the main process derives from the data directory.
const dataDirAbs = path.resolve(dataDir);
const protectedRoots = [dataDirAbs, path.join(path.dirname(dataDirAbs), 'cache'), path.join(path.dirname(dataDirAbs), 'logs')];

const child = fork(path.resolve(values.worker), [], {
  cwd: workspaceDir,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

const request = {
  type: 'run',
  runId,
  sessionId,
  projectPath: workspaceDir,
  workspaceRoot: workspaceDir,
  allowedRoots: [workspaceDir],
  protectedRoots,
  dataDir,
  provider: {
    id: 'bench-provider',
    name: 'Benchmark Provider',
    kind: values.kind,
    baseUrl: values['base-url'],
    model: values.model,
    contextWindow: 128000,
    maxTokens: 16384,
    hasKey: Boolean(values['api-key']),
    apiKey: values['api-key'],
    thinkingLevel: values.thinking,
  },
  prompt,
  approvalMode: mode === 'closed-loop' ? 'full' : 'ask',
  workMode: 'execute',
  thinkingLevel: values.thinking,
};

let exitCode = 1;
child.on('message', msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'request_acquire') {
    child.send({ type: 'request_grant', runId: msg.runId, requestId: msg.requestId });
  } else if (msg.type === 'approval' && msg.approval) {
    const isCommand = msg.approval.kind === 'command';
    const allow = mode === 'closed-loop' ? true : !isCommand;
    child.send({ type: 'approve', runId, approvalId: msg.approval.id, allow, scope: 'session' });
  } else if (msg.type === 'question' && msg.question) {
    child.send({ type: 'answer', runId, questionId: msg.question.id, answers: null });
  } else if (msg.type === 'settled') {
    exitCode = msg.status === 'completed' ? 0 : 1;
    if (msg.error) console.error(`[localcode-runner] settled (${msg.status}): ${msg.error}`);
    child.send({ type: 'shutdown' });
  }
});

child.on('exit', code => {
  process.exit(exitCode === 0 ? 0 : code || 1);
});

child.send(request);
