import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBookmarksBar } from '../lib/browser.js';

/** Root children in Chrome 134 and newer. */
const CHROME_NEW = [
  { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar' },
  { id: '2', title: 'Other bookmarks', folderType: 'other' },
  { id: '3', title: 'Mobile bookmarks', folderType: 'mobile' },
];

/** Root children in Chrome before 134: no folderType yet. */
const CHROME_OLD = [
  { id: '1', title: 'Bookmarks bar' },
  { id: '2', title: 'Other bookmarks' },
];

/** Root children in Firefox: the toolbar comes SECOND, the bookmarks menu first. */
const FIREFOX = [
  { id: 'menu________', title: 'Bookmarks menu' },
  { id: 'toolbar_____', title: 'Bookmarks bar' },
  { id: 'unfiled_____', title: 'Other bookmarks' },
  { id: 'mobile______', title: 'Mobile bookmarks' },
];

test('Chrome 134+: toolbar is found by folderType', () => {
  assert.equal(pickBookmarksBar(CHROME_NEW), '1');
});

test('old Chrome: toolbar is found by its historical id', () => {
  assert.equal(pickBookmarksBar(CHROME_OLD), '1');
});

test('Firefox: toolbar is found by id, not by position', () => {
  // The whole point of the module. Firefox lists the bookmarks MENU first, and
  // picking by position would put the "Memo" folder where the user won't see
  // it: there would be no error, bookmarks would be created, just elsewhere
  assert.equal(pickBookmarksBar(FIREFOX), 'toolbar_____');
});

test('folderType wins over a known id', () => {
  // A folder's role is more reliable than its id: if the browser reports it,
  // trust it
  const mixed = [
    { id: '1', title: 'Not the bar' },
    { id: '7', title: 'Bar', folderType: 'bookmarks-bar' },
  ];
  assert.equal(pickBookmarksBar(mixed), '7');
});

test('unfamiliar tree: take the first child', () => {
  assert.equal(pickBookmarksBar([{ id: 'x1' }, { id: 'x2' }]), 'x1');
});

test('nothing to pick from — null, not a made-up id', () => {
  // This used to be the constant '1'. In a browser without such a node it
  // would send chrome.bookmarks.create to a nonexistent parent
  assert.equal(pickBookmarksBar([]), null);
  assert.equal(pickBookmarksBar(undefined), null);
  assert.equal(pickBookmarksBar(null), null);
});

test('holes in the children list do not break the pick', () => {
  assert.equal(pickBookmarksBar([null, undefined, { id: 'toolbar_____' }]), 'toolbar_____');
});
