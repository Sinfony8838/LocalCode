import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run } from '../../../lib/common.mjs';

// Byte-level format contract: BOM + CRLF + marked trailing whitespace must
// survive surgical multi-hunk edits in untouched regions.
function analyze(content) {
  const bom = content.charCodeAt(0) === 0xfeff;
  const text = bom ? content.slice(1) : content;
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.replace(/\r\n/g, '')).split('\n').length - 1;
  const trailing = text.split('\n').slice(0, -1)
    .map(line => line.replace(/\r$/, ''))
    .filter(line => /[ \t]$/.test(line) || /[ \t]+$/.test(line))
    .map(line => line.replace(/[ \t]+$/, ''));
  return { bom, crlf, bareLf, trailing };
}

function formatChecks(label, current, original) {
  const c = analyze(current), o = analyze(original);
  return [
    check(`${label}: UTF-8 BOM preserved`, 2, c.bom === o.bom && c.bom, c.bom ? 'BOM present' : 'BOM missing or newly added'),
    check(`${label}: CRLF line endings preserved`, 5, c.crlf >= Math.floor(o.crlf * 0.9) && c.bareLf <= 3, `original CRLF ${o.crlf}, current ${c.crlf}, bare LF ${c.bareLf}`),
    check(`${label}: marked trailing whitespace preserved`, 3, o.trailing.every(t => {
      const lines = current.slice(c.bom ? 1 : 0).split('\n').map(l => l.replace(/\r$/, ''));
      return lines.some(l => l.replace(/[ \t]+$/, '') === t && /[ \t]$/.test(l));
    }), o.trailing.length ? `${o.trailing.length} marked lines` : 'no marked lines'),
  ];
}

const HIDDEN_CASES = `
import { parseConcurrency, ceilTimeout } from LIMITS;
import { normalizeLimit } from BUDGET;
const eq = (a, b) => Object.is(a, b);
const out = {};
const t_ = (name, fn) => { try { out[name] = fn(); } catch (e) { out[name] = 'threw: ' + ((e && e.message) || e); } };

t_('parseConcurrencyBoundaries', () =>
  eq(parseConcurrency('4'), 4) && eq(parseConcurrency(2.7), 2) && eq(parseConcurrency(0), 1)
  && eq(parseConcurrency(-3), 1) && eq(parseConcurrency(99), 8) && eq(parseConcurrency(99, { max: 16 }), 16)
  && eq(parseConcurrency(NaN), 1) && eq(parseConcurrency('oops'), 1) && eq(parseConcurrency(Infinity), 1));

t_('ceilTimeoutBoundaries', () =>
  eq(ceilTimeout(150), 200) && eq(ceilTimeout(41), 100) && eq(ceilTimeout(100), 100)
  && eq(ceilTimeout(250, { quantum: 50 }), 250) && eq(ceilTimeout(9999), 5000)
  && eq(ceilTimeout(1), 100) && eq(ceilTimeout(0), 100));

t_('normalizeLimitBoundaries', () =>
  eq(normalizeLimit('30'), 30) && eq(normalizeLimit(-5), 0) && eq(normalizeLimit(2000), 1000)
  && eq(normalizeLimit(NaN), null) && eq(normalizeLimit('abc'), null) && eq(normalizeLimit(Infinity), null)
  && eq(normalizeLimit(999.5), 999.5) && eq(normalizeLimit(0), 0) && eq(normalizeLimit(30, { max: 20 }), 20));

console.log(JSON.stringify(out));
`;

export async function verify({ task, dir, baseline, current, fixtureDir }) {
  const checks = [protectedCheck(task, baseline, current)];

  const visible = nodeTest(dir, ['test/limits.test.mjs', 'test/format.test.mjs'], 60_000);
  const totalVisible = 8;
  checks.push(check('visible tests (8)', 16, Math.round((visible.pass / totalVisible) * 16), `pass ${visible.pass}/${totalVisible}, fail ${visible.fail}${visible.timedOut ? ', timed out' : ''}: ${(visible.stderr || visible.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES
    .replace('LIMITS', JSON.stringify(pathToFileURL(path.join(dir, 'src', 'limits.mjs')).href))
    .replace('BUDGET', JSON.stringify(pathToFileURL(path.join(dir, 'src', 'budget.mjs')).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 30_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'hidden suite produced no output').slice(0, 400) }; }
  const detail = key => (typeof r[key] === 'string' ? r[key] : '');
  checks.push(check('hidden: parseConcurrency boundary rules', 14, r.parseConcurrencyBoundaries === true, detail('parseConcurrencyBoundaries')));
  checks.push(check('hidden: ceilTimeout rounds up, floors at one quantum, respects cap', 14, r.ceilTimeoutBoundaries === true, detail('ceilTimeoutBoundaries')));
  checks.push(check('hidden: normalizeLimit null/zero/cap rules', 14, r.normalizeLimitBoundaries === true, detail('normalizeLimitBoundaries')));

  const policyPath = path.join(dir, 'policy.json');
  const policyText = await fs.readFile(policyPath, 'utf8').catch(() => null);
  let policy = null, parseError = '';
  try { policy = JSON.parse(policyText); } catch (error) { parseError = String(error.message).slice(0, 200); }
  checks.push(check('policy.json stays valid JSON with approved values', 12,
    !!policy && policy.defaults?.concurrencyLimit === 6 && policy.defaults?.trace === true
    && policy.defaults?.retry?.maxAttempts === 2 && policy.queues?.default?.name === 'primary' && policy.version === 1,
    policy ? `concurrencyLimit=${policy.defaults?.concurrencyLimit}, trace=${policy.defaults?.trace}` : `JSON parse failed: ${parseError}`));

  for (const rel of ['src/limits.mjs', 'src/budget.mjs']) {
    const currentText = await fs.readFile(path.join(dir, rel), 'utf8');
    const originalText = await fs.readFile(path.join(fixtureDir, rel), 'utf8');
    checks.push(...formatChecks(rel, currentText, originalText));
  }

  return { checks };
}
