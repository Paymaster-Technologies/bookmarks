/**
 * The side panel's "Memo" tab.
 *
 * A memo is a single text block saved as a whole. Hence two UI traits: saving via an
 * explicit button (there is no autosave anywhere in the project, and adding it
 * here would mean sending the full text on every keystroke) and an honest
 * last-write-wins warning — a concurrent edit on the site will be lost
 * silently.
 */
import { send } from '../shared/send.js';
import { $, confirmInline, showError, clearError, createWidgetPicker } from './panel-common.js';

const state = {
  memoId: null,
  saved: '',
};

/**
 * The memo id lives INSIDE the widget; it is not the widget id.
 * Using the widget id would open the wrong memo or get a 404.
 *
 * Fallback via LOAD_WIDGET — in case the widget list arrived without the
 * nested memo: show includes the memo the same way index does.
 */
async function resolveMemoId(context) {
  const inline = context.widget && context.widget.memo;
  if (inline && inline.id !== undefined && inline.id !== null) return inline.id;
  const widget = await send('LOAD_WIDGET', { widgetId: context.widgetId });
  const memo = widget && widget.memo;
  return memo && memo.id !== undefined && memo.id !== null ? memo.id : null;
}

function isDirty() {
  return state.memoId !== null && $('memo-content').value !== state.saved;
}

/**
 * State caption, button availability and the last-write-wins footnote.
 *
 * The button is disabled when there's nothing to save: an active "Save" over
 * untouched text promises work that doesn't exist, and would still send the
 * full memo text to the server — overwriting someone else's edit for nothing.
 *
 * The footnote is shown only with unsaved edits: the warning that the last
 * write wins concerns the moment of saving, not reading, and there's no need
 * for it to hang around permanently.
 */
function renderState(text = null) {
  const dirty = isDirty();
  if (text !== null) $('memo-state').textContent = text;
  else $('memo-state').textContent = dirty ? 'Есть несохранённые изменения.' : 'Изменений нет.';
  $('memo-save').disabled = !dirty;
  $('memo-note').hidden = !dirty;
}

const picker = createWidgetPicker({
  widgettype: 'memo',
  elements: {
    page: $('memo-page'),
    widget: $('memo-widget'),
    addWidget: $('memo-add-widget'),
    newWidget: $('memo-new-widget'),
    newWidgetName: $('memo-new-widget-name'),
    createWidget: $('memo-create-widget'),
    hint: $('memo-hint'),
    error: $('memo-error'),
  },
  selection: { get: 'GET_MEMO_SELECTION', set: 'SET_MEMO_SELECTION' },
  emptyHint:
    'На этой странице нет виджетов заметок. Создайте виджет — сервер заведёт ' +
    'пустую заметку сам, отдельно её создать нельзя.',
  async onPick(context) {
    if (context === null) {
      state.memoId = null;
      state.saved = '';
      $('memo-body').hidden = true;
      return;
    }
    clearError($('memo-error'));
    state.memoId = await resolveMemoId(context);
    if (state.memoId === null) {
      $('memo-body').hidden = true;
      $('memo-hint').textContent = 'У этого виджета нет заметки. Выберите другой.';
      $('memo-hint').hidden = false;
      return;
    }
    const memo = await send('LOAD_MEMO', { memoId: state.memoId });
    // api.js unwraps an empty response body to null. Treating it as an empty
    // memo would show an empty field that "Save" would send back, wiping the
    // real text.
    // So on an unusable response the tab body isn't shown at all
    if (!memo || typeof memo.content !== 'string') {
      state.memoId = null;
      state.saved = '';
      $('memo-body').hidden = true;
      $('memo-error').textContent = 'Не удалось прочитать заметку, попробуйте ещё раз.';
      $('memo-error').hidden = false;
      return;
    }
    state.saved = memo.content;
    $('memo-content').value = state.saved;
    $('memo-body').hidden = false;
    renderState();
  },
  /** Leaving a widget with unsaved edits prompts instead of happening silently. */
  beforeChange: () => memoTab.canLeave(),
});

$('memo-content').addEventListener('input', () => renderState());

$('memo-save').addEventListener('click', async () => {
  if (state.memoId === null) return;
  const button = $('memo-save');
  const content = $('memo-content').value;
  button.disabled = true;
  clearError($('memo-error'));
  try {
    await send('SAVE_MEMO', { memoId: state.memoId, content });
    state.saved = content;
    // Only renderState re-enables the button, and only if edits remain: a
    // finally here would light up "Save" right after "Saved"
    renderState('Сохранено.');
  } catch (error) {
    showError($('memo-error'), error);
    renderState();
  }
});

export const memoTab = {
  activate() {
    return picker.init();
  },
  /**
   * Session change. Unsaved edits are dropped silently, with no way to ask:
   * the session they could have been saved to no longer exists.
   */
  reset() {
    picker.reset();
    state.memoId = null;
    state.saved = '';
    $('memo-content').value = '';
    $('memo-body').hidden = true;
  },
  async canLeave() {
    if (!isDirty()) return true;
    return confirmInline(
      $('memo-confirm'),
      'В заметке есть несохранённые правки. Отбросить их?',
      'Отбросить',
    );
  },
};
