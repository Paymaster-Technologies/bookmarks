import { getEnvironment } from '../lib/environments.js';
import { createApi, ApiError } from '../lib/api.js';
import { selectableWidgets, nextWidgetPosition, isKnownWidgetType } from '../lib/widgets.js';
import { sanitizeTasksForWidget } from '../lib/tasks.js';
import { oauthUrl, isOauthAvailable, isKnownProvider } from '../lib/oauth.js';
import {
  getAuth,
  setAuth,
  clearAuth,
  getEnvironmentId,
  getLastSelection,
  setLastSelection,
  getLastTaskSelection,
  setLastTaskSelection,
  getLastMemoSelection,
  setLastMemoSelection,
  getLastEntryType,
  setLastEntryType,
  getPanel,
  patchPanel,
  getPanelUi,
  patchPanelUi,
  DEFAULT_PANEL_UI,
  isWelcomeShown,
  setWelcomeShown,
  getPendingLoginTabId,
  setPendingLoginTabId,
  clearPendingLoginTabId,
} from '../lib/storage.js';
import {
  syncPanel,
  removePanelFolder,
  forgetPanelFolder,
  hasBookmarksPermission,
} from './bookmark-sync.js';

async function currentEnvironment() {
  return getEnvironment(await getEnvironmentId());
}

/** API client with tokens from storage. */
async function authorizedApi() {
  const env = await currentEnvironment();
  const auth = await getAuth();
  if (!auth) throw new ApiError(401, 'no tokens');
  return createApi({ apiHost: env.apiHost, auth });
}

/** API client without tokens. */
async function anonymousApi() {
  const env = await currentEnvironment();
  return createApi({ apiHost: env.apiHost, auth: null });
}

/**
 * The widget type is checked against the list instead of going into the request
 * body as is.
 *
 * The OAuth provider is checked the same way (lib/oauth.js): the caller is an
 * extension page, but its markup changes more often than the worker, and a typo
 * in the type should end in a clear error here, not in a widget of unknown kind
 * on the server.
 */
function assertWidgetType(widgettype) {
  if (isKnownWidgetType(widgettype)) return;
  throw new ApiError(0, `unknown widget type: ${widgettype}`);
}

const WELCOME_URL = 'welcome/welcome.html';

/**
 * Sends the tab to onboarding after the account is connected for the first
 * time.
 *
 * Only the tab the extension opened itself is used: the content script sends
 * TOKENS from every site page that holds tokens, and without this check
 * onboarding would pop up in the middle of normal work on the site.
 *
 * @param {number|null} tabId sender's tab, or null for a sign-in from the popup
 */
async function showWelcomeOnce(tabId) {
  // Clear before the check: otherwise, for a user who has already seen
  // onboarding, the tab record would hang around forever
  await clearPendingLoginTabId();
  if (await isWelcomeShown()) return;
  const url = chrome.runtime.getURL(WELCOME_URL);
  try {
    // A sign-in from the popup opened no tab — open a new one
    if (tabId === null) await chrome.tabs.create({ url });
    else await chrome.tabs.update(tabId, { url });
  } catch {
    return; // the tab is already closed — no reason to mark onboarding as shown
  }
  await setWelcomeShown();
}

const handlers = {
  /**
   * Whether an account is connected — without the tokens themselves.
   *
   * The popup and panel only need this fact, while an access-token handed out
   * would sit in the page heap for the page's whole lifetime. The popup lives
   * for seconds, but the side panel stays open next to the tab for hours.
   */
  async GET_AUTH_STATE() {
    return { connected: Boolean(await getAuth()) };
  },

  async GET_SITE_URL() {
    const env = await currentEnvironment();
    return { siteOrigin: env.siteOrigin, oauthAvailable: isOauthAvailable(env) };
  },

  async TOKENS({ accessToken, client, uid, origin }, sender) {
    const env = await currentEnvironment();
    if (origin !== env.siteOrigin) return null;
    const auth = { accessToken, client, uid, source: 'bridge' };
    await setAuth(auth);
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId !== null && tabId === (await getPendingLoginTabId())) {
      await showWelcomeOnce(tabId);
    }
    // Don't send tokens back: the sender is a content script on a site page,
    // and the response would land in its scope for no reason
    return null;
  },

  async OPEN_LOGIN_TAB() {
    const env = await currentEnvironment();
    const tab = await chrome.tabs.create({ url: `${env.siteOrigin}/ru/home` });
    await setPendingLoginTabId(tab.id);
    return null;
  },

  /**
   * Opens the provider's sign-in page. The provider is checked against the list
   * in lib/oauth.js — a string from the popup is never put into the URL
   * directly. The URL is built from env.oauthOrigin, not env.apiHost (see the
   * comment above ENVIRONMENTS).
   */
  async OPEN_OAUTH({ provider }) {
    const env = await currentEnvironment();
    const url = oauthUrl(env.oauthOrigin, provider);
    if (url === null) {
      const message = isKnownProvider(provider)
        ? 'provider sign-in is not available in this environment'
        : `unknown provider: ${provider}`;
      throw new ApiError(0, message);
    }
    const tab = await chrome.tabs.create({ url });
    await setPendingLoginTabId(tab.id);
    return null;
  },

  async SIGN_IN({ email, password }) {
    const api = await anonymousApi();
    const auth = await api.signIn(email, password);
    await setAuth(auth);
    // Signing in directly in the popup opened no tab — onboarding opens its own
    await showWelcomeOnce(null);
    // The popup needs only the fact of sign-in, not the tokens: it restarts
    // start() right away
    return null;
  },

  /** The "How to use" link in the popup: onboarding on demand. */
  async OPEN_WELCOME() {
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_URL) });
    return null;
  },

  /**
   * sign_out is called only for tokens issued to the extension itself. For
   * tokens taken from the site, the client is shared with the site, and
   * sign_out would log the user out there.
   */
  async SIGN_OUT() {
    const auth = await getAuth();
    if (auth && auth.source === 'password') {
      try {
        const api = await authorizedApi();
        await api.signOut();
      } catch {
        // signing out of the extension must not depend on the server being
        // reachable
      }
    }
    await clearAuth();
    return null;
  },

  async LOAD_PAGES() {
    const api = await authorizedApi();
    return api.getPages();
  },

  /**
   * widgettype comes from the caller; the default preserves the old payload:
   * the popup sends the message without this field and must keep getting
   * bookmarks.
   *
   * nextPosition is computed over all widgets of the page, not the filtered
   * ones: the position is shared, widgets of different types sit in the same
   * grid.
   */
  async LOAD_WIDGETS({ pageUniqid, widgettype = 'bookmarks' }) {
    assertWidgetType(widgettype);
    const api = await authorizedApi();
    const widgets = await api.getWidgets(pageUniqid);
    return {
      widgets,
      selectable: selectableWidgets(widgets, widgettype),
      nextPosition: nextWidgetPosition(widgets),
    };
  },

  async LOAD_WIDGET({ widgetId }) {
    const api = await authorizedApi();
    return api.getWidget(widgetId);
  },

  async CREATE_PAGE({ name }) {
    const api = await authorizedApi();
    return api.createPage(name);
  },

  /** The widgettype default is kept for the popup's old payload. */
  async CREATE_WIDGET({ pageUniqid, name, position, widgettype = 'bookmarks' }) {
    assertWidgetType(widgettype);
    const api = await authorizedApi();
    return api.createWidget({ pageUniqid, name, position, widgettype });
  },

  async SAVE_BOOKMARK({ widgetId, name, url, description }) {
    const api = await authorizedApi();
    const result = await api.createBookmark({ widgetId, name, url, description });
    // If the widget is mirrored, the bookmark should appear on the bar right
    // away, not on the timer. A sync error must not fail the save
    const panel = await getPanel();
    if (panel.enabled && panel.widgetIds.includes(String(widgetId))) {
      syncPanel().catch(() => {});
    }
    return result;
  },

  /**
   * Tasks of a widget, filtered by widget_id (see lib/tasks.js).
   */
  async LOAD_TASKS({ widgetId }) {
    const api = await authorizedApi();
    return sanitizeTasksForWidget(await api.getTasks(widgetId), widgetId);
  },

  async CREATE_TASK({ widgetId, name, description, position }) {
    const api = await authorizedApi();
    return api.createTask({ widgetId, name, description, position });
  },

  async UPDATE_TASK({ taskId, name, description, position }) {
    const api = await authorizedApi();
    return api.updateTask(taskId, { name, description, position });
  },

  async DELETE_TASK({ taskId }) {
    const api = await authorizedApi();
    return api.deleteTask(taskId);
  },

  /** The only way to toggle the flag: UPDATE_TASK does not change it. */
  async SET_TASK_FINISHED({ taskId, finished }) {
    const api = await authorizedApi();
    return api.setTaskFinished(taskId, Boolean(finished));
  },

  /** memoId is the note id: it lives inside a memo widget, it is not the widget id. */
  async LOAD_MEMO({ memoId }) {
    const api = await authorizedApi();
    return api.getMemo(memoId);
  },

  async SAVE_MEMO({ memoId, content }) {
    const api = await authorizedApi();
    return api.updateMemo(memoId, content);
  },

  async LOAD_CALENDAR_EVENTS() {
    const api = await authorizedApi();
    return api.getCalendarEvents();
  },

  /**
   * Events of a day, in the same shape as LOAD_CALENDAR_EVENTS.
   *
   * eventdate is prepared by eventDateForDay: a local date with offset, not
   * UTC.
   */
  async LOAD_CALENDAR_DAY({ eventdate }) {
    const api = await authorizedApi();
    const result = await api.getCalendarEventsByDate(eventdate);
    return (result && result.events) || [];
  },

  async CREATE_CALENDAR_EVENT({
    eventdate,
    startTime,
    duration,
    prenotificationTime,
    eventtype,
    name,
    description,
  }) {
    const api = await authorizedApi();
    return api.createCalendarEvent({
      eventdate,
      startTime,
      duration,
      prenotificationTime,
      eventtype,
      name,
      description,
    });
  },

  async DELETE_CALENDAR_EVENT({ id }) {
    const api = await authorizedApi();
    return api.deleteCalendarEvent(id);
  },

  async GET_CALENDAR_SETTINGS() {
    const api = await authorizedApi();
    return api.getCalendarSettings();
  },

  async GET_SITE_META({ url }) {
    try {
      const api = await authorizedApi();
      const meta = await api.getSiteMeta(url);
      if (!meta || meta.state === 1) return null;
      return { description: meta.description || '' };
    } catch {
      return null;
    }
  },

  async GET_SELECTION() {
    return getLastSelection();
  },

  async SET_SELECTION({ pageUniqid, widgetId }) {
    await setLastSelection({ pageUniqid, widgetId });
    return null;
  },

  /** Each type has its own widget selection — a shared key would reset the other. */
  async GET_TASK_SELECTION() {
    return getLastTaskSelection();
  },

  async SET_TASK_SELECTION({ pageUniqid, widgetId }) {
    await setLastTaskSelection({ pageUniqid, widgetId });
    return null;
  },

  async GET_MEMO_SELECTION() {
    return getLastMemoSelection();
  },

  async SET_MEMO_SELECTION({ pageUniqid, widgetId }) {
    await setLastMemoSelection({ pageUniqid, widgetId });
    return null;
  },

  async GET_ENTRY_TYPE() {
    return getLastEntryType();
  },

  async SET_ENTRY_TYPE({ type }) {
    await setLastEntryType(type);
    return null;
  },

  async GET_PANEL_UI() {
    return getPanelUi();
  },

  /**
   * The patch is filtered by DEFAULT_PANEL_UI: a key invented by a future UI
   * version would otherwise stay in storage forever — nothing would clean it
   * up. undefined is dropped separately, otherwise a partial patch would
   * overwrite the other fields.
   */
  async PATCH_PANEL_UI(patch) {
    const safe = {};
    for (const key of Object.keys(DEFAULT_PANEL_UI)) {
      if (patch[key] !== undefined) safe[key] = patch[key];
    }
    return patchPanelUi(safe);
  },

  async GET_PANEL() {
    return { ...(await getPanel()), hasPermission: await hasBookmarksPermission() };
  },

  /**
   * The bookmarks permission is not requested here: chrome.permissions.request
   * works only from a user gesture on an extension page. The popup calls it
   * and sends the decision already made here.
   */
  async SET_PANEL_ENABLED({ enabled }) {
    const panel = await patchPanel({ enabled: Boolean(enabled), lastError: null });
    if (panel.enabled) {
      await schedule();
      await syncPanel();
    } else {
      await chrome.alarms.clear(ALARM_PANEL_SYNC);
    }
    return getPanel();
  },

  async SET_PANEL_WIDGETS({ widgetIds }) {
    await patchPanel({ widgetIds: (widgetIds || []).map(String), lastError: null });
    await syncPanel();
    return getPanel();
  },

  async SYNC_PANEL() {
    await syncPanel();
    return getPanel();
  },

  async REMOVE_PANEL_FOLDER() {
    return removePanelFolder();
  },

  async FORGET_PANEL_FOLDER() {
    return forgetPanelFolder();
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // hasOwnProperty, not handlers[type]: a type like "constructor" or "toString"
  // would fetch a prototype method, the call would return a non-Promise, and
  // .then below would throw right in the listener — sendResponse would never be
  // called
  const type = message && message.type;
  const handler =
    typeof type === 'string' && Object.prototype.hasOwnProperty.call(handlers, type)
      ? handlers[type]
      : null;
  if (!handler) {
    sendResponse({
      ok: false,
      error: { status: 0, message: `unknown type: ${type}` },
    });
    return false;
  }
  handler(message.payload || {}, sender)
    .then((data) => sendResponse({ ok: true, data: data ?? null }))
    .catch(async (error) => {
      // 401 means the token is no longer valid — clear storage
      // so the popup shows the connect screen instead of endless errors
      if (error instanceof ApiError && error.status === 401) await clearAuth();
      sendResponse({
        ok: false,
        error: { status: error.status || 0, message: error.message || String(error) },
      });
    });
  return true;
});

const ALARM_PANEL_SYNC = 'panel-sync';
const PANEL_SYNC_MINUTES = 15;

/** Sets up periodic polling if the panel is enabled. */
async function schedule() {
  const panel = await getPanel();
  if (!panel.enabled) {
    await chrome.alarms.clear(ALARM_PANEL_SYNC);
    return;
  }
  await chrome.alarms.create(ALARM_PANEL_SYNC, { periodInMinutes: PANEL_SYNC_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PANEL_SYNC) syncPanel().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  schedule().then(() => syncPanel()).catch(() => {});
});

// Alarms survive a browser restart, but not an extension update
chrome.runtime.onInstalled.addListener(() => {
  schedule().catch(() => {});
});

// Sign-in abandoned halfway: the tab was closed before finishing. Without this
// cleanup the record would survive a browser restart and send to onboarding
// a random tab that Chrome gave the same id in the new session
chrome.tabs.onRemoved.addListener((tabId) => {
  getPendingLoginTabId()
    .then((pending) => (pending === tabId ? clearPendingLoginTabId() : null))
    .catch(() => {});
});

// Permission revoked in chrome://extensions — nothing left to sync with.
// Leave the folder alone: we can't delete bookmarks that aren't ours anymore.
chrome.permissions.onRemoved.addListener((permissions) => {
  if (!permissions.permissions || !permissions.permissions.includes('bookmarks')) return;
  patchPanel({ enabled: false }).then(() => chrome.alarms.clear(ALARM_PANEL_SYNC)).catch(() => {});
});
