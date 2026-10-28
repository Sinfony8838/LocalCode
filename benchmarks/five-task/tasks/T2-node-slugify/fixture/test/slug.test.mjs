import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../slug.mjs';

test('basic punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
test('diacritics and surrounding noise', () => assert.equal(slugify('  Crème Brûlée -- Recipe  '), 'creme-brulee-recipe'));
test('symbols collapse to one hyphen', () => assert.equal(slugify('C++ & Rust: 2026 edition'), 'c-rust-2026-edition'));
test('fallback when nothing usable remains', () => assert.equal(slugify('你好'), 'untitled'));
test('truncates on a hyphen boundary', () => assert.equal(slugify('one two three four', { maxLength: 12 }), 'one-two'));
