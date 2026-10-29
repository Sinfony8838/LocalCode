import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, copyTree, nodeTest, protectedCheck, run, walk } from '../../../lib/common.mjs';

const lamp = { sku: 'lamp', unitCents: 2450, quantity: 2, taxable: true };
const book = { sku: 'book', unitCents: 1299, quantity: 3, taxable: false };
const CASES = [
  ['report: mixed taxable cart', 15, [[book, lamp], { taxRate: 0.0825 }], { subtotal: 8797, discount: 0, tax: 404, total: 9201 }],
  ['report: percent coupon rounds half up', 15, [[{ sku: 'gum', unitCents: 11, quantity: 1, taxable: false }], { coupon: { type: 'percent', value: 10 } }], { subtotal: 11, discount: 1, tax: 0, total: 10 }],
  ['report: fixed coupon clamps at zero', 15, [[{ sku: 'pen', unitCents: 300, quantity: 1, taxable: true }], { taxRate: 0.1, coupon: { type: 'fixed', value: 500 } }], { subtotal: 300, discount: 300, tax: 0, total: 0 }],
  ['hidden: tax rounds half up', 5, [[{ sku: 'kit', unitCents: 1000, quantity: 1, taxable: true }], { taxRate: 0.0825 }], { subtotal: 1000, discount: 0, tax: 83, total: 1083 }],
  ['hidden: coupon is spread before tax', 5, [[lamp, book], { taxRate: 0.0825, coupon: { type: 'percent', value: 20 } }], { subtotal: 8797, discount: 1759, tax: 323, total: 7361 }],
  ['hidden: empty cart', 5, [[], { taxRate: 0.0825, coupon: { type: 'fixed', value: 100 } }], { subtotal: 0, discount: 0, tax: 0, total: 0 }],
];

export async function verify({ task, dir, baseline, current, fixtureDir }) {
  const checks = [protectedCheck(task, baseline, current)];
  const script = `import { totals } from ${JSON.stringify(pathToFileURL(path.join(dir, 'cart.mjs')).href)};
const cases = ${JSON.stringify(CASES.map(([name, , args, expected]) => [name, args, expected]))}; const out = {};
for (const [name, args, expected] of cases) { try { out[name] = JSON.stringify(totals(...args)) === JSON.stringify(expected); } catch { out[name] = false; } }
console.log(JSON.stringify(out));`;
  const hidden = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 20_000 });
  let results = {}; try { results = JSON.parse(hidden.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch {}
  for (const [name, weight] of CASES) checks.push(check(name, weight, results[name] === true));

  const testFiles = (await walk(path.join(dir, 'test'))).map(file => `test/${file}`).filter(file => /\.(m?js|cjs)$/.test(file));
  const ownTests = nodeTest(dir, testFiles);
  const added = ownTests.pass + ownTests.fail - 1; // the fixture ships one test
  checks.push(check('agent added regression tests that pass', 15, added >= 3 && ownTests.fail === 0 ? 15 : added >= 1 && ownTests.fail === 0 ? 8 : 0, `tests: pass ${ownTests.pass}, fail ${ownTests.fail}`));

  // Mutation check: the agent's tests must fail against the original buggy sources.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-bench-t3-'));
  try {
    await copyTree(fixtureDir, scratch);
    await fs.rm(path.join(scratch, 'test'), { recursive: true, force: true });
    await copyTree(path.join(dir, 'test'), path.join(scratch, 'test'));
    const mutated = nodeTest(scratch, testFiles);
    checks.push(check('regression tests detect the original bugs', 15, added >= 1 && mutated.fail >= 1, `against original sources: pass ${mutated.pass}, fail ${mutated.fail}`));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  return { checks };
}
