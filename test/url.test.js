import test from 'node:test';
import assert from 'node:assert/strict';
import { isSavableUrl, normalizeUrl, findDuplicate, isValidPageName } from '../lib/url.js';

test('only http and https can be saved', () => {
  assert.equal(isSavableUrl('https://example.com'), true);
  assert.equal(isSavableUrl('http://example.com'), true);
  assert.equal(isSavableUrl('chrome://extensions'), false);
  assert.equal(isSavableUrl('chrome-extension://abc/popup.html'), false);
  assert.equal(isSavableUrl('about:blank'), false);
  assert.equal(isSavableUrl('file:///tmp/a.html'), false);
  assert.equal(isSavableUrl(''), false);
  assert.equal(isSavableUrl(undefined), false);
  assert.equal(isSavableUrl('not a link'), false);
});

test('normalization lowercases scheme and host', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path'), 'https://example.com/Path');
});

test('normalization drops the fragment and trailing slash', () => {
  assert.equal(normalizeUrl('https://example.com/a/#section'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
});

test('normalization keeps the query — it matters for many sites', () => {
  assert.equal(
    normalizeUrl('https://example.com/watch?v=123'),
    'https://example.com/watch?v=123',
  );
});

test('normalizing an unparsable URL yields an empty string', () => {
  assert.equal(normalizeUrl('not a link'), '');
  assert.equal(normalizeUrl(undefined), '');
});

test('duplicate is found by normalized URL', () => {
  const bookmarks = [
    { id: 1, url: 'https://example.com/a/' },
    { id: 2, url: 'https://other.com' },
  ];
  assert.equal(findDuplicate(bookmarks, 'HTTPS://Example.com/a#top').id, 1);
  assert.equal(findDuplicate(bookmarks, 'https://example.com/b'), null);
});

test('duplicate lookup survives an empty or broken list', () => {
  assert.equal(findDuplicate(undefined, 'https://example.com'), null);
  assert.equal(findDuplicate([{ id: 1 }], 'https://example.com'), null);
});

test('page name must start with a letter or digit', () => {
  // The server requires the name to start with a letter or digit
  assert.equal(isValidPageName('Работа'), true);
  assert.equal(isValidPageName('2024 ссылки'), true);
  assert.equal(isValidPageName('  indent'), false);
  assert.equal(isValidPageName('-minus'), false);
  assert.equal(isValidPageName(''), false);
  assert.equal(isValidPageName(undefined), false);
  // The server-side а-я range does not include ё, so we exclude it here too
  assert.equal(isValidPageName('Ёлка'), false);
  assert.equal(isValidPageName('ёлка'), false);
  assert.equal(isValidPageName('Елка'), true);
});
