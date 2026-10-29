import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run } from '../../../lib/common.mjs';

// Hidden edge cases, executed against the workspace module. JSON.stringify
// comparison keeps the expected values readable and exact.
const HIDDEN_CASES = `
import { parseCsv, stringifyCsv } from MODULE_URL;
const out = {};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t_ = (name, fn) => { try { out[name] = fn() === true; } catch (error) { out[name] = 'threw ' + ((error && error.constructor && error.constructor.name) || error); } };
const throwsSyntax = fn => { try { fn(); return false; } catch (error) { return error instanceof SyntaxError; } };
const throwsRange = fn => { try { fn(); return false; } catch (error) { return error instanceof RangeError; } };

t_('basic', () => same(parseCsv('a,b,c'), [['a', 'b', 'c']]) && same(parseCsv('a'), [['a']]) && same(parseCsv(''), []));
t_('lineBreaks', () => same(parseCsv('a,b\\r\\nc,d'), [['a', 'b'], ['c', 'd']]) && same(parseCsv('a\\nb'), [['a'], ['b']]));
t_('trailingBreak', () => same(parseCsv('a\\n'), [['a']]) && same(parseCsv('a\\r\\n'), [['a']]) && same(parseCsv('a\\n\\n'), [['a'], ['']]));
t_('emptyLinesAndFields', () => same(parseCsv('a\\n\\nb'), [['a'], [''], ['b']]) && same(parseCsv('a,,c\\n,'), [['a', '', 'c'], ['', '']]));
t_('noTrim', () => same(parseCsv(' a , b '), [[' a ', ' b ']]));
t_('quotedCommaAndDoubled', () => same(parseCsv('"a,b",c'), [['a,b', 'c']]) && same(parseCsv('"a""b"'), [['a"b']]));
t_('quotedNewlinePreserved', () => same(parseCsv('"l1\\nl2",x'), [['l1\\nl2', 'x']]) && same(parseCsv('"a\\r\\nb"'), [['a\\r\\nb']]));
t_('emptyQuotedAndLiteral', () => same(parseCsv('""'), [['']]) && same(parseCsv('a,""'), [['a', '']]) && same(parseCsv('a"b'), [['a"b']]) && same(parseCsv('"a"b'), [['ab']]) && same(parseCsv('"a"b"c"'), [['ab"c"']]));
t_('bom', () => same(parseCsv('\\uFEFFa,b'), [['a', 'b']]));
t_('unterminatedThrows', () => throwsSyntax(() => parseCsv('"abc')) && throwsSyntax(() => parseCsv('a,"b')));
t_('delimiterOption', () => same(parseCsv('a;b', { delimiter: ';' }), [['a', 'b']]) && stringifyCsv([['a;b']], { delimiter: ';' }) === '"a;b"');
t_('delimiterValidation', () => throwsRange(() => parseCsv('a', { delimiter: ';;' })) && throwsRange(() => parseCsv('a', { delimiter: '"' })) && throwsRange(() => stringifyCsv([['a']], { delimiter: '\\n' })));
t_('stringifyExact', () => stringifyCsv([['a', 'b'], ['c']]) === 'a,b\\r\\nc' && stringifyCsv([['a,b', 'plain', 'q"q'], ['n\\nl'], ['x\\r']]) === '"a,b",plain,"q""q"\\r\\n"n\\nl"\\r\\n"x\\r"');
t_('stringifyEdges', () => stringifyCsv([[1, null, undefined, 'true']]) === '1,,,true' && stringifyCsv([['']]) === '""' && stringifyCsv([['', 'a']]) === ',a' && !stringifyCsv([['a'], ['b']]).endsWith('\\r\\n'));
t_('roundTrip', () => {
  const rows = [['a,b', 'q"q', 'n\\nl', '  sp  ', '', 'x\\rz'], [''], ['plain']];
  return same(parseCsv(stringifyCsv(rows)), rows);
});
console.log(JSON.stringify(out));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const impl = await fs.readFile(path.join(dir, 'csv.mjs'), 'utf8').catch(() => null);
  if (impl === null) return { checks: [...checks, check('csv.mjs exists', 90, false, 'csv.mjs not found')] };

  const visible = nodeTest(dir, ['test/csv.test.mjs']);
  checks.push(check('shipped tests pass unmodified', 8, visible.code === 0 && visible.fail === 0 && visible.pass >= 4, `pass ${visible.pass}, fail ${visible.fail}: ${(visible.stderr || visible.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES.replace('MODULE_URL', JSON.stringify(pathToFileURL(path.join(dir, 'csv.mjs')).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 20_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'hidden cases produced no output').slice(0, 400) }; }
  const detail = key => typeof r[key] === 'string' ? r[key] : '';

  checks.push(check('parses basic records, single fields and empty input', 6, r.basic === true, detail('basic')));
  checks.push(check('handles CRLF and LF record separators', 8, r.lineBreaks === true && r.trailingBreak === true, detail('lineBreaks') || detail('trailingBreak')));
  checks.push(check('empty lines become records; empty fields preserved', 8, r.emptyLinesAndFields === true, detail('emptyLinesAndFields')));
  checks.push(check('field whitespace is never trimmed', 3, r.noTrim === true, detail('noTrim')));
  checks.push(check('quoted fields hold delimiters and doubled quotes', 8, r.quotedCommaAndDoubled === true, detail('quotedCommaAndDoubled')));
  checks.push(check('line breaks inside quotes are preserved exactly', 8, r.quotedNewlinePreserved === true, detail('quotedNewlinePreserved')));
  checks.push(check('empty quoted fields and literal quote positions', 8, r.emptyQuotedAndLiteral === true, detail('emptyQuotedAndLiteral')));
  checks.push(check('leading BOM is ignored', 3, r.bom === true, detail('bom')));
  checks.push(check('unterminated quotes throw SyntaxError', 5, r.unterminatedThrows === true, detail('unterminatedThrows')));
  checks.push(check('custom delimiter works for parse and stringify', 4, r.delimiterOption === true, detail('delimiterOption')));
  checks.push(check('invalid delimiters throw RangeError', 3, r.delimiterValidation === true, detail('delimiterValidation')));
  checks.push(check('stringify output matches the spec exactly', 10, r.stringifyExact === true, detail('stringifyExact')));
  checks.push(check('stringify coercion, lone empty record and no trailing break', 8, r.stringifyEdges === true, detail('stringifyEdges')));
  checks.push(check('stringify → parse round-trips tricky rows', 8, r.roundTrip === true, detail('roundTrip')));
  return { checks };
}
