/**
 * Shared code for the side panel tabs.
 *
 * The "page + widget" pair is identical for tasks and memo: the same two
 * selects, the same remembered selection, the same LOAD_WIDGETS response race
 * and the same creation of a widget of the right type. A separate module, not
 * functions in panel.js, because panel.js imports the tabs, and the tabs would
 * import it back — the imports would form a cycle.
 */
import { send } from '../shared/send.js';
import { humanError } from '../lib/errors.js';

export const $ = (id) => document.getElementById(id);

/** Same fillSelect as in the popup: the list comes from the server, textContent only. */
export function fillSelect(select, items, { value, label }) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item[value]);
    option.textContent = item[label];
    select.append(option);
  }
}

/**
 * Inline confirmation instead of window.confirm.
 *
 * Native dialogs are unreliable in the side panel: Chrome shows them over the
 * window rather than the panel, and Firefox's sidebar may swallow them
 * entirely. So the question is rendered right in the markup, into the given
 * container.
 *
 * The container is cleared before showing: otherwise a second click on
 * "Delete" in the same row would leave two sets of buttons, and the first
 * promise would never resolve.
 *
 * Focus goes to "Cancel", not the destructive button: deletion is triggered
 * from the keyboard (Enter on "✕"), and Enter autorepeat would wipe the task
 * before the user had read the question. Escape answers "no" — without it the
 * only way out of the question would be the mouse.
 *
 * @param {HTMLElement} host container for the question
 * @param {string} text question text
 * @param {string} confirmLabel label of the confirm button
 * @returns {Promise<boolean>}
 */
export function confirmInline(host, text, confirmLabel) {
  host.replaceChildren();
  // Screen readers read the question as a group: without a name they would
  // announce two buttons, "Yes, delete" and "Cancel", with no context
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', text);
  host.hidden = false;
  // There is nowhere to return focus if the question wasn't asked from the
  // keyboard — then document.activeElement is <body>, and focus() is harmless
  const opener = document.activeElement;
  return new Promise((resolve) => {
    const question = document.createElement('span');
    question.textContent = text;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'link link--danger';
    yes.textContent = confirmLabel;
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'link';
    no.textContent = 'Отмена';
    const onKeydown = (event) => {
      if (event.key !== 'Escape') return;
      // preventDefault + stopPropagation: Escape closes Firefox's sidebar
      // panel, and if it bubbled up it would close the form around the question
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    const finish = (answer) => {
      host.removeEventListener('keydown', onKeydown);
      host.replaceChildren();
      host.hidden = true;
      host.removeAttribute('role');
      host.removeAttribute('aria-label');
      // Only on decline: on confirm the row disappears along with the "✕"
      // button, leaving nowhere to return focus — a removed node can't take it
      if (!answer && opener && typeof opener.focus === 'function' && opener.isConnected) {
        opener.focus();
      }
      resolve(answer);
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    host.addEventListener('keydown', onKeydown);
    host.append(question, yes, no);
    no.focus();
    // A question below a long task list may end up past the panel's edge
    host.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * Enter in a field presses the button that submits that field.
 *
 * Same helper as submitOnEnter in the popup, for the same reason: the panel
 * has no real <form>s at all, yet users expect Enter to work in a
 * single-line field.
 *
 * isComposing is skipped: while typing through an input method editor, Enter
 * confirms the composition rather than submitting the form.
 *
 * @param {HTMLElement} input field where Enter is caught
 * @param {HTMLButtonElement} button button that this Enter presses
 */
export function submitOnEnter(input, button) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (button.disabled) return;
    event.preventDefault();
    button.click();
  });
}

export function showError(node, error) {
  node.textContent = humanError(error);
  node.hidden = false;
}

export function clearError(node) {
  node.hidden = true;
  node.textContent = '';
}

/**
 * "Page + widget" select pair with remembered selection and widget creation.
 *
 * @param {object} options
 * @param {'tasks'|'memo'} options.widgettype which widgets to show
 * @param {object} options.elements markup nodes: page, widget, addWidget,
 *   newWidget, newWidgetName, createWidget, hint, error
 * @param {{get: string, set: string}} options.selection selection message types
 * @param {string} options.emptyHint text shown when there are no widgets of this type
 * @param {(context: object|null) => Promise<void>} options.onPick selection is settled
 * @param {() => Promise<boolean>} [options.beforeChange] whether the current widget may be left
 */
export function createWidgetPicker({
  widgettype,
  elements,
  selection,
  emptyHint,
  onPick,
  beforeChange = null,
}) {
  const state = {
    ready: false,
    pages: [],
    widgets: [],
    raw: [],
    nextPosition: 0,
    // Request counter — the same trick as in the popup (popup.js): LOAD_WIDGETS
    // responses don't arrive in send order, and arrow keys on a closed select
    // keep several requests in flight. A stale response must be dropped
    // silently rather than overwrite the widget list.
    token: 0,
    pageUniqid: null,
    widgetId: null,
  };

  function context() {
    const widget = state.widgets.find((item) => String(item.id) === String(state.widgetId));
    return {
      pageUniqid: state.pageUniqid,
      widgetId: state.widgetId,
      widget: widget || null,
      widgets: state.raw,
    };
  }

  function setBusy(busy) {
    elements.addWidget.disabled = busy;
    elements.createWidget.disabled = busy;
  }

  /**
   * Hides the whole field, not just the <select>.
   *
   * The field has a caption ("Tasks widget"), and a hidden select left it
   * hanging over empty space — a caption for nothing.
   */
  function showWidgetField(visible) {
    const field = elements.widget.closest('.field') || elements.widget;
    field.hidden = !visible;
  }

  async function reload(pageUniqid, preferredWidgetId = null) {
    const token = ++state.token;
    setBusy(true);
    clearError(elements.error);
    const result = await send('LOAD_WIDGETS', { pageUniqid, widgettype });
    if (token !== state.token) return; // response to an older request
    setBusy(false);
    state.pageUniqid = pageUniqid;
    state.raw = result.widgets;
    state.widgets = result.selectable;
    state.nextPosition = result.nextPosition;
    fillSelect(elements.widget, state.widgets, { value: 'id', label: 'name' });
    if (state.widgets.length === 0) {
      state.widgetId = null;
      showWidgetField(false);
      elements.hint.textContent = emptyHint;
      elements.hint.hidden = false;
      await onPick(null);
      return;
    }
    showWidgetField(true);
    elements.hint.hidden = true;
    const preferred = state.widgets.find(
      (widget) => String(widget.id) === String(preferredWidgetId),
    );
    state.widgetId = (preferred || state.widgets[0]).id;
    elements.widget.value = String(state.widgetId);
    await remember();
    await onPick(context());
  }

  /** The selection is saved on every successful switch, not only on write. */
  async function remember() {
    try {
      await send(selection.set, { pageUniqid: state.pageUniqid, widgetId: state.widgetId });
    } catch {
      // Remembering the selection is a convenience; a failed write must not break the tab
    }
  }

  /** Asks the tab whether it may be left, and reverts the select if not. */
  async function guard(select, previous) {
    if (!beforeChange) return true;
    if (await beforeChange()) return true;
    select.value = previous === null ? '' : String(previous);
    return false;
  }

  elements.page.addEventListener('change', async () => {
    const chosen = elements.page.value;
    if (!(await guard(elements.page, state.pageUniqid))) return;
    try {
      await reload(chosen);
    } catch (error) {
      setBusy(false);
      showError(elements.error, error);
    }
  });

  elements.widget.addEventListener('change', async () => {
    const chosen = elements.widget.value;
    if (!(await guard(elements.widget, state.widgetId))) return;
    state.widgetId = chosen;
    await remember();
    try {
      await onPick(context());
    } catch (error) {
      showError(elements.error, error);
    }
  });

  elements.addWidget.addEventListener('click', () => {
    elements.newWidget.hidden = !elements.newWidget.hidden;
    if (!elements.newWidget.hidden) elements.newWidgetName.focus();
  });

  // One field and one button — a form where Enter must work
  submitOnEnter(elements.newWidgetName, elements.createWidget);

  elements.createWidget.addEventListener('click', async () => {
    const name = elements.newWidgetName.value.trim();
    if (name === '') {
      elements.error.textContent = 'Укажите название виджета.';
      elements.error.hidden = false;
      return;
    }
    elements.createWidget.disabled = true;
    try {
      const widget = await send('CREATE_WIDGET', {
        pageUniqid: state.pageUniqid,
        name,
        position: state.nextPosition || 0,
        widgettype,
      });
      elements.newWidgetName.value = '';
      elements.newWidget.hidden = true;
      // Refetch the widget list to get the created widget in full
      await reload(state.pageUniqid, widget && widget.id);
    } catch (error) {
      showError(elements.error, error);
    } finally {
      elements.createWidget.disabled = false;
    }
  });

  return {
    /** First show of the tab: pages, saved selection, widget list. */
    async init() {
      if (state.ready) return;
      state.pages = await send('LOAD_PAGES');
      fillSelect(elements.page, state.pages, { value: 'uniqid', label: 'name' });
      const saved = await send(selection.get);
      const preferred =
        (saved && state.pages.find((page) => page.uniqid === saved.pageUniqid)) || state.pages[0];
      if (!preferred) {
        elements.hint.textContent = 'У аккаунта нет ни одной страницы.';
        elements.hint.hidden = false;
        return;
      }
      elements.page.value = preferred.uniqid;
      await reload(preferred.uniqid, saved && saved.widgetId);
      // The flag is set last: a failed load must be retried via the "Retry"
      // button rather than count as done
      state.ready = true;
    },
    /**
     * Forgets loaded data so the next init() goes to the server again.
     *
     * Needed on session change: after logging into another account, the page
     * and widget lists belong to the previous user and must not be shown.
     * The request counter is bumped so that a response sent before logout
     * doesn't paint stale data over the connect screen.
     */
    reset() {
      state.ready = false;
      state.token += 1;
      state.pages = [];
      state.widgets = [];
      state.raw = [];
      state.pageUniqid = null;
      state.widgetId = null;
    },
    context,
  };
}
