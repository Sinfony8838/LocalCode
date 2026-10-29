import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, nodeTest, protectedCheck, run, walk } from '../../../lib/common.mjs';

// Acceptance checks for REFACTOR_PLAN.md, driven through the public entry.
const HIDDEN_CASES = `
import * as marklet from WORKSPACE_INDEX;

const out = {};
const t_ = (name, fn) => { try { out[name] = Promise.resolve(fn()).then(v => v === true).catch(error => 'threw: ' + ((error && error.message) || error)); } catch (error) { out[name] = 'threw: ' + ((error && error.message) || error); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

t_('backwardsCompatibleRender', () => typeof marklet.render === 'function'
  && marklet.render('# Hello\\n\\nWorld **bold**') === '<h1>Hello</h1><p>World <strong>bold</strong></p>');
t_('exportsStable', () => ['render', 'parseBlocks', 'renderInline', 'escapeHtml'].every(name => typeof marklet[name] === 'function') && typeof marklet.createRenderer === 'function');
t_('createRendererParity', () => marklet.createRenderer().render('# t\\n\\np *i*') === marklet.render('# t\\n\\np *i*'));
t_('renderBlockChain', () => {
  const renderer = marklet.createRenderer();
  const calls = [];
  renderer.use({ name: 'wrap', hooks: { renderBlock: (block, ctx, next) => { calls.push('wrap'); return '<section>' + next() + '</section>'; } } });
  renderer.use({ name: 'skip-paragraphs', hooks: { renderBlock: (block, ctx, next) => { calls.push('skip'); if (block.type === 'paragraph') return '<p class="skipped">replaced</p>'; return next(); } } });
  const html = renderer.render('para\\n\\n# head');
  const expected = '<section><p class="skipped">replaced</p></section><section><h1>head</h1></section>';
  return html === expected && same(calls, ['wrap', 'skip', 'wrap', 'skip']);
});
t_('undefinedIsPassThrough', () => {
  const renderer = marklet.createRenderer();
  renderer.use({ name: 'noop', hooks: { beforeParse: () => undefined, afterParse: () => undefined, renderBlock: (b, c, next) => undefined, afterRender: () => undefined } });
  return renderer.render('# a\\n\\nb') === marklet.render('# a\\n\\nb');
});
t_('hookOrderRegistration', () => {
  const events = [];
  const make = name => ({ name, hooks: {
    beforeParse: md => { events.push(name + ':before'); return undefined; },
    afterParse: blocks => { events.push(name + ':afterParse'); return undefined; },
    afterRender: html => { events.push(name + ':afterRender'); return undefined; },
  } });
  const renderer = marklet.createRenderer({ plugins: [make('a')] });
  renderer.use(make('b'));
  renderer.render('x');
  return same(events, ['a:before', 'b:before', 'a:afterParse', 'b:afterParse', 'a:afterRender', 'b:afterRender']);
});
t_('beforeParseRewrites', () => {
  const renderer = marklet.createRenderer();
  renderer.use({ name: 'censor', hooks: { beforeParse: md => md.replaceAll('secret', 'safe') } });
  return renderer.render('a secret b') === '<p>a safe b</p>';
});
t_('afterRenderPostProcess', () => {
  const renderer = marklet.createRenderer();
  renderer.use({ name: 'suffix', hooks: { afterRender: html => html + '<!-- end -->' } });
  return renderer.render('x') === '<p>x</p><!-- end -->';
});
t_('afterParseReplacesBlocks', () => {
  const renderer = marklet.createRenderer();
  renderer.use({ name: 'drop-quotes', hooks: { afterParse: blocks => blocks.filter(block => block.type !== 'quote') } });
  return renderer.render('> q\\n\\nkeep') === '<p>keep</p>';
});
t_('useAfterCreate', () => {
  const renderer = marklet.createRenderer();
  const before = renderer.render('x');
  renderer.use({ name: 'late', hooks: { renderBlock: (block, ctx, next) => block.type === 'paragraph' ? '<p class="late">late</p>' : next() } });
  return before === '<p>x</p>' && renderer.render('x') === '<p class="late">late</p>';
});
t_('pluginValidation', () => {
  const renderer = marklet.createRenderer();
  const throwsType = fn => { try { fn(); return false; } catch (error) { return error instanceof TypeError; } };
  return throwsType(() => renderer.use(null)) && throwsType(() => renderer.use(42))
    && throwsType(() => renderer.use({ hooks: {} })) && throwsType(() => renderer.use({ name: 7 }))
    && throwsType(() => marklet.createRenderer({ plugins: [null] }));
});
t_('ctxExposesOptions', () => {
  const renderer = marklet.createRenderer({ flavor: 'test' });
  let seen = null;
  renderer.use({ name: 'peek', hooks: { afterRender: (html, ctx) => { seen = ctx.options; return undefined; } } });
  renderer.render('x');
  return seen && seen.flavor === 'test';
});
t_('freshCtxPerRender', () => {
  const renderer = marklet.createRenderer();
  const seen = [];
  renderer.use({ name: 'collect', hooks: { beforeParse: (md, ctx) => { seen.push(ctx); return undefined; } } });
  renderer.render('a');
  renderer.render('b');
  return seen.length === 2 && seen[0] !== seen[1];
});

out.combined = await Promise.all(Object.entries(out).map(async ([name, value]) => [name, await value])).then(entries => Object.fromEntries(entries));
console.log(JSON.stringify(out.combined));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const entry = path.join(dir, 'src', 'index.mjs');
  const entryExists = await fs.stat(entry).then(() => true, () => false);
  if (!entryExists) return { checks: [...checks, check('src/index.mjs exists', 90, false, 'missing src/index.mjs')] };

  const testFiles = (await walk(path.join(dir, 'test'))).map(file => `test/${file}`).filter(file => file.endsWith('.test.mjs'));
  const existing = testFiles.filter(file => baseline[file] !== undefined);
  const existingRun = nodeTest(dir, existing, 120_000);
  checks.push(check('all existing tests still pass unmodified', 8, existingRun.fail === 0 && existingRun.pass >= 12, `pass ${existingRun.pass}, fail ${existingRun.fail}: ${(existingRun.stderr || existingRun.stdout).split(/\r?\n/).filter(l => l.startsWith('not ok')).slice(0, 3).join('; ')}`));

  const script = HIDDEN_CASES.replace('WORKSPACE_INDEX', JSON.stringify(pathToFileURL(entry).href));
  const result = run(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, timeout: 60_000 });
  let r = {};
  try { r = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { moduleError: (result.stderr || 'acceptance suite produced no output').slice(0, 400) }; }
  const detail = key => typeof r[key] === 'string' ? r[key] : '';

  checks.push(check('render(markdown) output is byte-identical', 6, r.backwardsCompatibleRender === true, detail('backwardsCompatibleRender')));
  checks.push(check('export surface keeps the old names and adds createRenderer', 8, r.exportsStable === true, detail('exportsStable')));
  checks.push(check('createRenderer().render matches render()', 8, r.createRendererParity === true, detail('createRendererParity')));
  checks.push(check('renderBlock chains plugins then falls through to the builtin', 12, r.renderBlockChain === true, detail('renderBlockChain')));
  checks.push(check('hooks returning undefined are pass-through', 6, r.undefinedIsPassThrough === true, detail('undefinedIsPassThrough')));
  checks.push(check('hooks run in registration order', 10, r.hookOrderRegistration === true, detail('hookOrderRegistration')));
  checks.push(check('beforeParse rewrites the markdown source', 6, r.beforeParseRewrites === true, detail('beforeParseRewrites')));
  checks.push(check('afterRender post-processes the html', 6, r.afterRenderPostProcess === true, detail('afterRenderPostProcess')));
  checks.push(check('afterParse can replace the block list', 4, r.afterParseReplacesBlocks === true, detail('afterParseReplacesBlocks')));
  checks.push(check('use() registers plugins after creation', 6, r.useAfterCreate === true, detail('useAfterCreate')));
  checks.push(check('invalid plugins throw TypeError', 6, r.pluginValidation === true, detail('pluginValidation')));
  checks.push(check('ctx exposes renderer options and is fresh per render', 4, r.ctxExposesOptions === true && r.freshCtxPerRender === true, detail('ctxExposesOptions') || detail('freshCtxPerRender')));
  return { checks };
}
