import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, nodeTest, protectedCheck, run } from '../../../lib/common.mjs';

// CI watchdog budget used by every timed check below. The buggy build blocks
// forever on stdin (closed stdin never emits 'data') or waits ~10 s for the
// prompt helper; the fixed build answers within ~3 s.
const WATCHDOG_MS = 8000;

function cliRun(args, { env = {}, input = '', cwd = '.' } = {}) {
  const started = Date.now();
  const result = run(process.execPath, [path.join('bin', 'logpulse.js'), ...args], { cwd, timeout: WATCHDOG_MS, env: { FORCE_INTERACTIVE: '', ...env }, input });
  return { ...result, elapsedMs: Date.now() - started, timedOut: result.timedOut };
}

export async function verify({ task, dir, baseline, current, fixtureDir }) {
  const checks = [protectedCheck(task, baseline, current)];

  const visible = nodeTest(dir, ['test/stats.test.mjs', 'test/rotate.test.mjs', 'test/report.test.mjs'], 120_000);
  checks.push(check('visible tests (7)', 14, Math.round((visible.pass / 7) * 14), `pass ${visible.pass}/7, fail ${visible.fail}${visible.timedOut ? ', timed out' : ''}: ${(visible.stderr || visible.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-bench-r3-'));
  try {
    const freshTarget = path.join(sandbox, 'report.json');
    const existingTarget = path.join(sandbox, 'existing.json');
    await fs.writeFile(existingTarget, '{}\n');

    // Fresh target: no confirmation needed, report must be written.
    const fresh = cliRun(['report', '--out', freshTarget], { cwd: dir });
    let freshOk = fresh.code === 0 && !fresh.timedOut;
    let parsed = null;
    try { parsed = JSON.parse(await fs.readFile(freshTarget, 'utf8')); } catch { freshOk = false; }
    checks.push(check('report writes a JSON summary for a fresh target', 7,
      freshOk && parsed?.files === 5 && parsed?.totalBytes > 0 && Array.isArray(parsed?.logNames) && parsed.logNames.length === 5,
      fresh.timedOut ? 'timed out' : `exit ${fresh.code}, files=${parsed?.files}, bytes=${parsed?.totalBytes}`));

    // --force bypasses confirmation entirely.
    const forced = cliRun(['report', '--out', freshTarget, '--force'], { cwd: dir });
    checks.push(check('--force overwrites an existing target with exit 0', 0,
      forced.code === 0 && !forced.timedOut, forced.timedOut ? 'timed out' : `exit ${forced.code}`));

    // Non-interactive + existing target: exit 2 fast, stderr mentions the rule.
    const guarded = cliRun(['report', '--out', existingTarget], { cwd: dir });
    checks.push(check('non-interactive report refuses with exit 2 within the watchdog budget', 22,
      !guarded.timedOut && guarded.code === 2 && guarded.stderr.includes('non-interactive') && guarded.elapsedMs < WATCHDOG_MS,
      guarded.timedOut ? `timed out after ${guarded.elapsedMs}ms (stdin deadlock still present)` : `exit ${guarded.code} in ${guarded.elapsedMs}ms, stderr=${guarded.stderr.slice(0, 120)}`));

    // Piped stdin is never a confirmation in CI: same refusal as closed stdin.
    const piped = cliRun(['report', '--out', existingTarget], { cwd: dir, input: 'y\n' });
    checks.push(check('piped stdin confirmation is ignored (exit 2, never overwrites)', 15,
      !piped.timedOut && piped.code === 2 && piped.stderr.includes('non-interactive'),
      piped.timedOut ? `timed out after ${piped.elapsedMs}ms` : `exit ${piped.code} in ${piped.elapsedMs}ms`));

    // Interactive path: helper runs behind the 3 s watchdog; timeout = declined (exit 3).
    const interactive = cliRun(['report', '--out', existingTarget], { cwd: dir, env: { FORCE_INTERACTIVE: '1' } });
    checks.push(check('interactive path declines via the 3 s helper watchdog (exit 3)', 22,
      !interactive.timedOut && interactive.code === 3 && interactive.elapsedMs < WATCHDOG_MS,
      interactive.timedOut ? `timed out after ${interactive.elapsedMs}ms (helper watchdog missing)` : `exit ${interactive.code} in ${interactive.elapsedMs}ms`));

    // stats/rotate stay byte-compatible with their contract.
    const stats = cliRun(['stats', path.join('samples', 'sample.log')], { cwd: dir });
    let statsOk = stats.code === 0;
    try { const parsedStats = JSON.parse(stats.stdout); statsOk = parsedStats.lines === 4 && parsedStats.bytes > 0; } catch { statsOk = false; }
    const logsDir = path.join(sandbox, 'rotate-logs');
    await fs.cp(path.join(dir, 'logs'), logsDir, { recursive: true });
    const rotate = cliRun(['rotate', '--dir', logsDir, '--keep', '3'], { cwd: dir });
    let rotateOk = rotate.code === 0;
    try { const parsedRotate = JSON.parse(rotate.stdout); rotateOk = rotateOk && parsedRotate.deleted.join(',') === 'a.log,b.log' && parsedRotate.kept.join(',') === 'c.log,d.log,e.log'; } catch { rotateOk = false; }
    checks.push(check('stats and rotate keep their contract', 10, statsOk && rotateOk && !stats.timedOut && !rotate.timedOut,
      `stats exit ${stats.code}, rotate exit ${rotate.code}`));
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }

  return { checks };
}
