import { check, findPython, protectedCheck, run } from '../../lib/common.mjs';

const HIDDEN = `
import json
from stats import mean, median, mode, variance
cases = {
  'mean of negatives': lambda: mean([-2, -4, 3]) == -1,
  'median of one value': lambda: median([7]) == 7,
  'median keeps input order': lambda: (lambda data: (median(data), data)[1] == [5, 3, 1])([5, 3, 1]),
  'median of floats': lambda: abs(median([0.5, 2.5, 1.5, 9.5]) - 2.0) < 1e-9,
  'variance of a constant': lambda: variance([3, 3, 3]) == 0,
  'mode with all unique values': lambda: mode([9, 4, 6]) == 4,
}
out = {}
for name, fn in cases.items():
    try:
        out[name] = bool(fn())
    except Exception as error:
        out[name] = False
print(json.dumps(out))
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const python = findPython();
  if (!python) return { checks, skipped: 'Python 3 was not found; T1 cannot be scored on this machine.' };
  const visible = run(python.command, [...python.prefix, '-m', 'unittest', '-v', 'test_stats'], { cwd: dir, timeout: 60_000, env: { PYTHONDONTWRITEBYTECODE: '1' } });
  const lines = (visible.stderr + visible.stdout).split(/\r?\n/);
  const names = ['test_mean', 'test_median_odd_unsorted', 'test_median_even', 'test_variance', 'test_mode_tie_prefers_smallest', 'test_empty_inputs_raise'];
  for (const name of names) checks.push(check(`visible: ${name}`, 10, lines.some(line => line.startsWith(name + ' ') && /\.\.\. ok$/.test(line)), visible.timedOut ? 'timed out' : ''));
  const hidden = run(python.command, [...python.prefix, '-c', HIDDEN], { cwd: dir, timeout: 30_000, env: { PYTHONDONTWRITEBYTECODE: '1' } });
  let results = {};
  try { results = JSON.parse(hidden.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch {}
  for (const [name, pass] of Object.entries(results)) checks.push(check(`hidden: ${name}`, 5, pass));
  if (!Object.keys(results).length) checks.push(check('hidden tests ran', 30, false, hidden.stderr || hidden.error));
  return { checks };
}
