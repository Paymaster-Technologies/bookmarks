/**
 * Calendar dates.
 *
 * The module intentionally doesn't pull in moment: the extension is built
 * without a bundler, and there is no point dragging in a library for four
 * formats.
 *
 * Two different date formats are used: creating an event takes a UTC date and
 * UTC time of day, loading a day takes a local date with offset. Mixing them
 * up means being off by a time zone, and silently.
 */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Local time with offset: 'YYYY-MM-DDTHH:mm:ssZ'.
 *
 * Used when loading the events of a day.
 *
 * The offset is printed from getTimezoneOffset, which returns the minutes the
 * LOCAL time needs to become UTC: for UTC+3 that is -180. So the sign
 * is inverted — otherwise Moscow would end up at -03:00.
 *
 * The date is formatted as is, without snapping to midnight: local midnight
 * comes from startOfDay, and the caller decides what exactly to send.
 */
export function eventDateForDay(date) {
  const offset = date.getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const total = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
  );
}

/**
 * UTC date of the moment: 'YYYY-MM-DD'.
 *
 * The eventdate field when creating an event — the date of THE SAME moment in
 * UTC.
 * For an event at 01:00 Moscow time this is the previous day, and that is
 * intended: the pair eventdate + start_time describes a single moment in UTC.
 *
 * Equivalent to date.toISOString().slice(0, 10), but via UTC getters — this way
 * the function can be tested with a stand-in Date double.
 */
export function utcEventDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Seconds since UTC midnight — the start_time field when creating an event.
 *
 * A plain UTC time of day, not "local digits passed off as UTC".
 *
 * Milliseconds are dropped: the time is always picked with minute precision.
 */
export function utcSecondsOfDay(date) {
  return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

/** Local midnight of the same day. */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Shift by n local days, preserving the time of day.
 *
 * Computed via calendar fields, not by adding 86400000 ms: a day with a DST
 * transition has 23 or 25 hours, and millisecond arithmetic would shift the
 * date by a day.
 */
export function addDays(date, n) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + n,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

export function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Seven local dates of the week, Monday first.
 *
 * getDay counts from Sunday (0), so the offset is recomputed: (day+6)%7
 * gives 0 for Monday and 6 for Sunday.
 */
export function weekDays(anchorDate) {
  const start = startOfDay(anchorDate);
  const monday = addDays(start, -((start.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_unused, index) => addDays(monday, index));
}

/**
 * Event start in absolute time, ms.
 *
 * The format of start_time_timestamp cannot be determined unambiguously: the
 * field may come as a string or as a number.
 *
 * So parsing handles both: a
 * number above 1e12 is treated as milliseconds, below as seconds (1e12 ms is
 * the year 2001, and 1e12 seconds is the 33rd century, so the threshold is not
 * ambiguous). A string without a time zone is read as UTC: the calendar stores
 * moments in UTC, and reading it as local would shift the event by the zone
 * offset.
 *
 * Exported for the side panel: it needs to show the event start time as a
 * string, and parsing start_time_timestamp in a second place by the same rules
 * would mean a second copy of this heuristic that would drift from the first.
 */
export function eventStartMs(event) {
  const value = event && event.start_time_timestamp;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const hasZone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(text);
    const ms = Date.parse(hasZone ? text : `${text}Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Events that fall within the local day `day`.
 *
 * Selection is by overlap with the day, not by matching the start date:
 * an event that started yesterday at 23:30 and lasts an hour must be
 * visible today. duration comes in seconds.
 *
 * A zero-length event is treated as a point: it has no overlap by
 * definition, so it is enough for the start itself to fall within the day.
 */
export function eventsForDay(events, day) {
  if (!Array.isArray(events)) return [];
  const dayStart = startOfDay(day);
  const from = dayStart.getTime();
  const to = addDays(dayStart, 1).getTime();
  return events.filter((event) => {
    const start = eventStartMs(event);
    if (start === null) return false;
    const duration = Number(event.duration);
    const end = start + (Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0);
    if (end === start) return start >= from && start < to;
    return start < to && end > from;
  });
}
