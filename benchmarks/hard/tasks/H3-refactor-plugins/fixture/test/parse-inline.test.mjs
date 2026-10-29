import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInline } from '../src/parse-inline.mjs';

test('inline rules compose on escaped text', () => {
  assert.equal(renderInline('**b** <i>'), '<strong>b</strong> &lt;i&gt;');
  assert.equal(renderInline('`a`'), '<code>a</code>');
  assert.equal(renderInline('[t](/x)'), '<a href="/x">t</a>');
});
