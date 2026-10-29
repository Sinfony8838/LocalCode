// Reference solution for REPORT_SPEC.md. Streams the file line by line and
// computes everything in a single pass; well inside the 15-second budget.
import fs from 'node:fs';

const REGIONS = ['ap-south', 'eu-west', 'us-east', 'us-north', 'us-west'];
const KINDS = ['build', 'deploy', 'lint', 'sync', 'test', 'verify'];

const text = fs.readFileSync('events.ndjson', 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();

let totalEvents = 0;
let ok = 0;
let retry = 0;
let fail = 0;
const regionCounts = Object.fromEntries(REGIONS.map(region => [region, 0]));
const regionDuration = Object.fromEntries(REGIONS.map(region => [region, 0]));
const kindCounts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
const minuteCounts = new Map();
const durations = new Int32Array(lines.length);
let totalBytes = 0;

for (const line of lines) {
  const event = JSON.parse(line);
  totalEvents++;
  if (event.status === 'ok') ok++; else if (event.status === 'retry') retry++; else fail++;
  regionCounts[event.region]++;
  regionDuration[event.region] += event.durationMs;
  kindCounts[event.kind]++;
  const minute = Math.floor(event.ts / 60_000);
  minuteCounts.set(minute, (minuteCounts.get(minute) ?? 0) + 1);
  durations[totalEvents - 1] = event.durationMs;
  totalBytes += event.bytes;
}

durations.sort();
const percentile = q => durations[Math.ceil((q / 100) * totalEvents) - 1];

const halfUp2 = ratio => Math.round(ratio) / 100; // ratio already scaled by 100

let busiestMinute = -1;
let busiestCount = -1;
for (const [minute, count] of minuteCounts) {
  if (count > busiestCount || (count === busiestCount && minute < busiestMinute)) {
    busiestMinute = minute;
    busiestCount = count;
  }
}
const busiestLabel = `${new Date(busiestMinute * 60_000).toISOString().slice(0, 16)}Z`;

let slowestRegion = REGIONS[0];
let slowestMean = -1;
for (const region of REGIONS) {
  const mean = regionDuration[region] / regionCounts[region];
  if (mean > slowestMean) { slowestMean = mean; slowestRegion = region; }
}

let topKind = KINDS[0];
let topCount = -1;
for (const kind of KINDS) {
  if (kindCounts[kind] > topCount) { topCount = kindCounts[kind]; topKind = kind; }
}

const report = {
  totalEvents,
  byStatus: { ok, retry, fail },
  byRegion: Object.fromEntries(REGIONS.map(region => [region, regionCounts[region]])),
  successRate: halfUp2((ok * 10000) / totalEvents),
  p50DurationMs: percentile(50),
  p95DurationMs: percentile(95),
  p99DurationMs: percentile(99),
  slowestRegion,
  topKind,
  bytesPerEvent: halfUp2((totalBytes * 100) / totalEvents),
  busiestMinute: busiestLabel,
};
fs.writeFileSync('report.json', JSON.stringify(report, null, 2) + '\n');
console.log('report.json written');
