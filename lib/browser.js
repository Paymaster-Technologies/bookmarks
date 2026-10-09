/**
 * Browser differences that cannot be hidden behind a common API.
 *
 * There is intentionally no browser detection here: decisions are based on data
 * the browser itself returned. An "if Firefox" check breaks on the next
 * engine; a "does the node have folderType" check does not.
 */

/**
 * Bookmarks bar ids known per browser.
 *
 * 'toolbar_____' — Firefox, exactly five underscores; it is a fixed places
 * string, not a placeholder. '1' is the historical bookmarks bar id in Chrome.
 */
const KNOWN_BAR_IDS = ['toolbar_____', '1'];

/**
 * Picks the bookmarks bar node among the children of the bookmark tree root.
 *
 * The order of checks matters and goes from precise to coarse:
 *
 * 1. folderType === 'bookmarks-bar' — Chrome 134 and newer, the most reliable
 *    signal, because it describes the folder's role, not its number.
 * 2. Known id — covers Firefox and Chrome before 134.
 * 3. First child — the last resort.
 *
 * The "first child" fallback comes last for a reason. In Chrome the bookmarks
 * bar really is first, but in Firefox the bookmarks menu comes first, and the
 * bar is the second node. If this fallback came before the id check, in Firefox
 * the "Memo" folder would silently go into the bookmarks menu: no error, the
 * bookmarks are created, but the user doesn't see them.
 *
 * @param {Array<{id: string, folderType?: string}>} children children of the
 * root
 * @returns {string|null} bookmarks bar id, or null if there is nothing to pick
 * from
 */
export function pickBookmarksBar(children) {
  const nodes = Array.isArray(children) ? children.filter(Boolean) : [];

  const byType = nodes.find((node) => node.folderType === 'bookmarks-bar');
  if (byType) return byType.id;

  const byId = nodes.find((node) => KNOWN_BAR_IDS.includes(node.id));
  if (byId) return byId.id;

  return nodes.length > 0 ? nodes[0].id : null;
}
