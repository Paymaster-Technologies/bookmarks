import { isSavableUrl } from './url.js';

/**
 * Pure logic for mirroring Memo bookmarks into Chrome bookmarks.
 *
 * The module knows nothing about chrome.* or the Memo API: the planner works
 * with two plain snapshots, and the applier receives the bookmarks object as a
 * parameter — just as lib/api.js receives fetchImpl. Both are tested in Node
 * without a browser.
 */

/**
 * Computes the operations that bring the mirror to Memo's state.
 *
 * @param {Array<{widgetId: string, title: string, bookmarks: Array<{id: string, name: string, url: string}>}>} desired
 *   Desired tree: the selected widgets and their bookmarks.
 * @param {{folders: Object, nodes: Object}} actual
 *   Actual mirror state. The orchestrator must pass maps here that are
 *   already filtered against the real Chrome tree: a key missing from the
 *   tree must be missing here too. Self-healing relies on
 *   this — whatever the user deleted by hand, the diff creates
 *   again.
 * @returns {Array<Object>} operations in an order suitable for applying
 */
export function planSync(desired, actual) {
  const widgets = Array.isArray(desired) ? desired : [];
  const folders = (actual && actual.folders) || {};
  const nodes = (actual && actual.nodes) || {};

  const operations = [];
  const wantedWidgets = new Set(widgets.map((widget) => String(widget.widgetId)));

  // Where Memo thinks the bookmark should go: memoId → widgetId
  const wantedParent = new Map();
  for (const widget of widgets) {
    for (const bookmark of widget.bookmarks || []) {
      // A bookmark with a disallowed scheme is not "desired": if one is already
      // in the mirror from earlier versions, it must be removed, not kept
      if (!isSavableUrl(bookmark.url)) continue;
      wantedParent.set(String(bookmark.id), String(widget.widgetId));
    }
  }

  // 1. Bookmarks no longer in Memo, and bookmarks moved to another
  //    widget. A moved one is removed here and created below in its new place:
  //    no separate move operation is needed, and the "removals first" order
  //    guarantees no duplicate appears.
  for (const [memoId, node] of Object.entries(nodes)) {
    const parent = wantedParent.get(memoId);
    if (parent === undefined || parent !== String(node.widgetId)) {
      operations.push({ op: 'removeBookmark', chromeId: node.chromeId, memoId });
    }
  }

  // 2. Folders of widgets deselected or deleted in Memo
  for (const [widgetId, folder] of Object.entries(folders)) {
    if (!wantedWidgets.has(widgetId)) {
      operations.push({
        op: 'removeFolder',
        chromeId: folder.chromeId,
        widgetId,
        title: folder.title,
      });
    }
  }

  // 3. Folders: create missing ones, rename those that diverged
  for (const widget of widgets) {
    const widgetId = String(widget.widgetId);
    const folder = folders[widgetId];
    if (!folder) {
      operations.push({ op: 'createFolder', widgetId, title: widget.title });
    } else if (folder.title !== widget.title) {
      operations.push({ op: 'renameFolder', chromeId: folder.chromeId, title: widget.title });
    }
  }

  // 4. Bookmarks: create missing and moved ones, update changed ones.
  //    description is not mirrored — chrome.bookmarks has no such field.
  for (const widget of widgets) {
    const widgetId = String(widget.widgetId);
    for (const bookmark of widget.bookmarks || []) {
      // Second line of defense after bookmarksFromWidget: the planner need not
      // trust the caller, and the cost of a mistake is a javascript: bookmark
      // on the Chrome bar
      if (!isSavableUrl(bookmark.url)) continue;
      const memoId = String(bookmark.id);
      const node = nodes[memoId];
      if (!node || String(node.widgetId) !== widgetId) {
        operations.push({
          op: 'createBookmark',
          widgetId,
          memoId,
          title: bookmark.name,
          url: bookmark.url,
        });
      } else if (node.title !== bookmark.name || node.url !== bookmark.url) {
        operations.push({
          op: 'updateBookmark',
          chromeId: node.chromeId,
          memoId,
          title: bookmark.name,
          url: bookmark.url,
        });
      }
    }
  }

  return operations;
}

/**
 * Plan application failure. Carries the maps as of the failure: some operations
 * have already changed the tree, and if they are forgotten, the next sync won't
 * find the created nodes and will create duplicates next to them.
 */
export class ApplyError extends Error {
  constructor(cause, state) {
    super(cause && cause.message ? cause.message : String(cause));
    this.name = 'ApplyError';
    this.cause = cause;
    this.state = state;
  }
}

/**
 * Applies the plan and returns the new mapping.
 *
 * @param {{create: Function, update: Function, remove: Function}} bookmarksApi
 *   Wrapper over chrome.bookmarks. Injected as a parameter so the module
 *   can be tested in Node.
 * @param {Array<Object>} plan operations from planSync
 * @param {{rootId: string, folders: Object, nodes: Object}} current
 * @returns {Promise<{folders: Object, nodes: Object}>}
 */
export async function applyPlan(bookmarksApi, plan, current, onProgress = null) {
  const rootId = current.rootId;
  const folders = { ...(current.folders || {}) };
  const nodes = { ...(current.nodes || {}) };
  const operations = Array.isArray(plan) ? plan : [];
  // Folders that could not be removed because of foreign content
  const kept = [];

  for (const operation of operations) {
    try {
      switch (operation.op) {
        case 'removeBookmark':
          await bookmarksApi.remove(operation.chromeId);
          delete nodes[operation.memoId];
          break;

        case 'removeFolder': {
          // remove, not removeTree. removeTree would wipe the folder with
          // everything in it, including bookmarks the user put there
          // themselves: they are not in the maps, so they don't belong to the
          // mirror and must not be touched. Our own bookmarks are already
          // removed by now — planSync puts removeBookmark before removeFolder —
          // so normally the folder is empty and remove succeeds. If it fails,
          // something foreign is left inside, and that is exactly the case
          // where deleting is not allowed.
          try {
            await bookmarksApi.remove(operation.chromeId);
          } catch {
            // The folder stays with the user, and the mirror stops owning it:
            // otherwise the next pass would try to remove it again and again
            kept.push(operation.title || '');
          }
          delete folders[operation.widgetId];
          for (const [memoId, node] of Object.entries(nodes)) {
            if (String(node.widgetId) === String(operation.widgetId)) delete nodes[memoId];
          }
          break;
        }

        case 'createFolder': {
          const created = await bookmarksApi.create({ parentId: rootId, title: operation.title });
          folders[operation.widgetId] = { chromeId: created.id, title: operation.title };
          break;
        }

        case 'renameFolder': {
          await bookmarksApi.update(operation.chromeId, { title: operation.title });
          for (const [widgetId, folder] of Object.entries(folders)) {
            if (folder.chromeId === operation.chromeId) {
              folders[widgetId] = { chromeId: operation.chromeId, title: operation.title };
            }
          }
          break;
        }

        case 'createBookmark': {
          const folder = folders[operation.widgetId];
          // No folder means createFolder did not run in this plan. A bookmark
          // can't be created without a parent: it would go to the bar root,
          // among the user's personal bookmarks, and the mirror would never
          // find it again.
          if (!folder) break;
          const created = await bookmarksApi.create({
            parentId: folder.chromeId,
            title: operation.title,
            url: operation.url,
          });
          nodes[operation.memoId] = {
            chromeId: created.id,
            title: operation.title,
            url: operation.url,
            widgetId: operation.widgetId,
          };
          break;
        }

        case 'updateBookmark':
          await bookmarksApi.update(operation.chromeId, {
            title: operation.title,
            url: operation.url,
          });
          nodes[operation.memoId] = {
            ...nodes[operation.memoId],
            chromeId: operation.chromeId,
            title: operation.title,
            url: operation.url,
          };
          break;

        default:
          break;
      }
    } catch (error) {
      throw new ApplyError(error, { folders, nodes, kept });
    }
    // Hand the maps out after every operation. MV3 unloads the service worker
    // not only on exceptions: if that happens mid-plan, the nodes already
    // created stay in the tree, and if we forgot them, the next pass would
    // create duplicates next to them.
    if (onProgress) await onProgress({ folders: { ...folders }, nodes: { ...nodes } });
  }

  return { folders, nodes, kept };
}
