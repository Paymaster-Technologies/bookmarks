import { getEnvironment } from '../lib/environments.js';
import { createApi, ApiError } from '../lib/api.js';
import { bookmarksFromWidget } from '../lib/widgets.js';
import { planSync, applyPlan, ApplyError } from '../lib/mirror.js';
import { getAuth, getEnvironmentId, getPanel, patchPanel } from '../lib/storage.js';
import { pickBookmarksBar } from '../lib/browser.js';
import { humanError } from '../lib/errors.js';

const ROOT_TITLE = 'Memo';
const CONCURRENCY = 4;

/** Wraps chrome.bookmarks in the shape lib/mirror.js expects. */
const bookmarksApi = {
  create: (node) => chrome.bookmarks.create(node),
  update: (id, changes) => chrome.bookmarks.update(id, changes),
  remove: (id) => chrome.bookmarks.remove(id),
};

export async function hasBookmarksPermission() {
  return chrome.permissions.contains({ permissions: ['bookmarks'] });
}

/** Bookmarks bar node; the selection logic lives in lib/browser.js. */
async function bookmarksBarId() {
  const [root] = await chrome.bookmarks.getTree();
  return pickBookmarksBar((root && root.children) || []);
}

/** Existing subtree of the Memo folder, or null if it is gone. */
async function readRoot(rootId) {
  if (!rootId) return null;
  try {
    const [subtree] = await chrome.bookmarks.getSubTree(rootId);
    return subtree || null;
  } catch {
    return null; // the user deleted the folder
  }
}

/**
 * Keeps only the map entries whose nodes actually exist in the tree.
 *
 * This is what makes the mirror self-healing: a bookmark the user deleted by
 * hand drops out of the map and ends up in the plan as a creation.
 */
function reconcileMaps(subtree, panel) {
  const alive = new Set();
  const titles = new Map();
  const urls = new Map();
  const walk = (node) => {
    alive.add(node.id);
    titles.set(node.id, node.title);
    if (node.url) urls.set(node.id, node.url);
    for (const child of node.children || []) walk(child);
  };
  walk(subtree);

  const folders = {};
  for (const [widgetId, folder] of Object.entries(panel.folders || {})) {
    if (!alive.has(folder.chromeId)) continue;
    folders[widgetId] = { chromeId: folder.chromeId, title: titles.get(folder.chromeId) };
  }

  const nodes = {};
  for (const [memoId, node] of Object.entries(panel.nodes || {})) {
    if (!alive.has(node.chromeId)) continue;
    // The widget folder is gone, so treat the bookmark as missing: the plan
    // will recreate it
    if (!folders[node.widgetId]) continue;
    nodes[memoId] = {
      chromeId: node.chromeId,
      title: titles.get(node.chromeId),
      url: urls.get(node.chromeId),
      widgetId: node.widgetId,
    };
  }

  return { folders, nodes };
}

/** Fetches widgets in batches so we don't open twenty connections at once. */
async function loadDesired(api, widgetIds) {
  const desired = [];
  const missing = [];
  for (let index = 0; index < widgetIds.length; index += CONCURRENCY) {
    const chunk = widgetIds.slice(index, index + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (widgetId) => {
        try {
          return { widgetId, widget: await api.getWidget(widgetId) };
        } catch (error) {
          // 404 means the widget was deleted, 403 means access was revoked.
          // Both mean "this widget no longer exists for us"; anything else
          // aborts the sync
          if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
            return { widgetId, widget: null };
          }
          throw error;
        }
      }),
    );
    for (const { widgetId, widget } of results) {
      if (widget === null) {
        missing.push(widgetId);
        continue;
      }
      desired.push({
        widgetId: String(widgetId),
        title: String(widget.name || 'Без названия'),
        bookmarks: bookmarksFromWidget(widget),
      });
    }
  }
  return { desired, missing };
}

/**
 * Message about folders that stayed on the bar despite the plan.
 *
 * An empty string won't do instead of null: the popup checks for null to tell
 * "no error".
 */
function keptMessage(kept) {
  if (!kept || kept.length === 0) return null;
  const names = kept.filter(Boolean).map((title) => `«${title}»`).join(', ');
  return names
    ? `Папки ${names} остались на панели: внутри есть закладки, которых нет в Memo`
    : 'Папка осталась на панели: внутри есть закладки, которых нет в Memo';
}

let running = null;

/**
 * Brings the Memo folder in line with the selected widgets.
 *
 * In-memory lock: there are many triggers (timer, browser startup, saving a
 * bookmark, the button), they overlap, and a second pass on top of the first
 * would create duplicate folders. The service worker is single-threaded and
 * unloading it also aborts the sync, so an in-memory lock is enough.
 */
export function syncPanel() {
  if (running) return running;
  running = runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync() {
  let panel = await getPanel();
  if (!panel.enabled) return panel;
  if (!(await hasBookmarksPermission())) return panel;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return panel;

  const auth = await getAuth();
  if (!auth) return patchPanel({ orphaned: panel.rootId !== null });

  const environmentId = await getEnvironmentId();
  const api = createApi({ apiHost: getEnvironment(environmentId).apiHost, auth });

  // An empty widget list does not cancel the sync: the desired tree is then
  // empty, and the diff must remove folders left over from the previous
  // selection
  let desired;
  let missing;
  try {
    ({ desired, missing } = await loadDesired(api, panel.widgetIds));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return patchPanel({ orphaned: true, lastError: 'Сессия истекла' });
    }
    // Human-readable text, not error.message: the popup shows lastError as is.
    // The other lastError values here are in Russian too
    return patchPanel({ lastError: humanError(error) });
  }

  if (missing.length > 0) {
    const widgetIds = panel.widgetIds.filter((id) => !missing.includes(id));
    panel = await patchPanel({ widgetIds });
  }

  // Nothing to mirror and no folder — no reason to create one. Without this
  // check switching environments would give the user back an empty "Memo"
  // folder right after they answered "Delete": options.js sends
  // SET_PANEL_WIDGETS with an empty list, and the sync would recreate the root
  if (desired.length === 0 && !panel.rootId) {
    return patchPanel({ lastSyncAt: Date.now(), lastError: null, environmentId });
  }

  let rootId = panel.rootId;
  let subtree = await readRoot(rootId);
  if (subtree === null) {
    const parentId = await bookmarksBarId();
    // Without the bar there is nowhere to create the folder:
    // chrome.bookmarks.create without parentId would put it in "Other
    // bookmarks", where the user won't look for it
    if (parentId === null) {
      return patchPanel({ lastError: 'Не удалось найти панель закладок' });
    }
    const created = await chrome.bookmarks.create({ parentId, title: ROOT_TITLE });
    rootId = created.id;
    panel = await patchPanel({ rootId, folders: {}, nodes: {} });
    subtree = await readRoot(rootId);
  }

  // The folder was just created but could not be read — there is nothing to
  // read, and reconcileMaps would crash walking null. Syncing without a tree is
  // impossible anyway: exit with an error, the next pass will try again
  if (subtree === null) {
    return patchPanel({ lastError: 'Не удалось прочитать папку закладок' });
  }

  const actual = reconcileMaps(subtree, panel);
  const plan = planSync(desired, actual);

  // Write the maps after every operation: MV3 unloads the service worker not
  // only on exceptions, and nodes already created must not be lost
  const persist = (state) => patchPanel({ folders: state.folders, nodes: state.nodes });

  try {
    const state = await applyPlan(bookmarksApi, plan, { rootId, ...actual }, persist);
    return patchPanel({
      folders: state.folders,
      nodes: state.nodes,
      lastSyncAt: Date.now(),
      lastError: null,
      notice: keptMessage(state.kept),
      environmentId,
      orphaned: false,
    });
  } catch (error) {
    // Save the maps as of the failure anyway: some operations have already
    // changed the tree, and if we forgot them the next sync would create
    // duplicates
    const state = error instanceof ApplyError ? error.state : actual;
    // The chrome.bookmarks message is technical and often in English, but
    // humanError does not fit here: it talks about the server, while the
    // failure is local — in the browser's bookmark tree. Mention the server
    // only if it really is an ApiError
    const lastError = error instanceof ApiError
      ? humanError(error)
      : 'Не удалось записать папку закладок.';
    return patchPanel({
      folders: state.folders,
      nodes: state.nodes,
      lastError,
    });
  }
}

/** Deletes the whole Memo folder. Only on the user's explicit answer. */
export async function removePanelFolder() {
  const panel = await getPanel();
  if (panel.rootId && (await hasBookmarksPermission())) {
    try {
      await chrome.bookmarks.removeTree(panel.rootId);
    } catch {
      // the folder is already gone — goal achieved
    }
  }
  return patchPanel({ rootId: null, folders: {}, nodes: {}, orphaned: false });
}

/** Leaves the folder to the user and stops owning it. */
export function forgetPanelFolder() {
  return patchPanel({ rootId: null, folders: {}, nodes: {}, orphaned: false });
}
