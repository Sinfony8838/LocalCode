import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/parse-blocks.mjs';

test('block shapes', () => {
  assert.deepEqual(parseBlocks('# t'), [{ type: 'heading', level: 1, text: 't' }]);
  assert.deepEqual(parseBlocks('p'), [{ type: 'paragraph', text: 'p' }]);
  assert.deepEqual(parseBlocks('- a\n- b'), [{ type: 'list', items: ['a', 'b'] }]);
  assert.deepEqual(parseBlocks('```\ncode\n```'), [{ type: 'code', text: 'code' }]);
  assert.deepEqual(parseBlocks('> q'), [{ type: 'quote', text: 'q' }]);
  assert.deepEqual(parseBlocks(''), []);
});
