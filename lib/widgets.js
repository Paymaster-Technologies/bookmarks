import { isSavableUrl } from './url.js';

/**
 * Widget types the extension works with.
 *
 * 'secretmemo' is excluded deliberately: it is a separate model with a required
 * X-Widget-Encryptpw header, encryption is out of
 * scope, and creating such a widget from the extension would give the
 * user a widget the extension itself cannot write to.
 */
export const WIDGET_TYPES = ['bookmarks', 'tasks', 'memo'];

/**
 * Checking the type against the list is the same protection as isKnownProvider
 * in lib/oauth.js: a string from markup must not reach the API request body as
 * is.
 */
export function isKnownWidgetType(widgettype) {
  return WIDGET_TYPES.includes(widgettype);
}

/**
 * A widget is writable if it is alive, of the right type and not encrypted.
 * An encrypted widget cannot be written without the X-Widget-Encryptpw header,
 * and encryption is out of scope for the first version.
 *
 * The type is compared by strict equality, not substring match: 'secretmemo'
 * is a separate widget type,
 * and must not end up in the list for a 'memo' request.
 *
 * The 'bookmarks' default preserves the behavior of calls written before notes
 * and tasks.
 *
 * @param {Array} widgets list of widgets
 * @param {'bookmarks'|'tasks'|'memo'} [widgettype] the required widget type
 */
export function selectableWidgets(widgets, widgettype = 'bookmarks') {
  if (!Array.isArray(widgets)) return [];
  return widgets.filter(
    (widget) =>
      widget &&
      widget.widgettype === widgettype &&
      widget.deleted !== true &&
      widget.encrypted !== true,
  );
}

export function nextWidgetPosition(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) return 0;
  const positions = widgets.map((widget) => Number((widget && widget.position) || 0));
  return Math.max(...positions.map((value) => (Number.isFinite(value) ? value : 0))) + 1;
}

/**
 * Flat list of a widget's bookmarks.
 *
 * Bookmarks inside a widget are flat: there are no nested folders.
 *
 * id is converted to a string: in the API response it is a number, while
 * chrome.bookmarks works with strings, and the mapping must use a single type,
 * otherwise the keys stop matching after serialization to chrome.storage.
 *
 * The scheme is checked by the same isSavableUrl as when saving from the popup.
 * chrome.bookmarks.create accepts javascript: URLs — these are regular
 * bookmarklets — and clicking such a bookmark runs a script in the context of
 * the active tab. The data comes from the server, and not only the owner can
 * write to a widget but also anyone it is shared with: without the filter,
 * someone else's bookmark would get code execution on any site the user has
 * open.
 */
export function bookmarksFromWidget(widget) {
  const bookmarks = widget && widget.bookmarks;
  if (!Array.isArray(bookmarks)) return [];
  return bookmarks
    .filter((bookmark) => bookmark && isSavableUrl(bookmark.url))
    .map((bookmark) => ({
      id: String(bookmark.id),
      name: String(bookmark.name || '').trim() || bookmark.url,
      url: bookmark.url,
    }));
}
