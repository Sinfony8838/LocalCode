import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, stringifyCsv } from '../csv.mjs';

test('parses simple records and keeps whitespace', () => {
  assert.deepEqual(parseCsv('a,b,c'), [['a', 'b', 'c']]);
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCsv(' a , b '), [[' a ', ' b ']]);
});

test('quoted fields may contain delimiters, doubled quotes and newlines', () => {
  assert.deepEqual(parseCsv('"Smith, John","said ""hi"""'), [['Smith, John', 'said "hi"']]);
  assert.deepEqual(parseCsv('"l1\nl2",x'), [['l1\nl2', 'x']]);
});

test('empty fields and empty lines are preserved', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']]);
});

test('stringify quotes only when needed and round-trips', () => {
  const rows = [['a,b', 'plain', 'q"q'], ['n\nl'], ['']];
  const text = stringifyCsv(rows);
  assert.equal(text, '"a,b",plain,"q""q"\r\n"n\nl"\r\n""');
  assert.deepEqual(parseCsv(text), rows);
});
