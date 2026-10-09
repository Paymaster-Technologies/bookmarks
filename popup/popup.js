import { isSavableUrl, findDuplicate, isValidPageName } from '../lib/url.js';
import { send } from '../shared/send.js';
import { humanError } from '../lib/errors.js';
import { appendMemoContent } from '../lib/memo.js';

const SECTIONS = [
  'section-auth',
  'section-form',
  'section-task-quick',
  'section-memo-quick',
  'section-panel',
  'section-result',
  'section-error',
];

/**
 * Three quick-add forms and the switcher between them.
 *
 * The popup used to be covered entirely by a "This page can't be saved" screen,
 * which was only right for bookmarks: tasks and notes don't depend on the tab
 * URL at all. Now an unsavable page disables just one button out of three.
 */
const ENTRY_SECTIONS = {
  bookmark: 'section-form',
  task: 'section-task-quick',
  memo: 'section-memo-quick',
};

const ENTRY_BUTTONS = {
  bookmark: 'entry-bookmark',
  task: 'entry-task',
  memo: 'entry-memo',
};

const $ = (id) => document.getElementById(id);

/**
 * Enter in a field presses the button that submits that field.
 *
 * There's only one real <form> here (#password-form) — the other forms are
 * assembled from fields and buttons, and Enter did nothing in them. Adding a
 * <form> just for this won't do: in a popup, submitting reloads the page.
 *
 * isComposing is skipped: while typing CJK characters or dictating, Enter
 * confirms the choice in the input method editor rather than submitting.
 * A disabled button can't be pressed with Enter — otherwise the form would hit
 * the server at a moment when it considers itself not ready.
 *
 * @param {string} inputId field that listens for Enter
 * @param {string} buttonId button that this Enter presses
 */
function submitOnEnter(inputId, buttonId) {
  $(inputId).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const button = $(buttonId);
    if (button.disabled) return;
    event.preventDefault();
    button.click();
  });
}

function show(sectionId) {
  $('loading').hidden = true;
  for (const id of SECTIONS) $(id).hidden = id !== sectionId;
  // The switcher belongs to all three forms and so lives outside SECTIONS.
  // It has no business on the sign-in, result, error and bookmarks-bar screens
  const onEntryForm = Object.values(ENTRY_SECTIONS).includes(sectionId);
  $('entry-types').hidden = !onEntryForm;
  // Why "Bookmark" is unavailable. A visible caption rather than a tooltip:
  // the browser doesn't send mouse events to disabled controls, and title on
  // them isn't shown at all
  $('entry-note').hidden = !onEntryForm || state.savable;
}

function showLoading() {
  $('loading').hidden = false;
  $('entry-types').hidden = true;
  $('entry-note').hidden = true;
  for (const id of SECTIONS) $(id).hidden = true;
}

function showError(message) {
  $('error-text').textContent = message;
  show('section-error');
}

async function start() {
  showLoading();
  try {
    // Only the connection fact: the popup doesn't need tokens, and requesting them
    // would keep them in the page heap for as long as the popup is open
    const { connected } = await send('GET_AUTH_STATE');
    $('sign-out').hidden = !connected;
    $('open-panel').hidden = !connected;
    $('open-side-panel').hidden = !connected || !SIDE_PANEL_SUPPORTED;
    if (!connected) {
      // On environments without OAuth (oauthOrigin is null) the provider
      // buttons are hidden — email sign-in and the site link remain.
      let oauthAvailable = false;
      try {
        ({ oauthAvailable } = await send('GET_SITE_URL'));
      } catch {
        oauthAvailable = false;
      }
      $('login-google').hidden = !oauthAvailable;
      $('login-webmoney').hidden = !oauthAvailable;
      show('section-auth');
      return;
    }
    await openForm();
  } catch (error) {
    if (error.status === 401) $('sign-out').hidden = true;
    showError(humanError(error));
  }
}

$('connect').addEventListener('click', async () => {
  try {
    await send('OPEN_LOGIN_TAB');
    window.close();
  } catch (error) {
    showError(humanError(error));
  }
});

async function openOauth(provider) {
  try {
    await send('OPEN_OAUTH', { provider });
    window.close();
  } catch (error) {
    showError(humanError(error));
  }
}

$('login-google').addEventListener('click', () => openOauth('google_oauth2'));
$('login-webmoney').addEventListener('click', () => openOauth('webmoney'));

$('toggle-password-form').addEventListener('click', () => {
  const form = $('password-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('email').focus();
});

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('sign-in');
  const errorNode = $('password-error');
  errorNode.hidden = true;
  button.disabled = true;
  try {
    await send('SIGN_IN', { email: $('email').value.trim(), password: $('password').value });
    $('password').value = '';
    await start();
  } catch (error) {
    errorNode.textContent =
      error.status === 401 ? 'Неверный email или пароль.' : 'Не удалось войти.';
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('sign-out').addEventListener('click', async () => {
  try {
    // An unavailable worker must not lock the user into the account: the folder
    // question is a nicety, while sign-out must happen regardless
    const panel = await send('GET_PANEL');
    if (panel.rootId) {
      show('section-panel');
      $('panel-enabled').checked = panel.enabled;
      await askAboutFolder(
        'Выход из аккаунта. Удалить папку «Memo» с панели закладок вместе со ' +
          'всем, что внутри? Если оставить, она станет обычными закладками.',
      );
    }
  } catch {
    // leave the folder alone, but still let the user sign out
  }
  try {
    await send('SIGN_OUT');
    await start();
  } catch (error) {
    showError(humanError(error));
  }
});

$('open-help').addEventListener('click', async () => {
  try {
    await send('OPEN_WELCOME');
    window.close();
  } catch (error) {
    showError(humanError(error));
  }
});

$('retry').addEventListener('click', start);

/**
 * Only Chrome controls the side panel (MV3, since 114). In Firefox the
 * sidebar is declared via sidebar_action and opened from the browser menu —
 * there's no programmatic opening at all, and chrome.sidePanel doesn't exist.
 * This single check covers both cases: old Chrome and Firefox.
 */
const SIDE_PANEL_SUPPORTED =
  typeof chrome.sidePanel !== 'undefined' && typeof chrome.sidePanel.open === 'function';

const state = {
  tab: null,
  savable: false,
  entryType: 'bookmark',
  pages: [],
  widgets: [],
  duplicate: null,
  nextWidgetPosition: 0,
};

// Request counter: LOAD_WIDGETS/LOAD_WIDGET responses don't arrive in send
// order, and fast page switching (arrow keys on a closed select fire change
// on every press) keeps several requests in flight.
// A stale response must be dropped silently, not overwrite the state.
let requestToken = 0;

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function fillSelect(select, items, { value, label }) {
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item[value]);
    option.textContent = item[label];
    select.append(option);
  }
}

/**
 * Hides the whole select field, not just the <select>.
 *
 * The field has a label ("Tasks widget", "Notes widget"), and an empty select
 * left it dangling over nothing — a label for who knows what. The same function
 * in the side panel is called showWidgetField.
 */
function showFieldOf(select, visible) {
  const field = select.closest('.field') || select;
  field.hidden = !visible;
}

/** Reloads the widgets of the selected page and updates the select. */
async function reloadWidgets(pageUniqid, preferredWidgetId = null) {
  const token = ++requestToken;
  // The button is disabled before await: while widgets are loading, the select is
  // either empty (first open) or still holds a widget of the previous page — a
  // click at that moment would save the bookmark to the wrong place. It's
  // re-enabled below once a suitable widget is selected.
  $('save').disabled = true;
  // Widget creation buttons are disabled for the same reason as "Save":
  // state.nextWidgetPosition is updated only after the await below, and a click
  // in that window would create a widget with the previous page's position.
  $('add-widget').disabled = true;
  $('create-widget').disabled = true;
  const result = await send('LOAD_WIDGETS', { pageUniqid });
  if (token !== requestToken) return; // stale request, superseded by a newer one
  state.widgets = result.selectable;
  state.nextWidgetPosition = result.nextPosition;
  fillSelect($('widget'), state.widgets, { value: 'id', label: 'name' });
  if (state.widgets.length === 0) {
    $('save').disabled = true;
    $('add-widget').disabled = false;
    $('create-widget').disabled = false;
    showFieldOf($('widget'), false);
    $('form-error').textContent = 'На этой странице нет виджетов закладок. Создайте виджет.';
    $('form-error').hidden = false;
    return;
  }
  showFieldOf($('widget'), true);
  $('save').disabled = false;
  $('add-widget').disabled = false;
  $('create-widget').disabled = false;
  $('form-error').hidden = true;
  const preferred = state.widgets.find((widget) => String(widget.id) === String(preferredWidgetId));
  $('widget').value = String((preferred || state.widgets[0]).id);
  await refreshDuplicate();
}

/** Duplicates are searched only within the selected widget — its bookmarks already come with LOAD_WIDGET. */
async function refreshDuplicate() {
  const token = ++requestToken;
  state.duplicate = null;
  $('duplicate-note').hidden = true;
  $('save').textContent = 'Сохранить';
  const widgetId = $('widget').value;
  if (!widgetId) return;
  try {
    const widget = await send('LOAD_WIDGET', { widgetId });
    if (token !== requestToken) return; // stale request, superseded by a newer one
    state.duplicate = findDuplicate(widget && widget.bookmarks, $('url').value);
  } catch {
    return; // an unavailable check must not block saving
  }
  if (state.duplicate) {
    $('duplicate-note').hidden = false;
    $('save').textContent = 'Сохранить всё равно';
  }
}

/**
 * Entry point to the add forms: tab, pages and the last selected type.
 *
 * Pages are loaded here, once for all three forms: the list is shared, and
 * three LOAD_PAGES requests in a row for the same response would be wasteful.
 */
async function openForm() {
  showLoading();
  state.tab = await currentTab();
  state.savable = Boolean(state.tab && isSavableUrl(state.tab.url));

  state.pages = await send('LOAD_PAGES');
  if (state.pages.length === 0) {
    showError('У аккаунта нет ни одной страницы.');
    return;
  }

  let type = await send('GET_ENTRY_TYPE');
  // An unsavable page disables only the bookmark. The user's choice isn't
  // overwritten: it should come back on the next regular tab
  if (type === 'bookmark' && !state.savable) type = 'task';
  await openEntry(type);
}

function renderEntryTypes() {
  for (const [type, id] of Object.entries(ENTRY_BUTTONS)) {
    const button = $(id);
    const active = type === state.entryType;
    button.classList.toggle('segmented__item--active', active);
    // tab/aria-selected, not aria-pressed: the switcher picks one form out of
    // three, and the identical row in the panel is described exactly the same way
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  // aria-disabled, not disabled: a disabled button drops out of the tab order
  // and can't be read, yet we need to explain why the bookmark is unavailable
  $('entry-bookmark').setAttribute('aria-disabled', String(!state.savable));
}

/** Arrows, Home and End on the switcher — as in the side panel tab bar. */
function onEntryKeydown(event) {
  const names = Object.keys(ENTRY_BUTTONS);
  const shift = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  const jump = { Home: 0, End: names.length - 1 }[event.key];
  let next = null;
  if (shift !== undefined) {
    const current = names.indexOf(state.entryType);
    next = names[(current + shift + names.length) % names.length];
  } else if (jump !== undefined) {
    next = names[jump];
  }
  if (next === null) return;
  event.preventDefault();
  chooseEntry(next).then(() => $(ENTRY_BUTTONS[state.entryType]).focus());
}

/** Shows the form of the selected type and loads it if it isn't open yet. */
async function openEntry(type) {
  state.entryType = type;
  show(ENTRY_SECTIONS[type]);
  renderEntryTypes();
  if (type === 'bookmark') return openBookmarkForm();
  if (type === 'task') return openTaskQuick();
  return openMemoQuick();
}

/**
 * Switches the entry type and remembers the choice.
 *
 * An unavailable bookmark is filtered out here, not by a disabled button: the
 * button is marked aria-disabled and stays live for keyboard and screen reader.
 */
async function chooseEntry(type) {
  if (state.entryType === type) return;
  if (type === 'bookmark' && !state.savable) return;
  try {
    await openEntry(type);
    await send('SET_ENTRY_TYPE', { type });
  } catch (error) {
    showError(humanError(error));
  }
}

for (const [type, id] of Object.entries(ENTRY_BUTTONS)) {
  $(id).addEventListener('click', () => {
    chooseEntry(type);
  });
}

$('entry-types').addEventListener('keydown', onEntryKeydown);

let bookmarkReady = false;

async function openBookmarkForm() {
  if (bookmarkReady) return;
  $('name').value = state.tab.title || '';
  $('url').value = state.tab.url;
  $('description').value = '';

  fillSelect($('page'), state.pages, { value: 'uniqid', label: 'name' });

  const selection = await send('GET_SELECTION');
  const preferredPage =
    (selection && state.pages.find((page) => page.uniqid === selection.pageUniqid)) ||
    state.pages[0];
  $('page').value = preferredPage.uniqid;

  await reloadWidgets(preferredPage.uniqid, selection && selection.widgetId);
  // The flag is set last: a failed load must be retried the next time the
  // form opens rather than count as done — otherwise the form would stay
  // empty forever, with disabled buttons and no explanation
  bookmarkReady = true;

  // The description is fetched in the background: it can be slow
  send('GET_SITE_META', { url: state.tab.url })
    .then((meta) => {
      if (meta && meta.description && $('description').value === '') {
        $('description').value = meta.description;
      }
    })
    .catch(() => {});
}

$('page').addEventListener('change', async () => {
  try {
    await reloadWidgets($('page').value);
  } catch (error) {
    showError(humanError(error));
  }
});

$('widget').addEventListener('change', refreshDuplicate);
$('url').addEventListener('change', refreshDuplicate);

$('save').addEventListener('click', async () => {
  const button = $('save');
  const url = $('url').value.trim();
  if (!isSavableUrl(url)) {
    $('form-error').textContent = 'Укажите корректную ссылку http или https.';
    $('form-error').hidden = false;
    return;
  }
  button.disabled = true;
  try {
    await send('SAVE_BOOKMARK', {
      widgetId: $('widget').value,
      name: $('name').value.trim() || url,
      url,
      description: $('description').value.trim(),
    });
    await send('SET_SELECTION', { pageUniqid: $('page').value, widgetId: $('widget').value });
    $('result-text').textContent = 'Закладка сохранена.';
    show('section-result');
  } catch (error) {
    $('form-error').textContent = humanError(error);
    $('form-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('open-memo').addEventListener('click', async () => {
  try {
    const { siteOrigin } = await send('GET_SITE_URL');
    await chrome.tabs.create({ url: `${siteOrigin}/ru/home` });
    window.close();
  } catch (error) {
    showError(humanError(error));
  }
});

function toggle(id) {
  const node = $(id);
  node.hidden = !node.hidden;
  return node.hidden;
}

$('add-page').addEventListener('click', () => {
  if (!toggle('new-page')) $('new-page-name').focus();
});

$('add-widget').addEventListener('click', () => {
  if (!toggle('new-widget')) $('new-widget-name').focus();
});

$('create-page').addEventListener('click', async () => {
  const name = $('new-page-name').value.trim();
  const errorNode = $('new-page-error');
  errorNode.hidden = true;
  // The server requires the name to start with a letter or digit
  if (!isValidPageName(name)) {
    errorNode.textContent = 'Название должно начинаться с буквы или цифры (кроме «ё»).';
    errorNode.hidden = false;
    return;
  }
  const button = $('create-page');
  button.disabled = true;
  try {
    const page = await send('CREATE_PAGE', { name });
    state.pages.push(page);
    fillSelect($('page'), state.pages, { value: 'uniqid', label: 'name' });
    $('page').value = page.uniqid;
    $('new-page-name').value = '';
    $('new-page').hidden = true;
    await reloadWidgets(page.uniqid);
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('create-widget').addEventListener('click', async () => {
  const name = $('new-widget-name').value.trim();
  const errorNode = $('new-widget-error');
  errorNode.hidden = true;
  if (name === '') {
    errorNode.textContent = 'Укажите название виджета.';
    errorNode.hidden = false;
    return;
  }
  const button = $('create-widget');
  button.disabled = true;
  try {
    const widget = await send('CREATE_WIDGET', {
      pageUniqid: $('page').value,
      name,
      position: state.nextWidgetPosition || 0,
    });
    $('new-widget-name').value = '';
    $('new-widget').hidden = true;
    await reloadWidgets($('page').value, widget.id);
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/**
 * Quick task add.
 *
 * Its own page and widget selects, not shared with the bookmark form: widget
 * types differ, and a shared select would show bookmark lists in the task form.
 * Its own request counter — for the same reason as the bookmark form's, but
 * separate: a shared counter would cancel the neighboring form's responses.
 */
const quickTask = { ready: false, token: 0, widgets: [], nextWidgetPosition: 0 };

async function openTaskQuick() {
  if (quickTask.ready) return;
  fillSelect($('task-page'), state.pages, { value: 'uniqid', label: 'name' });
  const selection = await send('GET_TASK_SELECTION');
  const preferredPage =
    (selection && state.pages.find((page) => page.uniqid === selection.pageUniqid)) ||
    state.pages[0];
  $('task-page').value = preferredPage.uniqid;
  // The tab title is a sensible default, not an obligation: a regular field
  if ($('task-name').value === '') $('task-name').value = (state.tab && state.tab.title) || '';
  await reloadTaskWidgets(preferredPage.uniqid, selection && selection.widgetId);
  // The flag is set last — see the comment in openBookmarkForm
  quickTask.ready = true;
}

async function reloadTaskWidgets(pageUniqid, preferredWidgetId = null) {
  const token = ++quickTask.token;
  // Buttons are disabled before await for exactly the same reason as in the
  // bookmark form: while the list loads, the select is either empty or holds
  // a widget of the previous page
  $('task-save').disabled = true;
  $('task-add-widget').disabled = true;
  $('task-create-widget').disabled = true;
  const result = await send('LOAD_WIDGETS', { pageUniqid, widgettype: 'tasks' });
  if (token !== quickTask.token) return; // stale request, superseded by a newer one
  quickTask.widgets = result.selectable;
  quickTask.nextWidgetPosition = result.nextPosition;
  fillSelect($('task-widget'), quickTask.widgets, { value: 'id', label: 'name' });
  $('task-add-widget').disabled = false;
  $('task-create-widget').disabled = false;
  if (quickTask.widgets.length === 0) {
    showFieldOf($('task-widget'), false);
    $('task-hint').textContent = 'На этой странице нет виджетов дел. Создайте виджет.';
    $('task-hint').hidden = false;
    return;
  }
  showFieldOf($('task-widget'), true);
  $('task-hint').hidden = true;
  const preferred = quickTask.widgets.find(
    (widget) => String(widget.id) === String(preferredWidgetId),
  );
  $('task-widget').value = String((preferred || quickTask.widgets[0]).id);
  $('task-save').disabled = false;
}

$('task-page').addEventListener('change', async () => {
  try {
    await reloadTaskWidgets($('task-page').value);
  } catch (error) {
    showError(humanError(error));
  }
});

$('task-add-widget').addEventListener('click', () => {
  if (!toggle('task-new-widget')) $('task-new-widget-name').focus();
});

$('task-create-widget').addEventListener('click', async () => {
  const name = $('task-new-widget-name').value.trim();
  const errorNode = $('task-new-widget-error');
  errorNode.hidden = true;
  if (name === '') {
    errorNode.textContent = 'Укажите название виджета.';
    errorNode.hidden = false;
    return;
  }
  const button = $('task-create-widget');
  button.disabled = true;
  try {
    const widget = await send('CREATE_WIDGET', {
      pageUniqid: $('task-page').value,
      name,
      position: quickTask.nextWidgetPosition || 0,
      widgettype: 'tasks',
    });
    $('task-new-widget-name').value = '';
    $('task-new-widget').hidden = true;
    await reloadTaskWidgets($('task-page').value, widget && widget.id);
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('task-save').addEventListener('click', async () => {
  const name = $('task-name').value.trim();
  // The role="status" node always lives in the markup and is cleared by emptying:
  // a screen reader subscribes to an existing node, and one that appears along
  // with its text isn't always announced (see p[role="status"]:empty in popup.css)
  $('task-done').textContent = '';
  $('task-error').hidden = true;
  if (name === '') {
    $('task-error').textContent = 'Укажите название дела.';
    $('task-error').hidden = false;
    return;
  }
  const widgetId = $('task-widget').value;
  if (!widgetId) return;
  const button = $('task-save');
  button.disabled = true;
  try {
    await send('CREATE_TASK', {
      widgetId,
      name,
      description: $('task-description').value.trim(),
      // The popup has no task list and doesn't need one
      position: 0,
    });
    await send('SET_TASK_SELECTION', { pageUniqid: $('task-page').value, widgetId });
    // The form stays open and empty: tasks usually come several at a time, and
    // jumping to the result screen after each one would mean reopening the popup
    $('task-name').value = '';
    $('task-description').value = '';
    $('task-done').textContent = 'Дело добавлено.';
    $('task-name').focus();
  } catch (error) {
    $('task-error').textContent = humanError(error);
    $('task-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

/** Quick add to a note — built symmetrically to tasks. */
const quickMemo = { ready: false, token: 0, widgets: [], nextWidgetPosition: 0 };

async function openMemoQuick() {
  if (quickMemo.ready) return;
  fillSelect($('memo-page'), state.pages, { value: 'uniqid', label: 'name' });
  const selection = await send('GET_MEMO_SELECTION');
  const preferredPage =
    (selection && state.pages.find((page) => page.uniqid === selection.pageUniqid)) ||
    state.pages[0];
  $('memo-page').value = preferredPage.uniqid;
  if ($('memo-text').value === '' && state.savable) {
    $('memo-text').value = `${state.tab.title || ''}\n${state.tab.url}`.trim();
  }
  await reloadMemoWidgets(preferredPage.uniqid, selection && selection.widgetId);
  // The flag is set last — see the comment in openBookmarkForm
  quickMemo.ready = true;
}

async function reloadMemoWidgets(pageUniqid, preferredWidgetId = null) {
  const token = ++quickMemo.token;
  $('memo-save').disabled = true;
  $('memo-add-widget').disabled = true;
  $('memo-create-widget').disabled = true;
  const result = await send('LOAD_WIDGETS', { pageUniqid, widgettype: 'memo' });
  if (token !== quickMemo.token) return; // stale request, superseded by a newer one
  quickMemo.widgets = result.selectable;
  quickMemo.nextWidgetPosition = result.nextPosition;
  fillSelect($('memo-widget'), quickMemo.widgets, { value: 'id', label: 'name' });
  $('memo-add-widget').disabled = false;
  $('memo-create-widget').disabled = false;
  if (quickMemo.widgets.length === 0) {
    showFieldOf($('memo-widget'), false);
    $('memo-hint').textContent =
      'На этой странице нет виджетов заметок. Создайте виджет — пустую заметку ' +
      'сервер заведёт сам, отдельно её создать нельзя.';
    $('memo-hint').hidden = false;
    return;
  }
  showFieldOf($('memo-widget'), true);
  $('memo-hint').hidden = true;
  const preferred = quickMemo.widgets.find(
    (widget) => String(widget.id) === String(preferredWidgetId),
  );
  $('memo-widget').value = String((preferred || quickMemo.widgets[0]).id);
  $('memo-save').disabled = false;
}

/**
 * The note id lives INSIDE the widget and is not the widget id:
 * using the widget id would open the wrong note or get a 404.
 * The LOAD_WIDGET fallback covers a list without a nested memo.
 */
async function memoIdForWidget(widgetId) {
  const chosen = quickMemo.widgets.find((widget) => String(widget.id) === String(widgetId));
  const inline = chosen && chosen.memo;
  if (inline && inline.id !== undefined && inline.id !== null) return inline.id;
  const widget = await send('LOAD_WIDGET', { widgetId });
  const memo = widget && widget.memo;
  return memo && memo.id !== undefined && memo.id !== null ? memo.id : null;
}

$('memo-page').addEventListener('change', async () => {
  try {
    await reloadMemoWidgets($('memo-page').value);
  } catch (error) {
    showError(humanError(error));
  }
});

$('memo-add-widget').addEventListener('click', () => {
  if (!toggle('memo-new-widget')) $('memo-new-widget-name').focus();
});

$('memo-create-widget').addEventListener('click', async () => {
  const name = $('memo-new-widget-name').value.trim();
  const errorNode = $('memo-new-widget-error');
  errorNode.hidden = true;
  if (name === '') {
    errorNode.textContent = 'Укажите название виджета.';
    errorNode.hidden = false;
    return;
  }
  const button = $('memo-create-widget');
  button.disabled = true;
  try {
    const widget = await send('CREATE_WIDGET', {
      pageUniqid: $('memo-page').value,
      name,
      position: quickMemo.nextWidgetPosition || 0,
      widgettype: 'memo',
    });
    $('memo-new-widget-name').value = '';
    $('memo-new-widget').hidden = true;
    // Refetch the widget list to get the created widget with its memo
    await reloadMemoWidgets($('memo-page').value, widget && widget.id);
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('memo-save').addEventListener('click', async () => {
  const addition = $('memo-text').value.trim();
  $('memo-done').textContent = '';
  $('memo-error').hidden = true;
  if (addition === '') {
    $('memo-error').textContent = 'Напишите, что добавить в заметку.';
    $('memo-error').hidden = false;
    return;
  }
  const widgetId = $('memo-widget').value;
  if (!widgetId) return;
  const button = $('memo-save');
  button.disabled = true;
  try {
    const memoId = await memoIdForWidget(widgetId);
    if (memoId === null) {
      $('memo-error').textContent = 'У этого виджета нет заметки. Выберите другой.';
      $('memo-error').hidden = false;
      return;
    }
    // The memo is saved as a whole, so we read the current text, join it and
    // send everything back
    const memo = await send('LOAD_MEMO', { memoId });
    // api.js unwraps an empty response body to null, and without this check
    // appendMemoContent(undefined, …) would return just the appended piece, and
    // SAVE_MEMO would overwrite the whole note with it
    if (!memo || typeof memo.content !== 'string') {
      $('memo-error').textContent = 'Не удалось прочитать заметку, попробуйте ещё раз.';
      $('memo-error').hidden = false;
      return;
    }
    const content = appendMemoContent(memo.content, addition);
    await send('SAVE_MEMO', { memoId, content });
    await send('SET_MEMO_SELECTION', { pageUniqid: $('memo-page').value, widgetId });
    $('memo-text').value = '';
    $('memo-done').textContent = 'Добавлено в заметку.';
    $('memo-text').focus();
  } catch (error) {
    $('memo-error').textContent = humanError(error);
    $('memo-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

/**
 * The side panel is opened RIGHT HERE and synchronously.
 *
 * chrome.sidePanel.open requires a user gesture, and the gesture lasts only
 * until the first await: both a message to the service worker and
 * chrome.tabs.query would lose it, and the call would be rejected. So the tab
 * id comes from the state captured when the popup opened, not a new query.
 */
$('open-side-panel').addEventListener('click', () => {
  if (!SIDE_PANEL_SUPPORTED || !state.tab) return;
  Promise.resolve(chrome.sidePanel.open({ tabId: state.tab.id }))
    .then(() => window.close())
    .catch(() => {
      $('open-side-panel').textContent = 'Панель не открылась — откройте её из меню браузера';
    });
});

const panelState = { panel: null, pages: [], widgets: [] };

function formatAgo(timestamp) {
  if (!timestamp) return 'ещё не обновлялась';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'обновлена только что';
  if (minutes < 60) return `обновлена ${minutes} мин назад`;
  return `обновлена ${Math.round(minutes / 60)} ч назад`;
}

function renderPanelStatus() {
  const panel = panelState.panel;
  const chosen = panel.widgetIds.length;
  if (panel.lastError) {
    // lastError is already human-readable: bookmark-sync.js translates both
    // API errors and chrome.bookmarks failures
    $('panel-status').textContent = `Не удалось обновить: ${panel.lastError}`;
    return;
  }
  // notice isn't a failure: the sync succeeded but has something to report
  const base = `Выбрано виджетов: ${chosen} · ${formatAgo(panel.lastSyncAt)}`;
  $('panel-status').textContent = panel.notice ? `${base}. ${panel.notice}` : base;
}

function renderPanelWidgets() {
  const container = $('panel-widgets');
  container.innerHTML = '';
  for (const widget of panelState.widgets) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(widget.id);
    input.checked = panelState.panel.widgetIds.includes(String(widget.id));
    input.addEventListener('change', onWidgetToggle);
    const name = document.createElement('span');
    name.textContent = widget.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(widget.bookmarkscount ?? '');
    label.append(input, name, count);
    container.append(label);
  }
  $('panel-empty').hidden = panelState.widgets.length > 0;
}

async function onWidgetToggle(event) {
  const id = event.target.value;
  const chosen = new Set(panelState.panel.widgetIds);
  if (event.target.checked) chosen.add(id);
  else chosen.delete(id);
  event.target.disabled = true;
  try {
    panelState.panel = await send('SET_PANEL_WIDGETS', { widgetIds: [...chosen] });
  } catch (error) {
    event.target.checked = !event.target.checked;
    $('panel-status').textContent = humanError(error);
    return;
  } finally {
    event.target.disabled = false;
  }
  renderPanelStatus();
}

async function loadPanelWidgets(pageUniqid) {
  const result = await send('LOAD_WIDGETS', { pageUniqid });
  panelState.widgets = result.selectable;
  renderPanelWidgets();
}

/** The "delete the Memo folder?" question — on sign-out, disabling, and an orphaned mirror. */
function askAboutFolder(text) {
  return new Promise((resolve) => {
    $('panel-ask-text').textContent = text;
    $('panel-ask').hidden = false;
    $('panel-body').hidden = true;
    const finish = async (type) => {
      $('panel-ask-remove').removeEventListener('click', onRemove);
      $('panel-ask-keep').removeEventListener('click', onKeep);
      $('panel-ask').hidden = true;
      try {
        panelState.panel = await send(type);
      } catch (error) {
        // The promise must resolve no matter what: sign-out and the toggle
        // switch wait on it, and an unsettled promise would lock the popup
        // forever, without a single message to the user
        $('panel-status').textContent = humanError(error);
      }
      resolve();
    };
    const onRemove = () => finish('REMOVE_PANEL_FOLDER');
    const onKeep = () => finish('FORGET_PANEL_FOLDER');
    $('panel-ask-remove').addEventListener('click', onRemove);
    $('panel-ask-keep').addEventListener('click', onKeep);
  });
}

async function openPanel() {
  showLoading();
  panelState.panel = await send('GET_PANEL');
  show('section-panel');

  if (panelState.panel.orphaned && panelState.panel.rootId) {
    await askAboutFolder(
      'Аккаунт был отключён, а папка «Memo» осталась на панели закладок. ' +
        'Удалить её вместе со всем, что внутри?',
    );
  }

  $('panel-enabled').checked = panelState.panel.enabled;
  $('panel-body').hidden = !panelState.panel.enabled;
  if (!panelState.panel.enabled) return;

  panelState.pages = await send('LOAD_PAGES');
  fillSelect($('panel-page'), panelState.pages, { value: 'uniqid', label: 'name' });
  if (panelState.pages.length === 0) return;
  await loadPanelWidgets($('panel-page').value);
  renderPanelStatus();
}

$('open-panel').addEventListener('click', () => {
  openPanel().catch((error) => showError(humanError(error)));
});

$('panel-back').addEventListener('click', () => {
  openForm().catch((error) => showError(humanError(error)));
});

$('panel-page').addEventListener('change', () => {
  loadPanelWidgets($('panel-page').value).catch((error) => {
    $('panel-status').textContent = humanError(error);
  });
});

$('panel-enabled').addEventListener('change', async (event) => {
  const checkbox = event.target;
  checkbox.disabled = true;
  try {
    if (checkbox.checked) {
      // chrome.permissions.request must come from a user gesture on an
      // extension page — from the service worker it silently fails
      const granted = await chrome.permissions.request({ permissions: ['bookmarks'] });
      if (!granted) {
        checkbox.checked = false;
        $('panel-hint').textContent =
          'Без доступа к закладкам панель работать не может. Разрешение можно выдать позже.';
        return;
      }
    } else if (panelState.panel.rootId) {
      await askAboutFolder(
        'Выключить синхронизацию. Удалить папку «Memo» с панели закладок ' +
          'вместе со всем, что внутри?',
      );
    }
    panelState.panel = await send('SET_PANEL_ENABLED', { enabled: checkbox.checked });
    await openPanel();
  } catch (error) {
    showError(humanError(error));
  } finally {
    checkbox.disabled = false;
  }
});

$('panel-sync').addEventListener('click', async () => {
  const button = $('panel-sync');
  button.disabled = true;
  try {
    panelState.panel = await send('SYNC_PANEL');
    renderPanelStatus();
  } finally {
    button.disabled = false;
  }
});

// Single-line fields submit on Enter. Multi-line ones (#description,
// #task-description, #memo-text) don't: there Enter is a line break
submitOnEnter('name', 'save');
submitOnEnter('url', 'save');
submitOnEnter('new-page-name', 'create-page');
submitOnEnter('new-widget-name', 'create-widget');
submitOnEnter('task-name', 'task-save');
submitOnEnter('task-new-widget-name', 'task-create-widget');
submitOnEnter('memo-new-widget-name', 'memo-create-widget');

// "Task added" refers to the previous task: as soon as the user starts
// typing the next one, the caption is no longer true
$('task-name').addEventListener('input', () => {
  $('task-done').textContent = '';
});

$('memo-text').addEventListener('input', () => {
  $('memo-done').textContent = '';
});

start();
