// Deterministic data generator. Running it again reproduces events.ndjson
// byte-for-byte (seeded PRNG, no clock, no randomness beyond the seed).
import fs from 'node:fs';

function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(1337);
const REGIONS = ['ap-south', 'eu-west', 'us-east', 'us-north', 'us-west'];
const KINDS = ['build', 'deploy', 'lint', 'sync', 'test', 'verify'];
const START = Date.UTC(2026, 2, 15); // 2026-03-15T00:00:00Z
const TOTAL = 150_000;

const lines = [];
for (let i = 0; i < TOTAL; i++) {
  const ts = START + Math.floor((rand() * 86_400_000) / 60_000) * 60_000;
  const region = REGIONS[Math.floor(rand() * REGIONS.length)];
  const kind = KINDS[Math.floor(rand() * KINDS.length)];
  const statusRoll = rand();
  const status = statusRoll < 0.9 ? 'ok' : statusRoll < 0.96 ? 'retry' : 'fail';
  const durationMs = 1 + Math.floor(rand() * 5000);
  const bytes = 64 + Math.floor(rand() * 4096);
  lines.push(JSON.stringify({ ts, region, kind, status, durationMs, bytes }));
}
fs.writeFileSync('events.ndjson', lines.join('\n') + '\n');
console.log(`events.ndjson written: ${TOTAL} events`);
