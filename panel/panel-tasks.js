/**
 * The side panel's "Tasks" tab.
 *
 * Checklist of a single tasks widget: tick, expand description, delete, add.
 * Tasks can't be reordered — drag and drop is out of scope.
 */
import { send } from '../shared/send.js';
import { humanError } from '../lib/errors.js';
import { nextTaskPosition, openTasksCount } from '../lib/tasks.js';
import {
  $,
  confirmInline,
  showError,
  clearError,
  createWidgetPicker,
  submitOnEnter,
} from './panel-common.js';

const state = {
  widgetId: null,
  tasks: [],
  hideDone: false,
  // Request counter, as in panel-common.js and panel-calendar.js: the tasks
  // widget is switched with arrow keys, and the old widget's response may
  // arrive after the new one's
  token: 0,
};

const picker = createWidgetPicker({
  widgettype: 'tasks',
  elements: {
    page: $('tasks-page'),
    widget: $('tasks-widget'),
    addWidget: $('tasks-add-widget'),
    newWidget: $('tasks-new-widget'),
    newWidgetName: $('tasks-new-widget-name'),
    createWidget: $('tasks-create-widget'),
    hint: $('tasks-hint'),
    error: $('tasks-error'),
  },
  selection: { get: 'GET_TASK_SELECTION', set: 'SET_TASK_SELECTION' },
  emptyHint: 'На этой странице нет виджетов дел. Создайте виджет.',
  async onPick(context) {
    if (context === null) {
      state.widgetId = null;
      state.tasks = [];
      $('tasks-body').hidden = true;
      return;
    }
    state.widgetId = context.widgetId;
    $('tasks-body').hidden = false;
    await loadTasks();
  },
});

async function loadTasks() {
  clearError($('tasks-error'));
  const token = ++state.token;
  const tasks = await send('LOAD_TASKS', { widgetId: state.widgetId });
  if (token !== state.token) return; // another widget is already selected
  state.tasks = tasks;
  render();
}

function visibleTasks() {
  return state.hideDone ? state.tasks.filter((task) => task.finished !== true) : state.tasks;
}

function render() {
  const open = openTasksCount(state.tasks);
  $('tasks-counter').textContent =
    state.tasks.length === 0 ? '' : `Не сделано: ${open} из ${state.tasks.length}`;

  const list = $('tasks-list');
  list.replaceChildren();
  for (const task of visibleTasks()) list.append(renderTask(task));

  if (state.tasks.length === 0) {
    // The first line gives the usual reason for an empty list. The second
    // reason (a stale session) is real but far rarer, and there's no need to
    // alarm someone who just created the widget a minute ago
    $('tasks-empty').textContent = 'Дел пока нет.';
    $('tasks-empty').hidden = false;
    $('tasks-stale').hidden = false;
    return;
  }
  $('tasks-stale').hidden = true;
  $('tasks-empty').textContent = 'Все дела выполнены.';
  $('tasks-empty').hidden = visibleTasks().length > 0;
}

function renderTask(task) {
  const row = document.createElement('div');
  row.className = 'task';
  row.setAttribute('role', 'listitem');

  const line = document.createElement('div');
  line.className = 'task__line';

  const title = String(task.name || '').trim() || 'Без названия';

  const done = document.createElement('input');
  done.type = 'checkbox';
  done.className = 'task__check';
  done.checked = task.finished === true;
  // Name includes the task title: "Done" on twenty checkboxes in a row says
  // nothing about which task is under the cursor
  done.setAttribute('aria-label', `Выполнено: ${title}`);
  done.addEventListener('change', () => toggleFinished(task, done));

  const descriptionText = String(task.description || '').trim();

  const description = document.createElement('p');
  description.className = 'task__description muted small';
  description.textContent = descriptionText;
  description.hidden = true;

  /*
   * The title is a button only when there is something to expand. A disabled
   * button drops out of the tab order and reads to screen readers as a broken
   * control, so a task without a description is rendered as a plain <span>.
   */
  let name;
  if (descriptionText === '') {
    name = document.createElement('span');
    name.className = 'task__name';
  } else {
    name = document.createElement('button');
    name.type = 'button';
    name.className = 'task__name';
    name.setAttribute('aria-expanded', 'false');
    name.addEventListener('click', () => {
      description.hidden = !description.hidden;
      name.setAttribute('aria-expanded', String(!description.hidden));
    });
  }
  name.textContent = title;
  if (task.finished === true) name.classList.add('task__name--done');

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link task__remove';
  remove.textContent = '✕';
  remove.title = 'Удалить дело';
  remove.setAttribute('aria-label', `Удалить дело: ${title}`);

  const confirm = document.createElement('div');
  confirm.className = 'confirm';
  confirm.hidden = true;
  remove.addEventListener('click', async () => {
    if (!(await confirmInline(confirm, 'Удалить дело?', 'Да, удалить'))) return;
    await removeTask(task);
  });

  line.append(done, name, remove);
  row.append(line, description, confirm);
  return row;
}

/**
 * Optimistic toggle: the checkmark is set immediately, reverted only on error.
 *
 * finished is toggled only one way — SET_TASK_FINISHED: UPDATE_TASK doesn't
 * change this field and would silently drop it.
 */
async function toggleFinished(task, checkbox) {
  const previous = task.finished === true;
  const next = checkbox.checked;
  task.finished = next;
  render();
  try {
    await send('SET_TASK_FINISHED', { taskId: task.id, finished: next });
  } catch (error) {
    task.finished = previous;
    render();
    showError($('tasks-error'), error);
  }
}

async function removeTask(task) {
  // The position is saved before deletion: after render() the row is gone
  // while focus is on its button — without moving it, focus would fall to
  // body, i.e. the top of the panel, and the user would tab to the next task
  const index = visibleTasks().findIndex((item) => String(item.id) === String(task.id));
  try {
    await send('DELETE_TASK', { taskId: task.id });
  } catch (error) {
    showError($('tasks-error'), error);
    return;
  }
  state.tasks = state.tasks.filter((item) => String(item.id) !== String(task.id));
  render();
  focusAfterRemoval(index);
}

/** Focus the next task, or "Add task" if the last one was deleted. */
function focusAfterRemoval(index) {
  const rows = $('tasks-list').children;
  const next = index >= 0 && index < rows.length ? rows[index].querySelector('.task__remove') : null;
  (next || $('tasks-create')).focus();
}

$('tasks-hide-done').addEventListener('change', (event) => {
  state.hideDone = event.target.checked;
  render();
});

$('tasks-create').addEventListener('click', async () => {
  const name = $('tasks-new-name').value.trim();
  const errorNode = $('tasks-create-error');
  errorNode.hidden = true;
  if (name === '') {
    errorNode.textContent = 'Укажите название дела.';
    errorNode.hidden = false;
    return;
  }
  if (state.widgetId === null) return;
  const button = $('tasks-create');
  button.disabled = true;
  try {
    const created = await send('CREATE_TASK', {
      widgetId: state.widgetId,
      name,
      description: $('tasks-new-description').value.trim(),
      position: nextTaskPosition(state.tasks),
    });
    $('tasks-new-name').value = '';
    $('tasks-new-description').value = '';
    // The created task is taken from the response. A response of unexpected
    // shape isn't parsed — refetching the list is simpler than guessing
    if (created && created.id !== undefined) {
      state.tasks.push(created);
      render();
    } else {
      await loadTasks();
    }
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

// Enter in the title adds the task. In the description Enter stays a newline
submitOnEnter($('tasks-new-name'), $('tasks-create'));

export const tasksTab = {
  activate() {
    return picker.init();
  },
  /** Session change: the previous account's task list must not be shown. */
  reset() {
    picker.reset();
    state.token += 1; // a pre-logout response won't render the old account's tasks
    state.widgetId = null;
    state.tasks = [];
    $('tasks-list').replaceChildren();
    $('tasks-body').hidden = true;
  },
  /** Tasks have nothing unsaved: every action goes to the server immediately. */
  canLeave() {
    return Promise.resolve(true);
  },
};
