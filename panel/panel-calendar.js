/**
 * The side panel's "Calendar" tab.
 *
 * A week strip instead of a month: the panel is narrow, and a month grid at
 * 320px is unreadable. The full event list is kept in memory only to highlight
 * days that have events — a day's contents are always fetched separately.
 *
 * The calendar's main trap is two different date formats: loading a day takes
 * a LOCAL date with offset (eventDateForDay), while creating an event takes the
 * UTC date and UTC time of day of the same moment (utcEventDate +
 * utcSecondsOfDay).
 * Mixing them up means being off by the timezone offset, silently.
 */
import { send } from '../shared/send.js';
import { humanError } from '../lib/errors.js';
import {
  weekDays,
  addDays,
  startOfDay,
  isSameLocalDay,
  eventsForDay,
  eventDateForDay,
  eventStartMs,
  utcEventDate,
  utcSecondsOfDay,
} from '../lib/calendar.js';
import { $, confirmInline, showError, clearError, submitOnEnter } from './panel-common.js';

const FALLBACK_DURATION_MINUTES = 60;
const WEEKDAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_NAMES = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const state = {
  ready: false,
  anchor: startOfDay(new Date()),
  selected: startOfDay(new Date()),
  allEvents: [],
  dayEvents: [],
  durationMinutes: FALLBACK_DURATION_MINUTES,
  prenotificationTime: 0,
  // Day request counter: chip clicks come faster than server responses, and
  // a response for the previous day must not redraw the current list
  token: 0,
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function localDateValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The default duration arrives in seconds — the same units the duration
 * field is sent back in. A value
 * of unusable shape falls back to one hour instead of breaking the form.
 */
function minutesFromSettings(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_DURATION_MINUTES;
  return Math.max(1, Math.round(seconds / 60));
}

function renderWeek() {
  const days = weekDays(state.anchor);
  const container = $('cal-week');
  container.replaceChildren();
  const today = new Date();
  for (const day of days) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    const selected = isSameLocalDay(day, state.selected);
    const busy = eventsForDay(state.allEvents, day).length > 0;
    if (selected) chip.classList.add('chip--active');
    if (isSameLocalDay(day, today)) chip.classList.add('chip--today');
    if (busy) chip.classList.add('chip--busy');
    // Own accessible name: otherwise the chip reads as "15" — no month, no hint
    // whether it is selected or the day has events (that's the dot and fill)
    chip.setAttribute('aria-pressed', String(selected));
    chip.setAttribute(
      'aria-label',
      `${day.getDate()} ${MONTH_NAMES[day.getMonth()]}${busy ? ', есть события' : ''}`,
    );

    const weekday = document.createElement('span');
    weekday.className = 'chip__weekday';
    weekday.textContent = WEEKDAY_NAMES[(day.getDay() + 6) % 7];
    const number = document.createElement('span');
    number.className = 'chip__number';
    number.textContent = String(day.getDate());

    chip.append(weekday, number);
    chip.addEventListener('click', () => {
      selectDay(day).catch((error) => showError($('cal-error'), error));
    });
    container.append(chip);
  }
  $('cal-day-title').textContent =
    `${state.selected.getDate()} ${MONTH_NAMES[state.selected.getMonth()]} ` +
    `${state.selected.getFullYear()}`;
}

async function selectDay(day) {
  state.selected = startOfDay(day);
  state.anchor = state.selected;
  renderWeek();
  $('cal-date').value = localDateValue(state.selected);
  const token = ++state.token;
  clearError($('cal-error'));
  // The strip and heading already show the new day, but the list is still old.
  // Dim it during the request: otherwise the previous day's events show for a
  // second under the new date, and could be deleted by mistake for today's
  setEventsBusy(true);
  let events;
  try {
    events = await send('LOAD_CALENDAR_DAY', { eventdate: eventDateForDay(state.selected) });
  } catch (error) {
    // Only the owning request clears dimming: a newer one already set its own
    if (token === state.token) setEventsBusy(false);
    throw error;
  }
  if (token !== state.token) return; // response for a day no longer selected
  setEventsBusy(false);
  state.dayEvents = events;
  renderEvents();
}

function setEventsBusy(busy) {
  $('cal-events').classList.toggle('events--busy', busy);
  $('cal-events').setAttribute('aria-busy', String(busy));
}

/** Event fields live either at the top level or in a nested eventinfo. */
function eventField(event, key) {
  const info = event && event.eventinfo;
  const nested = info && typeof info === 'object' ? info[key] : undefined;
  const value = nested !== undefined && nested !== null ? nested : event && event[key];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * The opponent arrives either as a string or as a user object.
 *
 * uid and email are deliberately left out of the chain: in devise_token_auth
 * uid is the same email, and the fallback would put someone else's address on
 * screen where a name is expected. No name or nickname — the counterpart line
 * is simply not rendered.
 */
function opponentName(event) {
  const opponent = event && event.opponent;
  if (!opponent) return '';
  if (typeof opponent === 'string') return opponent;
  if (typeof opponent !== 'object') return '';
  return String(opponent.name || opponent.nickname || '');
}

function renderEvents() {
  const container = $('cal-events');
  container.replaceChildren();
  for (const event of state.dayEvents) container.append(renderEvent(event));
  $('cal-empty').hidden = state.dayEvents.length > 0;
}

function renderEvent(event) {
  const row = document.createElement('div');
  row.className = 'event';

  const line = document.createElement('div');
  line.className = 'event__line';

  const time = document.createElement('span');
  time.className = 'event__time';
  const startMs = eventStartMs(event);
  time.textContent = startMs === null ? '--:--' : localTime(new Date(startMs));

  const title = eventField(event, 'name').trim() || 'Без названия';

  const name = document.createElement('span');
  name.className = 'event__name';
  name.textContent = title;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link task__remove';
  remove.textContent = '✕';
  remove.title = 'Удалить событие';
  // With the title: "Delete event" in a five-row list doesn't say which one
  remove.setAttribute('aria-label', `Удалить событие: ${title}`);

  const confirm = document.createElement('div');
  confirm.className = 'confirm';
  confirm.hidden = true;
  remove.addEventListener('click', async () => {
    if (!(await confirmInline(confirm, 'Удалить событие?', 'Да, удалить'))) return;
    await removeEvent(event);
  });

  line.append(time, name, remove);
  row.append(line);

  const description = eventField(event, 'description').trim();
  if (description !== '') {
    const text = document.createElement('p');
    text.className = 'event__description muted small';
    text.textContent = description;
    row.append(text);
  }

  const opponent = opponentName(event).trim();
  if (opponent !== '') {
    const who = document.createElement('p');
    who.className = 'event__opponent muted small';
    who.textContent = `С кем: ${opponent}`;
    row.append(who);
  }

  row.append(confirm);
  return row;
}

async function removeEvent(event) {
  try {
    await send('DELETE_CALENDAR_EVENT', { id: event.id });
  } catch (error) {
    showError($('cal-error'), error);
    return;
  }
  state.dayEvents = state.dayEvents.filter((item) => String(item.id) !== String(event.id));
  state.allEvents = state.allEvents.filter((item) => String(item.id) !== String(event.id));
  renderEvents();
  renderWeek();
}

/** The full list is only for highlighting days; failing to load it isn't fatal. */
async function reloadAllEvents() {
  try {
    state.allEvents = await send('LOAD_CALENDAR_EVENTS');
  } catch {
    state.allEvents = [];
  }
  renderWeek();
}

function shiftWeek(delta) {
  state.anchor = addDays(state.anchor, delta * 7);
  // The same weekday becomes selected: otherwise the "next" arrow would move
  // the event list to a day not visible on the strip
  state.selected = addDays(state.selected, delta * 7);
  selectDay(state.selected).catch((error) => showError($('cal-error'), error));
}

$('cal-prev').addEventListener('click', () => shiftWeek(-1));
$('cal-next').addEventListener('click', () => shiftWeek(1));

$('cal-add').addEventListener('click', () => {
  const form = $('cal-form');
  form.hidden = !form.hidden;
  if (form.hidden) return;
  $('cal-date').value = localDateValue(state.selected);
  if ($('cal-time').value === '') {
    // Next full hour: picking minutes by hand is almost never needed
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    $('cal-time').value = localTime(next);
  }
  $('cal-duration').value = String(state.durationMinutes);
  $('cal-name').focus();
});

$('cal-create').addEventListener('click', async () => {
  const errorNode = $('cal-form-error');
  errorNode.hidden = true;
  const name = $('cal-name').value.trim();
  const date = $('cal-date').value;
  const time = $('cal-time').value;
  const minutes = Number($('cal-duration').value);
  if (name === '') {
    errorNode.textContent = 'Укажите название события.';
    errorNode.hidden = false;
    return;
  }
  if (date === '' || time === '') {
    errorNode.textContent = 'Укажите дату и время начала.';
    errorNode.hidden = false;
    return;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    errorNode.textContent = 'Длительность должна быть больше нуля.';
    errorNode.hidden = false;
    return;
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hours, mins] = time.split(':').map(Number);
  // One Date for both fields: eventdate and start_time must describe the same
  // moment in UTC, otherwise the event shifts by the timezone offset
  const start = new Date(year, month - 1, day, hours, mins, 0, 0);

  const button = $('cal-create');
  button.disabled = true;
  try {
    await send('CREATE_CALENDAR_EVENT', {
      eventdate: utcEventDate(start),
      startTime: utcSecondsOfDay(start),
      duration: minutes * 60,
      prenotificationTime: state.prenotificationTime,
      eventtype: 'wevent',
      name,
      description: $('cal-description').value.trim(),
    });
    $('cal-name').value = '';
    $('cal-description').value = '';
    $('cal-form').hidden = true;
    await selectDay(startOfDay(start));
    await reloadAllEvents();
  } catch (error) {
    errorNode.textContent = humanError(error);
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
});

// Enter in the title and duration creates the event; in the description it
// stays a newline, and in date/time the native control intercepts it
submitOnEnter($('cal-name'), $('cal-create'));
submitOnEnter($('cal-duration'), $('cal-create'));

export const calendarTab = {
  async activate() {
    if (state.ready) return;
    try {
      const settings = await send('GET_CALENDAR_SETTINGS');
      state.durationMinutes = minutesFromSettings(settings && settings.default_length);
      const prenotification = Number(settings && settings.prenotification_time);
      state.prenotificationTime = Number.isFinite(prenotification) ? prenotification : 0;
    } catch {
      // Defaults are a form convenience, not a requirement for the calendar
      state.durationMinutes = FALLBACK_DURATION_MINUTES;
      state.prenotificationTime = 0;
    }
    $('cal-duration').value = String(state.durationMinutes);
    await selectDay(new Date());
    // The flag is set last: a failed load must be retried via the "Retry"
    // button rather than count as done
    state.ready = true;
    await reloadAllEvents();
  },
  /** Session change: the previous account's events must not be shown. */
  reset() {
    state.ready = false;
    state.token += 1;
    state.allEvents = [];
    state.dayEvents = [];
    $('cal-events').replaceChildren();
  },
  canLeave() {
    return Promise.resolve(true);
  },
};
