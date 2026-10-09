import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMemoContent } from '../lib/memo.js';

test('a chunk goes into an empty memo as is', () => {
  assert.equal(appendMemoContent('', 'A new thought'), 'A new thought');
  assert.equal(appendMemoContent(null, 'A new thought'), 'A new thought');
  assert.equal(appendMemoContent(undefined, 'A new thought'), 'A new thought');
  // A whitespace-only memo counts as empty: it needs no separator
  assert.equal(appendMemoContent('   \n\n', 'A new thought'), 'A new thought');
});

test('a chunk is appended to a non-empty memo after a blank line', () => {
  // The memo is rendered as markdown: a single newline would merge
  // the new chunk into the previous paragraph
  assert.equal(appendMemoContent('Old', 'New'), 'Old\n\nNew');
});

test('an empty addition leaves the memo unchanged', () => {
  assert.equal(appendMemoContent('Old', ''), 'Old');
  assert.equal(appendMemoContent('Old', '   \n  '), 'Old');
  assert.equal(appendMemoContent('Old', null), 'Old');
  assert.equal(appendMemoContent('Old', undefined), 'Old');
});

test('the added chunk is trimmed, as is the tail of the existing text', () => {
  assert.equal(appendMemoContent('Old', '  New  '), 'Old\n\nNew');
  // Trailing spaces of the existing text would add up with the separator
  assert.equal(appendMemoContent('Old  ', 'New'), 'Old\n\nNew');
  // Leading indentation is part of the memo content, leave it alone
  assert.equal(appendMemoContent('  Old', 'New'), '  Old\n\nNew');
});

test('newlines inside the chunk are preserved', () => {
  assert.equal(appendMemoContent('Old', 'First\nSecond'), 'Old\n\nFirst\nSecond');
});

test('an empty memo plus an empty addition yields an empty string', () => {
  assert.equal(appendMemoContent('', ''), '');
  assert.equal(appendMemoContent(null, null), '');
});

test('trailing newlines of the existing text do not accumulate', () => {
  // A memo saved with a trailing newline would otherwise add it to the
  // separator: every append would insert one more blank line
  assert.equal(appendMemoContent('Old\n', 'New'), 'Old\n\nNew');
  assert.equal(appendMemoContent('Old\n\n', 'New'), 'Old\n\nNew');
  assert.equal(appendMemoContent('Old \n \n', 'New'), 'Old\n\nNew');
});
