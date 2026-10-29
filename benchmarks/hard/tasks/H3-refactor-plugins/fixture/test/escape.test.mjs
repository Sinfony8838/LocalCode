import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/escape.mjs';

test('escapes the five markup characters', () => {
  assert.equal(escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});
