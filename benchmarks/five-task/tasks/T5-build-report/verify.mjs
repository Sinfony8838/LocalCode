import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck } from '../../../lib/common.mjs';

export function expectedReport(records) {
  const decided = records.filter(r => r.status === 'passed' || r.status === 'failed');
  const failed = records.filter(r => r.status === 'failed').length;
  const durations = decided.map(r => r.durationSeconds).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  const timed = records.filter(r => typeof r.durationSeconds === 'number');
  const slowest = timed.reduce((best, r) => (!best || r.durationSeconds > best.durationSeconds ? r : best), null);
  const byBranch = {};
  for (const r of records) { byBranch[r.branch] ??= { builds: 0, failed: 0 }; byBranch[r.branch].builds++; if (r.status === 'failed') byBranch[r.branch].failed++; }
  const counts = {};
  for (const r of records) for (const name of r.failedTests) counts[name] = (counts[name] ?? 0) + 1;
  const topFailingTest = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1))[0] ?? null;
  return { totalBuilds: records.length, failedBuilds: failed, failureRate: Math.round((failed / decided.length) * 1e4) / 1e4, medianDurationSeconds: median, slowestBuildId: slowest?.id ?? null, byBranch, topFailingTest };
}
const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export async function verify({ task, dir, baseline, current, fixtureDir }) {
  const checks = [protectedCheck(task, baseline, current)];
  const expected = expectedReport(JSON.parse(await fs.readFile(path.join(fixtureDir, 'builds.json'), 'utf8')));
  let report;
  try { report = JSON.parse((await fs.readFile(path.join(dir, 'report.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch (error) { report = undefined; checks.push(check('report.json is valid JSON', 10, false, error.message)); }
  if (report !== undefined) {
    const keys = report && typeof report === 'object' && !Array.isArray(report) ? Object.keys(report).sort() : [];
    checks.push(check('report.json has exactly the specified fields', 10, canonical(keys) === canonical(Object.keys(expected).sort()), `fields: ${keys.join(', ')}`));
    for (const [field, value] of Object.entries(expected)) {
      const actual = report?.[field];
      const pass = typeof value === 'number' ? typeof actual === 'number' && Math.abs(actual - value) < 1e-9 : canonical(actual) === canonical(value);
      checks.push(check(`field: ${field}`, 10, pass, pass ? '' : `expected ${canonical(value)}, got ${canonical(actual)}`.slice(0, 400)));
    }
  } else for (const field of Object.keys(expected)) checks.push(check(`field: ${field}`, 10, false, 'no report'));
  const summary = await fs.readFile(path.join(dir, 'SUMMARY.md'), 'utf8').catch(() => null);
  const lines = summary === null ? [] : summary.split(/\r?\n/).filter(line => line.trim());
  checks.push(check('SUMMARY.md present with 1-10 non-empty lines', 10, lines.length >= 1 && lines.length <= 10, summary === null ? 'missing' : `${lines.length} non-empty lines`));
  return { checks };
}
