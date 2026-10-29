import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck } from '../../../lib/common.mjs';
import { probeNote, runProbe } from '../../../lib/dom-probe.mjs';

// NOTE: inside this template literal, backticks and \\n are escaped so the
// generated scenario keeps its own JS string escapes.
const SCENARIO = `
const page = loadPage();
const r = {};
r.missingIds = ['editor', 'preview', 'word-count', 'save-note', 'btn-clear'].filter(id => !page.has(id));
r.hasAllIds = r.missingIds.length === 0;

const preview = () => page.el('preview');
const setMd = async md => { await page.setValue('editor', md); };

// headings
await setMd('# Title one');
r.h1 = !!preview().querySelector('h1') && preview().querySelector('h1').textContent === 'Title one';
await setMd('## Title two');
r.h2 = !!preview().querySelector('h2') && preview().querySelector('h2').textContent === 'Title two';
await setMd('### Title three');
r.h3 = !!preview().querySelector('h3') && preview().querySelector('h3').textContent === 'Title three';

// paragraphs: one non-empty line is one <p>, blank lines render nothing
await setMd('just a paragraph');
r.para = !!preview().querySelector('p') && preview().querySelector('p').textContent === 'just a paragraph';
await setMd('line one\\nline two');
r.twoParas = preview().querySelectorAll('p').length === 2;

// inline styles
await setMd('plain **bold** and *em* and \`code\` here');
r.bold = !!preview().querySelector('strong') && preview().querySelector('strong').textContent === 'bold';
r.italic = !!preview().querySelector('em') && preview().querySelector('em').textContent === 'em';
r.code = !!preview().querySelector('code') && preview().querySelector('code').textContent === 'code';
r.inlineInP = !!preview().querySelector('p') && preview().querySelector('p').textContent === 'plain bold and em and code here';

// unordered list: consecutive lines form ONE ul
await setMd('- one\\n- two\\n- three');
const ul = preview().querySelector('ul');
r.ul = !!ul && ul.querySelectorAll('li').length === 3 && ul.querySelectorAll('li')[0].textContent === 'one' && ul.querySelectorAll('li')[2].textContent === 'three';
r.ulSingle = preview().querySelectorAll('ul').length === 1;

// ordered list incl. multi-digit marker
await setMd('1. first\\n2. second\\n10. tenth');
const ol = preview().querySelector('ol');
r.ol = !!ol && ol.querySelectorAll('li').length === 3 && ol.querySelectorAll('li')[2].textContent === 'tenth';

// HTML is escaped, never parsed
await setMd('<b>raw</b> and <img src=x onerror="window.__pwned=1"> & <script>alert(1)</script>');
r.noRawElements = preview().querySelectorAll('b').length === 0 && preview().querySelectorAll('img').length === 0 && preview().querySelectorAll('script').length === 0;
r.literalText = preview().textContent.includes('<b>raw</b>');
r.noPwned = page.window.__pwned === undefined;

// combined document in source order
await setMd('# Plan\\n\\n## Steps\\n\\n- write spec\\n- test\\n\\n1. ship\\n2. rest\\n\\nThe **end**.');
const kidTags = preview().children.map(el => el.tagName).join(',');
r.combinedOrder = kidTags === 'H1,H2,UL,OL,P';
r.combinedLists = !!preview().querySelector('ul') && preview().querySelector('ul').querySelectorAll('li').length === 2 && !!preview().querySelector('ol') && preview().querySelector('ol').querySelectorAll('li').length === 2;
r.combinedInline = !!preview().querySelector('p strong') && preview().querySelector('p strong').textContent === 'end';

// word count
await setMd('');
r.words0 = page.text('word-count') === '0 words';
await setMd('hello world');
r.words2 = page.text('word-count') === '2 words';
await setMd('  one   two\\tthree\\n\\nfour  ');
r.words4 = page.text('word-count') === '4 words';

// clear
await setMd('some content');
await page.click('btn-clear');
r.cleared = page.el('editor').value === '' && preview().textContent.trim() === '' && page.text('word-count') === '0 words';

// save + restore after reload
await setMd('# Saved note\\n\\nwith **bold**');
await page.click('save-note');
const p2 = page.reload();
r.savedEditor = p2.el('editor').value === '# Saved note\\n\\nwith **bold**';
r.savedPreview = !!p2.el('preview').querySelector('h1') && !!p2.el('preview').querySelector('strong');
return r;
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return { checks: [...checks, check('index.html exists', 90, false, 'index.html not found')] };

  const r = await runProbe(SCENARIO, html);
  const note = probeNote(r);
  const ok = (name, weight, pass, extra = '') => checks.push(check(name, weight, !note && pass === true, note || (pass === true ? extra : `got ${JSON.stringify(pass)} ${extra}`.trim())));

  checks.push(check('required element ids present', 4, !note && r.hasAllIds === true, note || `missing: ${JSON.stringify(r.missingIds)}`));
  checks.push(check('renders h1/h2/h3 headings', 8, !note && r.h1 === true && r.h2 === true && r.h3 === true, note || `h1=${r.h1}, h2=${r.h2}, h3=${r.h3}`));
  checks.push(check('non-empty lines become paragraphs, blanks render nothing', 6, !note && r.para === true && r.twoParas === true, note || `para=${r.para}, twoParas=${r.twoParas}`));
  checks.push(check('renders **bold**, *italic* and `code` inline', 12, !note && r.bold === true && r.italic === true && r.code === true && r.inlineInP === true, note || `bold=${r.bold}, em=${r.italic}, code=${r.code}, text=${r.inlineInP}`));
  checks.push(check('consecutive "- " lines form one ul with li per line', 8, !note && r.ul === true && r.ulSingle === true, note || `ul=${r.ul}, single=${r.ulSingle}`));
  checks.push(check('ordered list supports multi-digit markers', 6, !note && r.ol === true, note || `got ${r.ol}`));
  checks.push(check('HTML in source is escaped, not parsed', 8, !note && r.noRawElements === true && r.literalText === true && r.noPwned === true, note || `noElements=${r.noRawElements}, literal=${r.literalText}`));
  checks.push(check('mixed document renders blocks in source order', 10, !note && r.combinedOrder === true && r.combinedLists === true && r.combinedInline === true, note || `order=${JSON.stringify(r.combinedOrder)}, lists=${r.combinedLists}, inline=${r.combinedInline}`));
  checks.push(check('word count uses exact "N words" wording on whitespace runs', 8, !note && r.words0 === true && r.words2 === true && r.words4 === true, note || `0→${JSON.stringify(r.words0)}, 2→${JSON.stringify(r.words2)}, 4→${JSON.stringify(r.words4)}`));
  checks.push(check('preview updates live without saving', 4, !note && r.h1 === true && r.combinedOrder === true, note || 'inferred from live render checks'));
  checks.push(check('clear empties editor, preview and count', 6, !note && r.cleared === true, note || `got ${r.cleared}`));
  checks.push(check('save persists to localStorage key note and restores after reload', 10, !note && r.savedEditor === true && r.savedPreview === true, note || `editor=${r.savedEditor}, preview=${r.savedPreview}`));
  return { checks };
}
