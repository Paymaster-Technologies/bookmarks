import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTaskPosition, openTasksCount, sanitizeTasksForWidget } from '../lib/tasks.js';

const tasks = [
  { id: 1, widget_id: 7, name: 'Buy tickets', position: 0, finished: false },
  { id: 2, widget_id: 7, name: 'Pack a suitcase', position: 1, finished: true },
  { id: 3, widget_id: 7, name: 'Book a taxi', position: 4, finished: null },
];

test('new task position is max plus one', () => {
  assert.equal(nextTaskPosition(tasks), 5);
});

test('in an empty list the new task position is zero', () => {
  assert.equal(nextTaskPosition([]), 0);
  assert.equal(nextTaskPosition(undefined), 0);
});

test('non-numeric positions do not break the calculation', () => {
  assert.equal(nextTaskPosition([{ position: null }, { position: '4' }]), 5);
  assert.equal(nextTaskPosition([{ position: 'abc' }]), 1);
});

test('gaps in positions are not collapsed — max is used, not task count', () => {
  // Two tasks, but the max position is 9: some in between were deleted.
  // Counting by length would give 2, and the new task would collide with an
  // existing one
  assert.equal(nextTaskPosition([{ position: 0 }, { position: 9 }]), 10);
});

test('negative positions are not clamped to zero', () => {
  // The server won't send this, but input is not validated — the function
  // must behave predictably rather than silently substitute zero
  assert.equal(nextTaskPosition([{ position: -5 }]), -4);
  assert.equal(nextTaskPosition([{ position: -5 }, { position: -1 }]), 0);
});

test('every task whose finished is not exactly true counts as open', () => {
  // finished may be null
  assert.equal(openTasksCount(tasks), 2);
  assert.equal(openTasksCount([{ finished: true }, { finished: true }]), 0);
  assert.equal(openTasksCount([{}, { finished: null }, { finished: false }]), 3);
});

test('open task counter survives empty input', () => {
  assert.equal(openTasksCount([]), 0);
  assert.equal(openTasksCount(undefined), 0);
});

test('filter keeps tasks of the requested widget', () => {
  assert.deepEqual(sanitizeTasksForWidget(tasks, 7).map((t) => t.id), [1, 2, 3]);
});

test('tasks of a different widget are dropped', () => {
  const otherWidget = [
    { id: 90, widget_id: 614, name: 'Task A' },
    { id: 91, widget_id: 614, name: 'Task B' },
  ];
  assert.deepEqual(sanitizeTasksForWidget(otherWidget, 7), []);
});

test('widget id is compared as a string — storage returns it as a string', () => {
  assert.equal(sanitizeTasksForWidget(tasks, '7').length, 3);
  assert.equal(sanitizeTasksForWidget([{ id: 1, widget_id: '7' }], 7).length, 1);
});

test('a task without widget_id does not pass the filter', () => {
  // widget_id is required to match
  assert.deepEqual(sanitizeTasksForWidget([{ id: 1, name: 'No widget' }], 7), []);
  assert.deepEqual(sanitizeTasksForWidget([{ id: 1, widget_id: null }], 7), []);
  assert.deepEqual(sanitizeTasksForWidget([null, undefined], 7), []);
});

test('filter survives empty input', () => {
  assert.deepEqual(sanitizeTasksForWidget(undefined, 7), []);
  assert.deepEqual(sanitizeTasksForWidget(null, 7), []);
  assert.deepEqual(sanitizeTasksForWidget([], 7), []);
});
