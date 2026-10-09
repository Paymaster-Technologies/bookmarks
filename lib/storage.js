import { DEFAULT_ENVIRONMENT_ID } from './environments.js';

const KEY_AUTH = 'auth';
const KEY_ENVIRONMENT = 'environmentId';
const KEY_SELECTION = 'lastSelection';

async function read(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key];
}

/**
 * Tokens from storage, or null if they are missing or incomplete.
 *
 * `source` is optional on purpose: only the three token fields are checked. An
 * object without `source` stays valid, and the sign-out path treats it as
 * 'bridge' — i.e. does not call the server sign_out. This is a safe default: a
 * token taken from the site shares `client` with the site itself, and revoking
 * it would log the user out there.
 *
 * @returns {Promise<{accessToken: string, client: string, uid: string, source?: 'bridge'|'password'}|null>}
 */
export async function getAuth() {
  const auth = await read(KEY_AUTH);
  if (!auth || !auth.accessToken || !auth.client || !auth.uid) return null;
  return auth;
}

export async function setAuth(auth) {
  await chrome.storage.local.set({ [KEY_AUTH]: auth });
}

export async function clearAuth() {
  await chrome.storage.local.remove(KEY_AUTH);
}

export async function getEnvironmentId() {
  return (await read(KEY_ENVIRONMENT)) || DEFAULT_ENVIRONMENT_ID;
}

export async function setEnvironmentId(id) {
  await chrome.storage.local.set({ [KEY_ENVIRONMENT]: id });
}

export async function getLastSelection() {
  return (await read(KEY_SELECTION)) || null;
}

export async function setLastSelection(selection) {
  await chrome.storage.local.set({ [KEY_SELECTION]: selection });
}

const KEY_WELCOME_SHOWN = 'welcomeShown';
const KEY_PENDING_LOGIN_TAB = 'pendingLoginTabId';

/** Whether onboarding has been shown. Shown once per install. */
export async function isWelcomeShown() {
  return (await read(KEY_WELCOME_SHOWN)) === true;
}

export async function setWelcomeShown() {
  await chrome.storage.local.set({ [KEY_WELCOME_SHOWN]: true });
}

const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;

/**
 * The tab the extension opened for sign-in.
 *
 * Kept in storage, not in worker memory: provider sign-in takes tens of
 * seconds, during which Chrome manages to unload the service worker, and a
 * variable would not survive the unload.
 */
export async function getPendingLoginTabId() {
  const value = await read(KEY_PENDING_LOGIN_TAB);
  if (!value || typeof value.tabId !== 'number') return null;
  // Chrome reassigns tab ids in every session, while the record survives
  // a browser restart. A stale record would send a random tab to onboarding
  // if it got the same id
  if (Date.now() - Number(value.at || 0) > PENDING_LOGIN_TTL_MS) return null;
  return value.tabId;
}

export async function setPendingLoginTabId(tabId) {
  await chrome.storage.local.set({ [KEY_PENDING_LOGIN_TAB]: { tabId, at: Date.now() } });
}

export async function clearPendingLoginTabId() {
  await chrome.storage.local.remove(KEY_PENDING_LOGIN_TAB);
}

const KEY_PANEL = 'panel';

/**
 * Bookmark mirror state.
 *
 * folders and nodes are a matching hint, not the source of truth. The truth
 * is always the actual chrome.bookmarks tree; before every diff the maps
 * are filtered against it. So a mismatch here doesn't break the mirror, it only
 * causes extra operations in a single sync.
 *
 * environmentId answers the question "whose data is in the folder now" and is
 * therefore stored separately from the global environment setting, which
 * answers "which environment is selected".
 */
export const DEFAULT_PANEL = {
  enabled: false,
  environmentId: null,
  widgetIds: [],
  rootId: null,
  folders: {},
  nodes: {},
  lastSyncAt: null,
  lastError: null,
  // Message from a successful sync that has something to say: e.g. a folder was
  // not removed because it contains someone else's items. Kept apart from
  // lastError — otherwise the popup would label it "Failed to update"
  notice: null,
  orphaned: false,
};

export async function getPanel() {
  return { ...DEFAULT_PANEL, ...((await read(KEY_PANEL)) || {}) };
}

export async function setPanel(panel) {
  await chrome.storage.local.set({ [KEY_PANEL]: panel });
}

let panelQueue = Promise.resolve();

/**
 * Partial update: reads, applies the patch, writes, returns the result.
 *
 * Writes are queued because this is read-modify-write. Applyplan saves the maps
 * after every operation, and without a queue toggling a switch in the popup in
 * the middle of a large sync could read the state before the maps were written
 * and write after, overwriting them. Exactly what incremental saving was
 * introduced for.
 *
 * One queue per module is enough: only the service worker writes the panel key,
 * the popup and the options page talk to it via messages.
 */
export function patchPanel(patch) {
  const run = panelQueue.then(async () => {
    const next = { ...(await getPanel()), ...patch };
    await setPanel(next);
    return next;
  });
  // A failed write must not stop the queue; the caller gets the error
  panelQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const KEY_TASK_SELECTION = 'lastTaskSelection';
const KEY_MEMO_SELECTION = 'lastMemoSelection';
const KEY_ENTRY_TYPE = 'lastEntryType';

/**
 * Last selected tasks widget — separate from lastSelection.
 *
 * Widgets of different types live in one page list, but selection among them
 * is independent: after saving a bookmark, the user still targets tasks at
 * their task list. A shared key would force re-selecting after every
 * tab switch.
 *
 * @returns {Promise<{pageUniqid: string, widgetId: number|string}|null>}
 */
export async function getLastTaskSelection() {
  return (await read(KEY_TASK_SELECTION)) || null;
}

export async function setLastTaskSelection(selection) {
  await chrome.storage.local.set({ [KEY_TASK_SELECTION]: selection });
}

/** Last selected notes widget — for the same reasons. */
export async function getLastMemoSelection() {
  return (await read(KEY_MEMO_SELECTION)) || null;
}

export async function setLastMemoSelection(selection) {
  await chrome.storage.local.set({ [KEY_MEMO_SELECTION]: selection });
}

const ENTRY_TYPES = ['bookmark', 'task', 'memo'];
const DEFAULT_ENTRY_TYPE = 'bookmark';

/**
 * Which tab the popup opens by default.
 *
 * The value is checked against the list on read, not only on write: the key may
 * be left over from an earlier extension version with a different set of types,
 * and an unknown type would leave the popup with no tab selected.
 *
 * @returns {Promise<'bookmark'|'task'|'memo'>}
 */
export async function getLastEntryType() {
  const type = await read(KEY_ENTRY_TYPE);
  return ENTRY_TYPES.includes(type) ? type : DEFAULT_ENTRY_TYPE;
}

export async function setLastEntryType(type) {
  if (!ENTRY_TYPES.includes(type)) return;
  await chrome.storage.local.set({ [KEY_ENTRY_TYPE]: type });
}

const KEY_PANEL_UI = 'panelUi';

/**
 * Side panel state.
 *
 * A key separate from panel: that one holds the bookmark mirror with its own
 * DEFAULT_PANEL, and extra fields in the same object would survive the spread
 * and leak into the mirror code. Different entities — different keys.
 */
export const DEFAULT_PANEL_UI = {
  activeTab: 'tasks',
};

export async function getPanelUi() {
  return { ...DEFAULT_PANEL_UI, ...((await read(KEY_PANEL_UI)) || {}) };
}

let panelUiQueue = Promise.resolve();

/**
 * Partial update of the panel state: reads, applies the patch, writes.
 *
 * Its own queue, like patchPanel and for the same reason: this is
 * read-modify-write, and two quick toggles in a row without a queue would read
 * the same state and write one after the other — the second would overwrite the
 * first.
 */
export function patchPanelUi(patch) {
  const run = panelUiQueue.then(async () => {
    const next = { ...(await getPanelUi()), ...patch };
    await chrome.storage.local.set({ [KEY_PANEL_UI]: next });
    return next;
  });
  panelUiQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
