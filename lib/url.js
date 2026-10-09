const SAVABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * A page name must start with a letter [a-zа-я] or a digit,
 * case-insensitive. The range а-я (U+0430..U+044F) does NOT include ё
 * (U+0451), and А-Я (U+0410..U+042F) does not include Ё (U+0401) — names
 * starting with "ё" are not accepted, so don't add it here.
 */
const PAGE_NAME_PATTERN = /^[a-zа-я0-9]/i;

function parse(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isSavableUrl(url) {
  const parsed = parse(url);
  return parsed !== null && SAVABLE_PROTOCOLS.has(parsed.protocol);
}

/**
 * Scheme and host are lowercased; the fragment and trailing slash are dropped.
 * The query is kept: for many sites it is part of the page's identity.
 */
export function normalizeUrl(url) {
  const parsed = parse(url);
  if (parsed === null) return '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

export function findDuplicate(bookmarks, url) {
  if (!Array.isArray(bookmarks)) return null;
  const target = normalizeUrl(url);
  if (target === '') return null;
  const found = bookmarks.find((bookmark) => normalizeUrl(bookmark && bookmark.url) === target);
  return found || null;
}

export function isValidPageName(name) {
  return typeof name === 'string' && PAGE_NAME_PATTERN.test(name);
}
