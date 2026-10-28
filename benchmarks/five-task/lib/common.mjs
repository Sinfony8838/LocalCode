import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const benchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tasksRoot = path.join(benchRoot, 'tasks');

export async function listTasks() {
  const names = (await fs.readdir(tasksRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return Promise.all(names.map(async name => ({ ...JSON.parse(await fs.readFile(path.join(tasksRoot, name, 'task.json'), 'utf8')), dir: path.join(tasksRoot, name) })));
}

const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache']);
export async function walk(root, base = root) {
  const out = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}
export async function hashTree(root) {
  const result = {};
  for (const file of await walk(root)) result[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  return result;
}
export async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const file of await walk(from)) {
    await fs.mkdir(path.dirname(path.join(to, file)), { recursive: true });
    await fs.copyFile(path.join(from, file), path.join(to, file));
  }
}

/** Run a child with a hard timeout; never throws. */
// A verifier may itself run under `node --test`; the runner's NODE_TEST_CONTEXT
// would redirect nested test output away from stdout, so never inherit it.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 60_000, cwd: options.cwd, input: options.input ?? '', windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: childEnv(options.env) });
  return { code: result.status, timedOut: result.error?.code === 'ETIMEDOUT', error: result.error?.message, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

let pythonCache;
export function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = process.platform === 'win32' ? [['python', []], ['py', ['-3']], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = run(command, [...prefix, '-c', 'import sys; print(sys.version_info[0])'], { timeout: 15_000 });
    if (probe.code === 0 && probe.stdout.trim() === '3') return (pythonCache = { command, prefix });
  }
  return (pythonCache = null);
}

/** A check contributes `points` of `weight` to the task score. */
export function check(name, weight, pass, detail = '') {
  const points = typeof pass === 'number' ? Math.max(0, Math.min(weight, pass)) : pass ? weight : 0;
  return { name, weight, points, pass: points === weight, detail: String(detail).slice(0, 2000) };
}

export function protectedCheck(task, baseline, current) {
  const touched = (task.protected ?? []).filter(file => baseline[file] !== current[file]);
  return check('protected files unchanged', 10, touched.length === 0, touched.length ? `modified or removed: ${touched.join(', ')}` : '');
}

/** Run node:test files and count passing/failing tests via the TAP summary. */
export function nodeTest(cwd, files, timeout = 60_000) {
  const result = run(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd, timeout });
  const pass = Number(/^# pass (\d+)/m.exec(result.stdout)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)/m.exec(result.stdout)?.[1] ?? 0);
  return { ...result, pass, fail };
}
