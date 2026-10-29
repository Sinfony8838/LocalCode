import test from 'node:test';
import assert from 'node:assert/strict';
import * as marklet from '../src/index.mjs';

test('the documented export names stay available', () => {
  for (const name of ['escapeHtml', 'parseBlocks', 'render', 'renderInline']) {
    assert.equal(typeof marklet[name], 'function', name);
  }
});

test('render is idempotent across calls', () => {
  assert.equal(marklet.render('# a'), '<h1>a</h1>');
  assert.equal(marklet.render('# a'), '<h1>a</h1>');
});
