import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.mjs';

test('headings, paragraphs and blank lines', () => {
  assert.equal(render('# Title\ntext\n\nmore'), '<h1>Title</h1><p>text</p><p>more</p>');
  assert.equal(render('### deep'), '<h3>deep</h3>');
});

test('lists join consecutive dashes', () => {
  assert.equal(render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
});

test('code fences escape their content', () => {
  assert.equal(render('```\n<b>&\n```'), '<pre><code>&lt;b&gt;&amp;</code></pre>');
});

test('quotes become blockquotes', () => {
  assert.equal(render('> said'), '<blockquote><p>said</p></blockquote>');
});

test('inline emphasis, code and links', () => {
  assert.equal(render('**b** *i* `c`'), '<p><strong>b</strong> <em>i</em> <code>c</code></p>');
  assert.equal(render('[x](https://e.com)'), '<p><a href="https://e.com">x</a></p>');
  assert.equal(render('[x](javascript:void)'), '<p><a href="#invalid-href">x</a></p>');
});

test('html is escaped before inline rules', () => {
  assert.equal(render('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});

test('empty input renders empty output', () => {
  assert.equal(render(''), '');
  assert.equal(render('\n\n'), '');
});
