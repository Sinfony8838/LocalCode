// report core — buildReport summarizes logs/; confirmOverwrite gates writes.
// CONTRACT: docs/CI-GUIDE.md. The non-interactive rules live here and in the
// CLI mapping; the helper (scripts/asker.cjs) is a protected child contract.
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
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
 * Interactive overwrite confirmation. CONTRACT: in non-interactive contexts
 * (stdin not a TTY, FORCE_INTERACTIVE unset) the CLI must fail fast with exit
 * code 2 — it must never wait on stdin here. In interactive contexts the
 * prompt helper runs behind a watchdog per CI-GUIDE.md.
 */
export async function confirmOverwrite(target) {
  const interactive = process.env.FORCE_INTERACTIVE === '1' || Boolean(process.stdin?.isTTY);
  if (interactive) {
    const child = spawnPromptHelper();
    // BUG (CI-GUIDE violation): no watchdog around the helper — a stalled
    // helper outlives the CLI and scheduled pipelines hang on it.
    const [answer] = await once(child.stdout, 'data');
    return String(answer ?? '').trim().toLowerCase().startsWith('y');
  }
  // BUG (CI-GUIDE violation): the CI fallback still reads stdin (closed
  // stdin never emits 'data') and still spawns the helper — the parent hangs
  // until the helper's own 10 s watchdog or forever on an open silent pipe.
  const child = spawnPromptHelper();
  void child;
  const [line] = await once(process.stdin, 'data');
  return String(line ?? '').trim().toLowerCase().startsWith('y');
}
