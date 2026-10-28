import { check, nodeTest, protectedCheck, run } from '../../lib/common.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CASES = [
  ['already a slug', ['already-a-slug'], 'already-a-slug'],
  ['upper case and digits', ['LocalCode 0.2.3 Released'], 'localcode-0-2-3-released'],
  ['German and French accents', ['Über Café Ångström'], 'uber-cafe-angstrom'],
  ['only punctuation', ['!!! ??? ---'], 'untitled'],
  ['custom fallback', ['***', { fallback: 'post' }], 'post'],
  ['default maxLength is 60', ['word '.repeat(20)], 'word-word-word-word-word-word-word-word-word-word-word-word'],
  ['single long word is cut exactly', ['abcdefghijklmnop', { maxLength: 5 }], 'abcde'],
  ['no trailing hyphen after truncation', ['ab cd ef', { maxLength: 6 }], 'ab-cd'],
  ['underscores and tabs', ['snake_case\tand\ttabs'], 'snake-case-and-tabs'],
  ['mixed CJK and Latin', ['LocalCode 本地 agent'], 'localcode-agent'],
];

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const visible = nodeTest(dir, ['test/slug.test.mjs']);
  checks.push(check('visible tests (5)', 40, visible.pass * 8, `pass ${visible.pass}, fail ${visible.fail}${visible.timedOut ? ', timed out' : ''}`));
  const script = `import { slugify } from ${JSON.stringify(pathToFileURL(path.join(dir, 'slug.mjs')).href)};
const cases = ${JSON.stringify(CASES)}; const out = {};
for (const [name, args, expected] of cases) { try { out[name] = slugify(...args) === expected; } catch { out[name] = false; } }
console.log(JSON.stringify(out));`;
  const hidden = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 20_000 });
  let results = {}; try { results = JSON.parse(hidden.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch {}
  for (const [name] of CASES) checks.push(check(`hidden: ${name}`, 5, results[name] === true));
  const manifest = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(path.join(dir, 'package.json'), 'utf8')).catch(() => '{}'));
  if (manifest.dependencies || manifest.devDependencies) checks.push(check('no third-party dependencies', 0, false, 'package.json declares dependencies'));
  return { checks };
}
