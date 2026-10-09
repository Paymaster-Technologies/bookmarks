import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectableWidgets,
  nextWidgetPosition,
  bookmarksFromWidget,
  isKnownWidgetType,
} from '../lib/widgets.js';

const widgets = [
  { id: 1, name: 'Links', widgettype: 'bookmarks', deleted: false, encrypted: false, position: 0 },
  { id: 2, name: 'Note', widgettype: 'memo', deleted: false, encrypted: false, position: 1 },
  { id: 3, name: 'Deleted', widgettype: 'bookmarks', deleted: true, encrypted: false, position: 2 },
  { id: 4, name: 'Secret', widgettype: 'bookmarks', deleted: false, encrypted: true, position: 5 },
  { id: 5, name: 'More', widgettype: 'bookmarks', deleted: false, encrypted: false, position: 3 },
  { id: 6, name: 'Tasks', widgettype: 'tasks', deleted: false, encrypted: false, position: 4 },
  { id: 7, name: 'Task archive', widgettype: 'tasks', deleted: true, encrypted: false, position: 2 },
  { id: 8, name: 'Hidden', widgettype: 'secretmemo', deleted: false, encrypted: true, position: 1 },
  { id: 9, name: 'Encrypted note', widgettype: 'memo', deleted: false, encrypted: true, position: 1 },
];

test('only unencrypted, non-deleted bookmark widgets remain', () => {
  assert.deepEqual(selectableWidgets(widgets).map((w) => w.id), [1, 5]);
});

test('widget type is a parameter, defaulting to bookmarks', () => {
  assert.deepEqual(selectableWidgets(widgets, 'bookmarks').map((w) => w.id), [1, 5]);
  assert.deepEqual(selectableWidgets(widgets, 'tasks').map((w) => w.id), [6]);
  assert.deepEqual(selectableWidgets(widgets, 'memo').map((w) => w.id), [2]);
});

test('secretmemo is not listed when memo is requested', () => {
  // It is a separate widget type:
  // it can't be written without X-Widget-Encryptpw, yet a substring match
  // would let it through
  assert.equal(selectableWidgets(widgets, 'memo').some((w) => w.id === 8), false);
  assert.deepEqual(selectableWidgets(widgets, 'secretmemo').map((w) => w.id), []);
});

test('deleted and encrypted widgets are filtered out for any type', () => {
  assert.equal(selectableWidgets(widgets, 'tasks').some((w) => w.id === 7), false);
  assert.equal(selectableWidgets(widgets, 'memo').some((w) => w.id === 9), false);
});

test('selection survives empty input', () => {
  assert.deepEqual(selectableWidgets(undefined), []);
  assert.deepEqual(selectableWidgets([]), []);
  assert.deepEqual(selectableWidgets(undefined, 'tasks'), []);
});

test('new widget position is max plus one across all page widgets', () => {
  // Count across all widgets, not just the selected ones: positions are
  // shared across the page
  assert.equal(nextWidgetPosition(widgets), 6);
});

test('on an empty page the new widget position is zero', () => {
  assert.equal(nextWidgetPosition([]), 0);
  assert.equal(nextWidgetPosition(undefined), 0);
});

test('non-numeric positions do not break the calculation', () => {
  assert.equal(nextWidgetPosition([{ position: null }, { position: '4' }]), 5);
  // Only a truthy non-numeric value reaches the Number.isFinite branch
  assert.equal(nextWidgetPosition([{ position: 'abc' }]), 1);
});

test('widget bookmarks are flattened with string ids', () => {
  const widget = {
    id: 7,
    bookmarks: [
      { id: 11, name: 'Figma', url: 'https://figma.com' },
      { id: 12, name: 'Dribbble', url: 'https://dribbble.com' },
    ],
  };
  assert.deepEqual(bookmarksFromWidget(widget), [
    { id: '11', name: 'Figma', url: 'https://figma.com' },
    { id: '12', name: 'Dribbble', url: 'https://dribbble.com' },
  ]);
});

test('a widget without bookmarks yields an empty list', () => {
  assert.deepEqual(bookmarksFromWidget({ id: 7 }), []);
  assert.deepEqual(bookmarksFromWidget({ id: 7, bookmarks: [] }), []);
  assert.deepEqual(bookmarksFromWidget(null), []);
  assert.deepEqual(bookmarksFromWidget(undefined), []);
});

test('a bookmark without a URL is skipped', () => {
  // Chrome treats a node without a url as a folder, so such a bookmark is
  // not copied
  const widget = {
    bookmarks: [
      { id: 1, name: 'No URL', url: '' },
      { id: 2, name: 'Spaces', url: '   ' },
      { id: 3, name: 'No field' },
      { id: 4, name: 'Live', url: 'https://example.com' },
    ],
  };
  assert.deepEqual(bookmarksFromWidget(widget), [
    { id: '4', name: 'Live', url: 'https://example.com' },
  ]);
});

test('a bookmark without a name is labeled with its URL', () => {
  // An empty title in chrome.bookmarks makes a nameless node you can't click
  assert.deepEqual(bookmarksFromWidget({ bookmarks: [{ id: 1, name: '', url: 'https://a.io' }] }), [
    { id: '1', name: 'https://a.io', url: 'https://a.io' },
  ]);
});

test('a bookmark with a disallowed scheme is skipped', () => {
  // Clicking a javascript: bookmark on the Chrome toolbar runs the script in
  // the active tab's context, and not only the owner can write to a widget
  const widget = {
    bookmarks: [
      { id: 1, name: 'Reports', url: 'javascript:alert(document.domain)' },
      { id: 2, name: 'Data', url: 'data:text/html,<script>alert(1)</script>' },
      { id: 3, name: 'File', url: 'file:///etc/passwd' },
      { id: 4, name: 'Live', url: 'https://example.com' },
    ],
  };
  assert.deepEqual(bookmarksFromWidget(widget), [
    { id: '4', name: 'Live', url: 'https://example.com' },
  ]);
});

test('only the three known types count as widget types', () => {
  assert.equal(isKnownWidgetType('bookmarks'), true);
  assert.equal(isKnownWidgetType('tasks'), true);
  assert.equal(isKnownWidgetType('memo'), true);
});

test('secretmemo and junk are not widget types', () => {
  // secretmemo is excluded on purpose: it can't be written without
  // X-Widget-Encryptpw
  assert.equal(isKnownWidgetType('secretmemo'), false);
  assert.equal(isKnownWidgetType('MEMO'), false);
  assert.equal(isKnownWidgetType(''), false);
  assert.equal(isKnownWidgetType(undefined), false);
  assert.equal(isKnownWidgetType(null), false);
  assert.equal(isKnownWidgetType('constructor'), false);
});
