import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run } from '../../../lib/common.mjs';

// Hidden cases run against the workspace module through a generated script so
// the workspace never sees them. All clock values are exact in binary floating
// point, so any correct formula ordering agrees.
const HIDDEN_CASES = `
import { RateLimiter } from MODULE_URL;
const out = {};
const t_ = (name, fn) => { try { out[name] = fn() === true; } catch (error) { out[name] = 'threw ' + ((error && error.constructor && error.constructor.name) || error); } };
const throwsRange = fn => { try { fn(); return false; } catch (error) { return error instanceof RangeError; } };

t_('basicConsume', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1, now: () => t });
  const first = rl.tryConsume('k');
  const second = rl.tryConsume('k', 9);
  return first.allowed === true && first.remaining === 9 && second.allowed === true && second.remaining === 0;
});
t_('retryAfterExact', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1, now: () => t });
  rl.tryConsume('k', 10);
  const denied = rl.tryConsume('k');
  return denied.allowed === false && denied.retryAfterMs === 1000;
});
t_('refillContinuous', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1, now: () => t });
  rl.tryConsume('k', 10);
  t = 250;
  const peeked = rl.peek('k');
  const denied = rl.tryConsume('k');
  return peeked.tokens === 0.25 && denied.allowed === false && denied.retryAfterMs === 750;
});
t_('refillAccrual', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 2, now: () => t });
  rl.tryConsume('k', 10);
  t = 3000;
  const peeked = rl.peek('k');
  const ok = rl.tryConsume('k', 5);
  return peeked.tokens === 6 && ok.allowed === true && ok.remaining === 1;
});
t_('perKey', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => t });
  const a = rl.tryConsume('a');
  const a2 = rl.tryConsume('a');
  const b = rl.tryConsume('b');
  return a.allowed === true && a2.allowed === false && b.allowed === true;
});
t_('overCapacity', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1, now: () => t });
  const result = rl.tryConsume('x', 11);
  return result.allowed === false && result.retryAfterMs === null && rl.peek('x').tokens === 10;
});
t_('invalidTokens', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1, now: () => t });
  return throwsRange(() => rl.tryConsume('k', 0)) && throwsRange(() => rl.tryConsume('k', -1))
    && throwsRange(() => rl.tryConsume('k', NaN)) && throwsRange(() => rl.tryConsume('k', Infinity));
});
t_('zeroRefill', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 2, refillPerSecond: 0, now: () => t });
  rl.tryConsume('k', 2);
  const denied = rl.tryConsume('k');
  t = 60000;
  return denied.allowed === false && denied.retryAfterMs === null && rl.peek('k').tokens === 0;
});
t_('peekNoMutate', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: () => t });
  const before = rl.peek('new-key');
  const after = rl.peek('new-key');
  const consumed = rl.tryConsume('new-key');
  return before.tokens === 5 && after.tokens === 5 && consumed.remaining === 4;
});
t_('peekReflectsAccrual', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 4, refillPerSecond: 1, now: () => t });
  rl.tryConsume('k', 4);
  t = 1500;
  return rl.peek('k').tokens === 1.5;
});
t_('resetSemantics', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
  rl.tryConsume('k', 3);
  const denied = rl.tryConsume('k');
  rl.reset('k');
  const restored = rl.tryConsume('k', 3);
  let unknownOk = true;
  try { rl.reset('never-seen'); } catch { unknownOk = false; }
  return denied.allowed === false && restored.allowed === true && unknownOk;
});
t_('timeline', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 10, refillPerSecond: 2, now: () => t });
  const first = rl.tryConsume('k', 10);
  t = 500;
  const second = rl.tryConsume('k');
  t = 2000;
  const peeked = rl.peek('k');
  const denied = rl.tryConsume('k', 4);
  t = 2500;
  const third = rl.tryConsume('k', 4);
  return first.remaining === 0 && second.allowed === true && second.remaining === 0
    && peeked.tokens === 3 && denied.allowed === false && denied.retryAfterMs === 500
    && third.allowed === true && third.remaining === 0;
});
t_('constructorValidation', () => {
  const badCapacity = [0, -1, NaN, Infinity].every(v => { try { new RateLimiter({ capacity: v, refillPerSecond: 1 }); return false; } catch (error) { return error instanceof RangeError; } });
  const badRefill = [-1, NaN, Infinity].every(v => { try { new RateLimiter({ capacity: 1, refillPerSecond: v }); return false; } catch (error) { return error instanceof RangeError; } });
  let badClock = false;
  try { new RateLimiter({ capacity: 1, refillPerSecond: 1, now: 'nope' }); } catch (error) { badClock = error instanceof TypeError; }
  return badCapacity && badRefill && badClock;
});
console.log(JSON.stringify(out));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const impl = await fs.readFile(path.join(dir, 'ratelimit.mjs'), 'utf8').catch(() => null);
  if (impl === null) return { checks: [...checks, check('ratelimit.mjs exists', 90, false, 'ratelimit.mjs not found')] };

  const visible = nodeTest(dir, ['test/ratelimit.test.mjs']);
  checks.push(check('shipped tests pass unmodified', 10, visible.code === 0 && visible.fail === 0 && visible.pass >= 4, `pass ${visible.pass}, fail ${visible.fail}: ${(visible.stderr || visible.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES.replace('MODULE_URL', JSON.stringify(pathToFileURL(path.join(dir, 'ratelimit.mjs')).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 20_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'hidden cases produced no output').slice(0, 400) }; }
  const detail = key => typeof r[key] === 'string' ? r[key] : '';

  checks.push(check('consumes from a full bucket with exact remaining', 12, r.basicConsume === true, detail('basicConsume')));
  checks.push(check('denied consume reports exact retryAfterMs', 12, r.retryAfterExact === true, detail('retryAfterExact')));
  checks.push(check('refill is continuous (fractional tokens accrue)', 12, r.refillContinuous === true, detail('refillContinuous')));
  checks.push(check('accrued tokens persist across consumes', 10, r.refillAccrual === true, detail('refillAccrual')));
  checks.push(check('buckets are independent per key', 8, r.perKey === true, detail('perKey')));
  checks.push(check('tokens above capacity are denied with retryAfterMs null', 6, r.overCapacity === true, detail('overCapacity')));
  checks.push(check('non-positive or non-finite token counts throw RangeError', 5, r.invalidTokens === true, detail('invalidTokens')));
  checks.push(check('refillPerSecond 0 never reports a retry time', 5, r.zeroRefill === true, detail('zeroRefill')));
  checks.push(check('peek reports levels without side effects', 8, r.peekNoMutate === true && r.peekReflectsAccrual === true, detail('peekNoMutate') || detail('peekReflectsAccrual')));
  checks.push(check('reset restores the bucket and tolerates unknown keys', 6, r.resetSemantics === true, detail('resetSemantics')));
  checks.push(check('mixed timeline behaves exactly as specified', 5, r.timeline === true, detail('timeline')));
  checks.push(check('constructor validates capacity, refillPerSecond and clock', 3, r.constructorValidation === true, detail('constructorValidation')));
  return { checks };
}
