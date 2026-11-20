// report core — buildReport summarizes logs/; confirmOverwrite gates writes.
// CONTRACT: docs/CI-GUIDE.md. Non-interactive refusal is enforced by the CLI
// guard before this module is reached; the helper (scripts/asker.cjs) is a
// protected child contract. The interactive path runs the helper behind a
// watchdog and kills it on timeout so a stalled helper never outlives the CLI.
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildReport(dir = 'logs') {
  const entries = await readdir(dir).catch(() => []);
  const logs = entries.filter(name => name.endsWith('.log')).sort();
  let totalBytes = 0;
  for (const name of logs) {
    const info = await stat(path.join(dir, name));
    totalBytes += info.size;
  }
  return { generatedBy: 'logpulse report', dir, files: logs.length, logNames: logs, totalBytes };
}

function spawnPromptHelper() {
  const child = spawn(process.execPath, [path.join(here, '..', '..', 'scripts', 'asker.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child;
}

/**
 * Interactive overwrite confirmation behind the CI-GUIDE watchdog: resolve
 * as soon as the helper prints an answer; on watchdog expiry kill the helper
 * and treat the answer as declined. Never resolves later than watchdogMs.
 */
export async function confirmOverwrite(target, { watchdogMs = 3000 } = {}) {
  const child = spawnPromptHelper();
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy?.();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), watchdogMs);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const text = buffer.trim().toLowerCase();
      if (text) finish(text.startsWith('y'));
    });
    child.on('error', () => finish(false));
  });
}
