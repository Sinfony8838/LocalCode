import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run, walk } from '../../../lib/common.mjs';

// Acceptance suite for FEATURE_REQUEST.md. Drives the queue through its public
// entry with a fake clock; no real time passes. Hidden from the workspace.
const HIDDEN_CASES = `
import { TaskQueue, Metrics, MemoryStorage } from WORKSPACE_INDEX;

function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  const clock = {
    now: () => now,
    delay: ms => new Promise(resolve => { timers.push({ id: nextId++, at: now + Math.max(0, ms), fn: resolve }); }),
  };
  return {
    clock,
    get now() { return now; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        // settle pending microtask chains first: a just-failed job registers
        // its retry timer one microtask hop later than the code that waits
        await new Promise(resolve => setImmediate(resolve));
        const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        timers.splice(timers.findIndex(timer => timer.id === due.id), 1);
        due.fn();
      }
      now = Math.max(now, end);
    },
  };
}

const out = {};
const t_ = (name, fn) => { try { out[name] = fn().then(v => v === true).catch(error => 'threw: ' + ((error && error.message) || error)); } catch (error) { out[name] = 'threw: ' + ((error && error.message) || error); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

t_('exponentialDelays', async () => {
  const fake = makeFakeClock();
  const metrics = new Metrics();
  const queue = new TaskQueue({ clock: fake.clock, metrics, storage: new MemoryStorage() });
  const attempts = [];
  await queue.add({}, {
    handler: async () => { attempts.push(fake.now); throw new Error('nope'); },
    maxAttempts: 3,
    retry: { policy: 'exponential', baseDelayMs: 100 },
  });
  const idle = queue.whenIdle();
  await fake.advance(1000);
  await idle;
  const [job] = await queue.jobs();
  return same(attempts, [0, 100, 300])
    && job.status === 'dead' && job.attempts === 3 && typeof job.deadAt === 'number'
    && same(metrics.snapshot(), { enqueued: 1, started: 3, succeeded: 0, failed: 3, cancelled: 0, retries: 2, dead: 1 });
});

t_('fixedAndLinear', async () => {
  const fixed = makeFakeClock();
  const qf = new TaskQueue({ clock: fixed.clock, storage: new MemoryStorage() });
  const seenFixed = [];
  await qf.add({}, { handler: async () => { seenFixed.push(fixed.now); throw new Error('x'); }, maxAttempts: 2, retry: { policy: 'fixed', baseDelayMs: 50 } });
  const idleF = qf.whenIdle();
  await fixed.advance(500);
  await idleF;

  const linear = makeFakeClock();
  const ql = new TaskQueue({ clock: linear.clock, storage: new MemoryStorage() });
  const seenLinear = [];
  await ql.add({}, { handler: async () => { seenLinear.push(linear.now); throw new Error('x'); }, maxAttempts: 3, retry: { policy: 'linear', baseDelayMs: 40 } });
  const idleL = ql.whenIdle();
  await linear.advance(500);
  await idleL;

  return same(seenFixed, [0, 50]) && same(seenLinear, [0, 40, 120]);
});

t_('successOnSecondAttempt', async () => {
  const fake = makeFakeClock();
  const metrics = new Metrics();
  const queue = new TaskQueue({ clock: fake.clock, metrics, storage: new MemoryStorage() });
  await queue.add({}, {
    handler: async job => { if (job.attempts < 2) throw new Error('flaky'); },
    maxAttempts: 3,
    retry: { policy: 'exponential', baseDelayMs: 100 },
  });
  const idle = queue.whenIdle();
  await fake.advance(1000);
  await idle;
  const [job] = await queue.jobs();
  const letters = await queue.deadLetters();
  const snapshot = metrics.snapshot();
  return job.status === 'succeeded' && job.attempts === 2
    && letters.length === 0
    && snapshot.failed === 1 && snapshot.retries === 1 && snapshot.dead === 0;
});

t_('deadLetterOrdering', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage() });
  const fail = async () => { throw new Error('x'); };
  await queue.add({ job: 'a' }, { handler: fail, maxAttempts: 2, retry: { policy: 'fixed', baseDelayMs: 100 } });
  await fake.advance(50);
  await queue.add({ job: 'b' }, { handler: fail, maxAttempts: 2, retry: { policy: 'fixed', baseDelayMs: 100 } });
  const idle = queue.whenIdle();
  await fake.advance(1000);
  await idle;
  const letters = await queue.deadLetters();
  const byId = letters.map(job => job.payload.job);
  const deadAts = letters.map(job => job.deadAt);
  return same(byId, ['a', 'b']) && deadAts[0] === 100 && deadAts[1] === 150;
});

t_('legacySingleAttempt', async () => {
  const fake = makeFakeClock();
  const metrics = new Metrics();
  const queue = new TaskQueue({ clock: fake.clock, metrics, storage: new MemoryStorage() });
  let deadEvents = 0;
  queue.on('job:dead', () => deadEvents++);
  await queue.add({}, { handler: async () => { throw new Error('boom'); } });
  await queue.whenIdle();
  const [job] = await queue.jobs();
  const snapshot = metrics.snapshot();
  return job.status === 'failed' && job.deadAt === undefined
    && deadEvents === 0 && snapshot.retries === 0 && snapshot.dead === 0 && snapshot.failed === 1;
});

t_('whenIdleWaitsForRetry', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage() });
  await queue.add({}, { handler: async () => { throw new Error('x'); }, maxAttempts: 2, retry: { policy: 'fixed', baseDelayMs: 100 } });
  let resolved = false;
  const idle = queue.whenIdle().then(() => { resolved = true; });
  await fake.advance(50);
  const midWait = resolved;
  await fake.advance(1000);
  await idle;
  return midWait === false && resolved === true;
});

t_('constructorRetryConfig', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage(), retry: { maxAttempts: 2, policy: 'linear', baseDelayMs: 30 } });
  const attempts = [];
  await queue.add({}, { handler: async () => { attempts.push(fake.now); throw new Error('x'); } });
  const idle = queue.whenIdle();
  await fake.advance(500);
  await idle;
  return same(attempts, [0, 30]);
});

t_('jobDeadEvent', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage() });
  const deadJobs = [];
  queue.on('job:dead', job => deadJobs.push(job));
  await queue.add({}, { handler: async () => { throw new Error('x'); }, maxAttempts: 2, retry: { policy: 'fixed', baseDelayMs: 10 } });
  const idle = queue.whenIdle();
  await fake.advance(500);
  await idle;
  return deadJobs.length === 1 && deadJobs[0].status === 'dead';
});

await Promise.all(Object.entries(out).map(async ([name, value]) => { out[name] = await value; }));
console.log(JSON.stringify(out));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const entry = path.join(dir, 'src', 'index.mjs');
  const entryExists = await fs.stat(entry).then(() => true, () => false);
  if (!entryExists) return { checks: [...checks, check('src/index.mjs exists', 90, false, 'missing src/index.mjs')] };

  const testFiles = (await walk(path.join(dir, 'test'))).map(file => `test/${file}`).filter(file => file.endsWith('.test.mjs'));
  const existing = testFiles.filter(file => baseline[file] !== undefined);
  const existingRun = nodeTest(dir, existing, 120_000);
  checks.push(check('all existing tests still pass unmodified', 12, existingRun.fail === 0 && existingRun.pass >= 26, `pass ${existingRun.pass}, fail ${existingRun.fail}: ${(existingRun.stderr || existingRun.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES.replace('WORKSPACE_INDEX', JSON.stringify(pathToFileURL(entry).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 60_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'acceptance suite produced no output').slice(0, 400) }; }
  const detail = key => typeof r[key] === 'string' ? r[key] : '';

  checks.push(check('exponential retries fire at exactly 100 ms then 200 ms, then dead-letter', 20, r.exponentialDelays === true, detail('exponentialDelays')));
  checks.push(check('fixed and linear policies compute the documented delays', 8, r.fixedAndLinear === true, detail('fixedAndLinear')));
  checks.push(check('a job that succeeds on attempt 2 is not a dead letter', 10, r.successOnSecondAttempt === true, detail('successOnSecondAttempt')));
  checks.push(check('dead letters are returned oldest-first with deadAt stamps', 12, r.deadLetterOrdering === true, detail('deadLetterOrdering')));
  checks.push(check('maxAttempts 1 keeps the legacy failed behaviour', 10, r.legacySingleAttempt === true, detail('legacySingleAttempt')));
  checks.push(check('whenIdle does not resolve while a retry is pending', 8, r.whenIdleWaitsForRetry === true, detail('whenIdleWaitsForRetry')));
  checks.push(check('constructor-level retry defaults apply to every job', 5, r.constructorRetryConfig === true, detail('constructorRetryConfig')));
  checks.push(check('job:dead fires once when a job dies', 5, r.jobDeadEvent === true, detail('jobDeadEvent')));
  return { checks };
}
