import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run, walk } from '../../../lib/common.mjs';

// Acceptance checks for the four tickets. Hidden from the workspace; every
// expected value is pinned to the algorithm contract in README.md.
const HIDDEN_CASES = `
import { nextOccurrence, missedOccurrences, createScheduler, createTestClock } from WORKSPACE_INDEX;

const JUNE_1 = Date.UTC(2026, 5, 1);
const JAN_15 = Date.UTC(2026, 0, 15);
const H = 3_600_000;
const out = {};
const t_ = (name, fn) => { try { out[name] = Promise.resolve(fn()).then(v => v === true).catch(error => 'threw: ' + ((error && error.message) || error)); } catch (error) { out[name] = 'threw: ' + ((error && error.message) || error); } };

t_('shanghaiOccurrence', () => nextOccurrence({ hour: 9, minute: 0 }, JUNE_1, 'Asia/Shanghai') === JUNE_1 + 1 * H);
t_('nyWinterAndSummer', () => nextOccurrence({ hour: 9, minute: 0 }, JAN_15, 'America/New_York') === JAN_15 + 14 * H
  && nextOccurrence({ hour: 9, minute: 0 }, JUNE_1, 'America/New_York') === JUNE_1 + 13 * H);
t_('berlinWinterAndSummer', () => nextOccurrence({ hour: 9, minute: 0 }, JAN_15, 'Europe/Berlin') === JAN_15 + 8 * H
  && nextOccurrence({ hour: 9, minute: 0 }, JUNE_1, 'Europe/Berlin') === JUNE_1 + 7 * H);
t_('unknownZoneIsUtc', () => nextOccurrence({ hour: 9, minute: 0 }, JUNE_1, 'Mars/Olympus') === JUNE_1 + 9 * H);
t_('recoveryIncludesBoundary', () => {
  const windowStart = JUNE_1 + 10 * H;
  const windowEnd = JUNE_1 + 12 * H;
  const noonReplayed = JSON.stringify(missedOccurrences({ hour: 12, minute: 0 }, windowStart, windowEnd, 'UTC')) === JSON.stringify([windowEnd]);
  const elevenOnly = JSON.stringify(missedOccurrences({ hour: 11, minute: 0 }, windowStart, windowEnd, 'UTC')) === JSON.stringify([JUNE_1 + 11 * H]);
  const startExcluded = JSON.stringify(missedOccurrences({ hour: 10, minute: 0 }, windowStart, windowEnd, 'UTC')) === JSON.stringify([]);
  return noonReplayed && elevenOnly && startExcluded;
});
t_('recoveryEndToEnd', async () => {
  const clock = createTestClock(JUNE_1 + 12 * H);
  const fired = [];
  const scheduler = createScheduler({
    zone: 'UTC',
    now: clock.now,
    onFire: async (job, scheduledAt) => { fired.push([job.id, scheduledAt]); },
  });
  scheduler.add({ id: 'hourly-11', hour: 11, minute: 0 });
  scheduler.add({ id: 'hourly-12', hour: 12, minute: 0 });
  await scheduler.resume(JUNE_1, JUNE_1 + 12 * H);
  return JSON.stringify(fired) === JSON.stringify([
    ['hourly-11', JUNE_1 + 11 * H],
    ['hourly-12', JUNE_1 + 12 * H],
  ]);
});
t_('zoneSchedulerEndToEnd', async () => {
  const clock = createTestClock(JUNE_1 + 12 * H);
  const fired = [];
  const scheduler = createScheduler({
    zone: 'Asia/Shanghai',
    now: clock.now,
    onFire: async (job, scheduledAt) => { fired.push([job.id, scheduledAt]); },
  });
  scheduler.add({ id: 'sh', hour: 9, minute: 0 });
  await scheduler.resume(JUNE_1, JUNE_1 + 12 * H);
  return JSON.stringify(fired) === JSON.stringify([['sh', JUNE_1 + 1 * H]]);
});
console.log(JSON.stringify(await Promise.all(Object.entries(out).map(async ([name, value]) => [name, await value])).then(entries => Object.fromEntries(entries))));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const entry = path.join(dir, 'src', 'index.mjs');
  const entryExists = await fs.stat(entry).then(() => true, () => false);
  if (!entryExists) return { checks: [...checks, check('src/index.mjs exists', 90, false, 'missing src/index.mjs')] };

  const testFiles = (await walk(path.join(dir, 'test'))).map(file => `test/${file}`).filter(file => file.endsWith('.test.mjs'));
  const existing = testFiles.filter(file => baseline[file] !== undefined);
  const existingRun = nodeTest(dir, existing, 120_000);
  checks.push(check('all existing tests still pass unmodified', 8, existingRun.fail === 0 && existingRun.pass >= 15, `pass ${existingRun.pass}, fail ${existingRun.fail}: ${(existingRun.stderr || existingRun.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES.replace('WORKSPACE_INDEX', JSON.stringify(pathToFileURL(entry).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 60_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'acceptance suite produced no output').slice(0, 400) }; }
  const detail = key => typeof r[key] === 'string' ? r[key] : '';

  checks.push(check('T-1042: Shanghai 09:00 maps to 01:00 UTC', 12, r.shanghaiOccurrence === true, detail('shanghaiOccurrence')));
  checks.push(check('T-1057: New York 09:00 is 14:00 UTC winter, 13:00 UTC in DST', 12, r.nyWinterAndSummer === true, detail('nyWinterAndSummer')));
  checks.push(check('T-1061: Berlin 09:00 is 08:00 UTC winter, 07:00 UTC in DST', 11, r.berlinWinterAndSummer === true, detail('berlinWinterAndSummer')));
  checks.push(check('zones without an entry keep the documented UTC fallback', 5, r.unknownZoneIsUtc === true, detail('unknownZoneIsUtc')));
  checks.push(check('T-1070: recovery replays occurrences at or before the recovery moment', 12, r.recoveryIncludesBoundary === true, detail('recoveryIncludesBoundary')));
  checks.push(check('end-to-end recovery replays both missed runs exactly once, in order', 15, r.recoveryEndToEnd === true, detail('recoveryEndToEnd')));
  checks.push(check('zone-aware end-to-end recovery fires at the correct UTC instant', 15, r.zoneSchedulerEndToEnd === true, detail('zoneSchedulerEndToEnd')));
  return { checks };
}
