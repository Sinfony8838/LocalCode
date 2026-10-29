import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck, run } from '../../../lib/common.mjs';

const REGIONS = ['ap-south', 'eu-west', 'us-east', 'us-north', 'us-west'];
const KINDS = ['build', 'deploy', 'lint', 'sync', 'test', 'verify'];

// Independent expected-value computation (deliberately not the same code shape
// as the reference solution; both must agree or self-test fails).
function computeExpected(events) {
  let total = 0; let ok = 0; let retry = 0; let fail = 0; let bytes = 0;
  const regionCounts = {}; const regionDurationSum = {};
  for (const region of REGIONS) { regionCounts[region] = 0; regionDurationSum[region] = 0; }
  const kindCounts = {};
  for (const kind of KINDS) kindCounts[kind] = 0;
  const minuteTotals = {};
  const allDurations = [];

  for (const event of events) {
    total++;
    if (event.status === 'ok') ok += 1; else if (event.status === 'retry') retry += 1; else fail += 1;
    regionCounts[event.region] += 1;
    regionDurationSum[event.region] += event.durationMs;
    kindCounts[event.kind] += 1;
    const minute = Math.floor(event.ts / 60_000);
    minuteTotals[minute] = (minuteTotals[minute] ?? 0) + 1;
    allDurations.push(event.durationMs);
    bytes += event.bytes;
  }
  allDurations.sort((a, b) => a - b);
  const rank = q => allDurations[Math.ceil((q / 100) * total) - 1];

  let busiest = null;
  for (const minute of Object.keys(minuteTotals)) {
    const value = Number(minute);
    if (busiest === null || minuteTotals[minute] > minuteTotals[busiest] || (minuteTotals[minute] === minuteTotals[busiest] && value < busiest)) {
      busiest = value;
    }
  }

  const means = REGIONS.map(region => ({ region, mean: regionDurationSum[region] / regionCounts[region] }));
  means.sort((a, b) => b.mean - a.mean || a.region.localeCompare(b.region));

  const kindsSorted = [...KINDS].sort((a, b) => kindCounts[b] - kindCounts[a] || a.localeCompare(b));

  return {
    totalEvents: total,
    byStatus: { ok, retry, fail },
    byRegion: Object.fromEntries(REGIONS.map(region => [region, regionCounts[region]])),
    successRate: Math.round((ok * 10000) / total) / 100,
    p50DurationMs: rank(50),
    p95DurationMs: rank(95),
    p99DurationMs: rank(99),
    slowestRegion: means[0].region,
    topKind: kindsSorted[0],
    bytesPerEvent: Math.round((bytes * 100) / total) / 100,
    busiestMinute: `${new Date(busiest * 60_000).toISOString().slice(0, 16)}Z`,
  };
}

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];

  const solvePath = path.join(dir, 'solve.mjs');
  const solveExists = await fs.stat(solvePath).then(() => true, () => false);
  if (!solveExists) {
    return { checks: [...checks, check('solve.mjs exists and runs in budget', 90, false, 'solve.mjs not found')] };
  }

  const eventsText = await fs.readFile(path.join(dir, 'events.ndjson'), 'utf8');
  const events = eventsText.split('\n').filter(line => line !== '').map(line => JSON.parse(line));
  const expected = computeExpected(events);

  const started = Date.now();
  const solveRun = run(process.execPath, ['solve.mjs'], { cwd: dir, timeout: 15_000 });
  const elapsedMs = Date.now() - started;
  const inBudget = solveRun.code === 0 && !solveRun.timedOut;
  checks.push(check('solve.mjs finishes within the 15 s budget', 12, inBudget, inBudget ? `${elapsedMs} ms` : `exit ${solveRun.code}, timedOut ${solveRun.timedOut}: ${(solveRun.stderr || solveRun.error || '').slice(0, 200)}`));

  let report = null;
  if (inBudget) {
    const raw = await fs.readFile(path.join(dir, 'report.json'), 'utf8').catch(() => null);
    if (raw !== null) { try { report = JSON.parse(raw); } catch { report = null; } }
  }
  if (report === null) {
    checks.push(check('report.json parses', 78, false, 'report.json missing or invalid after running solve.mjs'));
    return { checks };
  }

  const exactFields = ['totalEvents', 'successRate', 'p50DurationMs', 'p95DurationMs', 'p99DurationMs', 'slowestRegion', 'topKind', 'bytesPerEvent', 'busiestMinute'];
  const eq = field => JSON.stringify(report[field]) === JSON.stringify(expected[field]);

  checks.push(check('totalEvents matches the data', 4, eq('totalEvents'), `got ${JSON.stringify(report.totalEvents)}`));
  checks.push(check('byStatus counts exact with pinned key order', 6, JSON.stringify(report.byStatus) === JSON.stringify(expected.byStatus), `got ${JSON.stringify(report.byStatus)}`));
  checks.push(check('byRegion exact with A→Z sorted keys', 10, JSON.stringify(report.byRegion) === JSON.stringify(expected.byRegion), `got ${JSON.stringify(report.byRegion)}`));
  checks.push(check('successRate rounded half-up to 2 decimals', 8, eq('successRate'), `got ${JSON.stringify(report.successRate)}`));
  checks.push(check('p50DurationMs uses nearest-rank over all events', 6, eq('p50DurationMs'), `got ${JSON.stringify(report.p50DurationMs)}`));
  checks.push(check('p95DurationMs uses nearest-rank over all events', 6, eq('p95DurationMs'), `got ${JSON.stringify(report.p95DurationMs)}`));
  checks.push(check('p99DurationMs uses nearest-rank over all events', 6, eq('p99DurationMs'), `got ${JSON.stringify(report.p99DurationMs)}`));
  checks.push(check('slowestRegion by mean duration, alphabetical tie-break', 8, eq('slowestRegion'), `got ${JSON.stringify(report.slowestRegion)}`));
  checks.push(check('topKind by count, alphabetical tie-break', 6, eq('topKind'), `got ${JSON.stringify(report.topKind)}`));
  checks.push(check('bytesPerEvent rounded half-up to 2 decimals', 6, eq('bytesPerEvent'), `got ${JSON.stringify(report.bytesPerEvent)}`));
  checks.push(check('busiestMinute in UTC Z format, earliest tie-break', 8, eq('busiestMinute'), `got ${JSON.stringify(report.busiestMinute)}`));
  checks.push(check('report has exactly the specified fields and nothing extra', 4, Array.isArray(report) === false && JSON.stringify(Object.keys(report)) === JSON.stringify(Object.keys(expected)), `got ${JSON.stringify(Object.keys(report))}`));
  return { checks };
}
