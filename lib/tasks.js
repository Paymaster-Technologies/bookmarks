/**
 * Position of a new task — the maximum plus one, modeled on nextWidgetPosition.
 *
 * The same count is needed for optimistic rendering before the request
 * completes.
 */
export function nextTaskPosition(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return 0;
  const positions = tasks.map((task) => Number((task && task.position) || 0));
  return Math.max(...positions.map((value) => (Number.isFinite(value) ? value : 0))) + 1;
}

/**
 * How many tasks are not finished.
 *
 * Compared with true rather than coerced to boolean: finished may be null.
 */
export function openTasksCount(tasks) {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((task) => task && task.finished !== true).length;
}

/**
 * Keeps only the tasks of the requested widget.
 *
 * Defensive filter: keeps only tasks whose widget_id matches the requested
 * widget, guarding against id mix-ups on the extension side.
 *
 * ids are compared as strings: in JSON it is a number, while storage and markup
 * provide a string.
 */
export function sanitizeTasksForWidget(tasks, widgetId) {
  if (!Array.isArray(tasks)) return [];
  const expected = String(widgetId);
  return tasks.filter(
    (task) => task && task.widget_id !== undefined && String(task.widget_id) === expected,
  );
}
