/**
 * Side panel: tasks, memo and calendar in one place.
 *
 * The panel is a regular extension page and never hits the network itself:
 * everything goes through service worker messages, like the popup and options.
 * It has its own markup instead of reusing the popup: the popup lives for
 * seconds and opens for a single action, while the panel stays next to the
 * page and its state survives switching browser tabs.
 *
 * In Chrome the panel is opened by a button in the popup (chrome.sidePanel);
 * in Firefox, via the built-in "View → Sidebar" menu. Firefox has no
 * programmatic way to open the sidebar, so the popup button is hidden there.
 */
import { send } from '../shared/send.js';
import { humanError } from '../lib/errors.js';
import { $ } from './panel-common.js';
import { tasksTab } from './panel-tasks.js';
import { memoTab } from './panel-memo.js';
import { calendarTab } from './panel-calendar.js';

const TABS = {
  tasks: { button: 'tab-tasks', pane: 'pane-tasks', module: tasksTab },
  memo: { button: 'tab-memo', pane: 'pane-memo', module: memoTab },
  calendar: { button: 'tab-calendar', pane: 'pane-calendar', module: calendarTab },
};

const SECTIONS = ['section-auth', 'section-error', 'pane-tasks', 'pane-memo', 'pane-calendar'];

let activeTab = null;

function hideAll() {
  for (const id of SECTIONS) $(id).hidden = true;
}

function showLoading() {
  hideAll();
  $('loading').hidden = false;
}

function showError(message) {
  hideAll();
  $('loading').hidden = true;
  $('tabs').hidden = true;
  $('error-text').textContent = message;
  $('section-error').hidden = false;
}

const TAB_NAMES = Object.keys(TABS);

function renderTabs() {
  for (const [name, tab] of Object.entries(TABS)) {
    const selected = name === activeTab;
    const button = $(tab.button);
    button.classList.toggle('segmented__item--active', selected);
    button.setAttribute('aria-selected', String(selected));
    // Roving tabindex: Tab enters the tab bar once and lands on the current
    // tab, and arrows move between tabs — that's how any tablist works, and
    // three tab stops in a row would be redundant here
    button.tabIndex = selected ? 0 : -1;
  }
}

/**
 * Arrow keys, Home and End on the tab bar.
 *
 * role="tablist" promises screen readers exactly this kind of control: without
 * arrows the markup describes an interface that doesn't exist.
 */
function onTabsKeydown(event) {
  const shift = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  const jump = { Home: 0, End: TAB_NAMES.length - 1 }[event.key];
  let next = null;
  if (shift !== undefined) {
    const current = TAB_NAMES.indexOf(activeTab);
    next = TAB_NAMES[(current + shift + TAB_NAMES.length) % TAB_NAMES.length];
  } else if (jump !== undefined) {
    next = TAB_NAMES[jump];
  }
  if (next === null) return;
  event.preventDefault();
  switchTab(next)
    .then(() => {
      // Focus follows selection: otherwise the next arrow would start from a
      // button that is no longer active, and selection would skip a tab
      if (activeTab === next) $(TABS[next].button).focus();
    })
    .catch((error) => showError(humanError(error)));
}

/**
 * Shows a tab and, on first show, asks it to load.
 *
 * Loading is lazy: opening all three tabs at once would mean four requests
 * per panel show, of which the user needs only one.
 */
async function openTab(name) {
  showLoading();
  activeTab = name;
  renderTabs();
  try {
    await TABS[name].module.activate();
  } catch (error) {
    showError(humanError(error));
    return;
  }
  hideAll();
  $('loading').hidden = true;
  $('tabs').hidden = false;
  $(TABS[name].pane).hidden = false;
}

async function switchTab(name) {
  if (name === activeTab) return;
  // A tab with unsaved edits must not be left silently: the memo is saved
  // as a whole and only via the button
  if (activeTab !== null && !(await TABS[activeTab].module.canLeave())) return;
  await openTab(name);
  try {
    await send('PATCH_PANEL_UI', { activeTab: name });
  } catch {
    // Remembering the tab is a convenience; a failed write is no reason to show an error
  }
}

for (const [name, tab] of Object.entries(TABS)) {
  $(tab.button).addEventListener('click', () => {
    switchTab(name).catch((error) => showError(humanError(error)));
  });
}

$('tabs').addEventListener('keydown', onTabsKeydown);

$('connect').addEventListener('click', async () => {
  try {
    await send('OPEN_LOGIN_TAB');
  } catch (error) {
    showError(humanError(error));
  }
});

$('retry').addEventListener('click', () => {
  start().catch((error) => showError(humanError(error)));
});

/**
 * The session changed externally: logout from the popup, login on the site,
 * an expired token.
 *
 * The panel lives for hours and sends no requests until touched. Without this
 * subscription it would learn about a logout only on the next action — as an
 * inline error in the middle of a task list that still looks functional.
 *
 * The key is checked by name: the extension uses chrome.storage.local for
 * widget selection and panel settings too, and the panel must not restart on
 * every write there.
 */
let connected = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, 'auth')) return;
  const nowConnected = Boolean(changes.auth.newValue);
  if (nowConnected === connected) return;
  connected = nowConnected;
  // Loaded data belongs to the previous session, on both logout and login: the
  // account may have changed, and tabs load once and won't refresh themselves
  activeTab = null;
  for (const tab of Object.values(TABS)) tab.module.reset();
  if (nowConnected) {
    start().catch((error) => showError(humanError(error)));
    return;
  }
  hideAll();
  $('loading').hidden = true;
  $('tabs').hidden = true;
  $('section-auth').hidden = false;
});

async function start() {
  showLoading();
  $('tabs').hidden = true;
  // Only whether we're connected: the panel stays open for hours, and the
  // access token would sit in its page heap all that time
  const state = await send('GET_AUTH_STATE');
  // Stored for the storage listener: otherwise the first write to auth after
  // the panel loads would count as a session change and restart it
  connected = state.connected;
  if (!connected) {
    hideAll();
    $('loading').hidden = true;
    $('section-auth').hidden = false;
    return;
  }
  let ui = { activeTab: 'tasks' };
  try {
    ui = await send('GET_PANEL_UI');
  } catch {
    // A forgotten tab is no reason not to show the panel at all
  }
  const name = Object.prototype.hasOwnProperty.call(TABS, ui.activeTab) ? ui.activeTab : 'tasks';
  activeTab = null; // first show leaves nothing behind, nothing to ask about
  await openTab(name);
}

start().catch((error) => showError(humanError(error)));
