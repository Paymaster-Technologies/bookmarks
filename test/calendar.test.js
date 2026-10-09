import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventDateForDay,
  utcEventDate,
  utcSecondsOfDay,
  startOfDay,
  addDays,
  isSameLocalDay,
  weekDays,
  eventsForDay,
} from '../lib/calendar.js';

/**
 * A Date double with a given timezone offset.
 *
 * Format tests must not depend on the machine's timezone, and by project
 * convention we don't touch process.env.TZ: eventDateForDay only reads these
 * getters, so a stand-in object is enough.
 */
function localDouble({ year, month, day, hours = 0, minutes = 0, seconds = 0, offsetMinutes }) {
  return {
    getFullYear: () => year,
    getMonth: () => month - 1,
    getDate: () => day,
    getHours: () => hours,
    getMinutes: () => minutes,
    getSeconds: () => seconds,
    getTimezoneOffset: () => offsetMinutes,
  };
}

test('eventDateForDay matches moment.defaultFormat for showbydate', () => {
  // moment(date).format('') yields
  // 'YYYY-MM-DDTHH:mm:ssZ', local time with offset
  assert.equal(
    eventDateForDay(localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: -180 })),
    '2026-09-15T00:00:00+03:00',
  );
});

test('offset sign is inverted relative to getTimezoneOffset', () => {
  // getTimezoneOffset returns minutes to UTC: for UTC+3 it is -180
  const east = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: -180 });
  const west = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: 300 });
  const utc = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: 0 });
  assert.match(eventDateForDay(east), /\+03:00$/);
  assert.match(eventDateForDay(west), /-05:00$/);
  assert.match(eventDateForDay(utc), /\+00:00$/);
});

test('half-hour and 45-minute zones print minutes as two digits', () => {
  const india = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: -330 });
  const marquesas = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: 330 });
  const nepal = localDouble({ year: 2026, month: 9, day: 15, offsetMinutes: -345 });
  assert.match(eventDateForDay(india), /\+05:30$/);
  assert.match(eventDateForDay(marquesas), /-05:30$/);
  assert.match(eventDateForDay(nepal), /\+05:45$/);
});

test('month, day and time are always two digits, seconds included', () => {
  const date = localDouble({
    year: 2026,
    month: 1,
    day: 5,
    hours: 7,
    minutes: 8,
    seconds: 9,
    offsetMinutes: 0,
  });
  assert.equal(eventDateForDay(date), '2026-01-05T07:08:09+00:00');
});

test('zero seconds are not collapsed to one digit', () => {
  const date = localDouble({ year: 2026, month: 12, day: 31, hours: 23, offsetMinutes: -60 });
  assert.equal(eventDateForDay(date), '2026-12-31T23:00:00+01:00');
});

test('utcEventDate gives the UTC date of the instant, matching toISOString', () => {
  // Same as moment.utc(d).format("YYYY-MM-DD")
  const date = new Date('2026-09-15T09:30:00Z');
  assert.equal(utcEventDate(date), '2026-09-15');
  assert.equal(utcEventDate(date), date.toISOString().slice(0, 10));
});

test('a night event in an eastern zone gets the previous UTC date', () => {
  // September 15 01:00 Moscow time is September 14 22:00 UTC. The
  // eventdate + start_time pair describes one instant in UTC, by design
  const moscowNight = new Date('2026-09-14T22:00:00Z');
  assert.equal(utcEventDate(moscowNight), '2026-09-14');
  assert.equal(utcSecondsOfDay(moscowNight), 22 * 3600);
});

test('utcSecondsOfDay counts seconds since UTC midnight', () => {
  // Difference between the instant and moment.utc().startOf('day')
  assert.equal(utcSecondsOfDay(new Date('2026-09-15T00:00:00Z')), 0);
  assert.equal(utcSecondsOfDay(new Date('2026-09-15T09:30:00Z')), 9 * 3600 + 30 * 60);
  assert.equal(utcSecondsOfDay(new Date('2026-09-15T23:59:59Z')), 86399);
});

test('milliseconds are dropped — the server expects whole seconds', () => {
  assert.equal(utcSecondsOfDay(new Date('2026-09-15T09:30:00.750Z')), 9 * 3600 + 30 * 60);
});

test('startOfDay gives local midnight of the same day', () => {
  const date = new Date(2026, 8, 15, 17, 42, 13, 500);
  const start = startOfDay(date);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 8);
  assert.equal(start.getDate(), 15);
  assert.deepEqual(
    [start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()],
    [0, 0, 0, 0],
  );
});

test('addDays rolls over month and year boundaries', () => {
  const end = addDays(new Date(2026, 11, 31), 1);
  assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate()], [2027, 0, 1]);
  const back = addDays(new Date(2026, 0, 1), -1);
  assert.deepEqual([back.getFullYear(), back.getMonth(), back.getDate()], [2025, 11, 31]);
});

test('addDays preserves the time of day', () => {
  const next = addDays(new Date(2026, 8, 15, 17, 42, 13), 3);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [18, 17, 42]);
});

test('addDays does not shift the time of day across a DST change', () => {
  // Computed via calendar fields (new Date(y,m,d+n,h,mi,...)), not via
  // +86400000 ms — a transition day has 23 or 25 hours, and millisecond
  // arithmetic would shift the time of day by an hour. This is a real Date,
  // not a double: the engine knows the transition rules for the machine's
  // zone. The test is not tied to a specific zone or transition date — it
  // runs a whole year forward and back, so in a zone with DST a transition
  // is guaranteed to fall in range (see runs under different TZ). 14:30 is
  // outside transition windows (usually at night), so it matches neither a
  // "skipped" nor a "repeated" hour in any real zone.
  const base = new Date(2026, 0, 15, 14, 30, 0);
  for (let n = -366; n <= 366; n += 1) {
    const shifted = addDays(base, n);
    assert.equal(shifted.getHours(), 14, `time of day is preserved when shifting by ${n}`);
    assert.equal(shifted.getMinutes(), 30, `time of day is preserved when shifting by ${n}`);
  }
});

test('isSameLocalDay compares calendar fields, not the instant', () => {
  assert.equal(isSameLocalDay(new Date(2026, 8, 15, 0, 0), new Date(2026, 8, 15, 23, 59)), true);
  assert.equal(isSameLocalDay(new Date(2026, 8, 15, 23, 59), new Date(2026, 8, 16, 0, 0)), false);
  // The same day number in different months and years means different days
  assert.equal(isSameLocalDay(new Date(2026, 8, 15), new Date(2026, 9, 15)), false);
  assert.equal(isSameLocalDay(new Date(2025, 8, 15), new Date(2026, 8, 15)), false);
});

test('weekDays returns seven consecutive midnights starting on Monday', () => {
  // September 15, 2026 is a Tuesday
  const days = weekDays(new Date(2026, 8, 15, 13, 0));
  assert.equal(days.length, 7);
  assert.equal(days[0].getDay(), 1);
  assert.deepEqual(days.map((d) => d.getDate()), [14, 15, 16, 17, 18, 19, 20]);
  for (const day of days) assert.equal(day.getHours(), 0);
});

test('Sunday lands at the end of its week, not the start of the next', () => {
  // getDay for Sunday is zero — without adjustment the shift would be zero
  const days = weekDays(new Date(2026, 8, 20));
  assert.deepEqual(days.map((d) => d.getDate()), [14, 15, 16, 17, 18, 19, 20]);
  assert.equal(days[6].getDay(), 0);
});

/** A timestamp within the day's local 24 hours — the test is zone-independent. */
function atLocalDay(day, hours, minutes = 0) {
  return startOfDay(day).getTime() + hours * 3600000 + minutes * 60000;
}

const DAY = new Date(2026, 8, 15);

test('eventsForDay picks events by local day', () => {
  const events = [
    { id: 1, start_time_timestamp: atLocalDay(DAY, 10), duration: 1800 },
    { id: 2, start_time_timestamp: atLocalDay(addDays(DAY, 1), 10), duration: 1800 },
    { id: 3, start_time_timestamp: atLocalDay(addDays(DAY, -1), 10), duration: 1800 },
  ];
  assert.deepEqual(eventsForDay(events, DAY).map((e) => e.id), [1]);
});

test('an event crossing midnight shows up on both days', () => {
  const event = { id: 1, start_time_timestamp: atLocalDay(DAY, 23, 30), duration: 3600 };
  assert.equal(eventsForDay([event], DAY).length, 1);
  assert.equal(eventsForDay([event], addDays(DAY, 1)).length, 1);
});

test('day bounds are half-open: midnight belongs to the next day', () => {
  const midnight = { id: 1, start_time_timestamp: atLocalDay(addDays(DAY, 1), 0), duration: 0 };
  assert.deepEqual(eventsForDay([midnight], DAY), []);
  assert.equal(eventsForDay([midnight], addDays(DAY, 1)).length, 1);
});

test('a zero-duration event is selected by its start', () => {
  // With interval intersection a point intersects nothing — a separate branch
  // is needed
  const point = { id: 1, start_time_timestamp: atLocalDay(DAY, 12), duration: 0 };
  assert.equal(eventsForDay([point], DAY).length, 1);
  const noDuration = { id: 2, start_time_timestamp: atLocalDay(DAY, 12) };
  assert.equal(eventsForDay([noDuration], DAY).length, 1);
});

test('timestamp is understood in both seconds and milliseconds', () => {
  // The field format varies
  const ms = atLocalDay(DAY, 10);
  assert.equal(eventsForDay([{ start_time_timestamp: ms, duration: 60 }], DAY).length, 1);
  assert.equal(
    eventsForDay([{ start_time_timestamp: Math.floor(ms / 1000), duration: 60 }], DAY).length,
    1,
  );
});

test('a string timestamp without a timezone is read as UTC', () => {
  const utcNoon = new Date('2026-09-15T12:00:00Z');
  const events = [
    { id: 1, start_time_timestamp: '2026-09-15T12:00:00' },
    { id: 2, start_time_timestamp: '2026-09-15T12:00:00Z' },
    { id: 3, start_time_timestamp: '2026-09-15T15:00:00+03:00' },
  ];
  // All three are the same instant, so they share the same day
  const day = startOfDay(utcNoon);
  assert.deepEqual(eventsForDay(events, day).map((e) => e.id), [1, 2, 3]);
});

test('a date without time is read as UTC midnight', () => {
  const event = { id: 1, start_time_timestamp: '2026-09-15' };
  const day = startOfDay(new Date('2026-09-15T00:00:00Z'));
  assert.equal(eventsForDay([event], day).length, 1);
});

test('junk in the timestamp does not break selection', () => {
  const events = [
    { id: 1, start_time_timestamp: null },
    { id: 2, start_time_timestamp: '' },
    { id: 3, start_time_timestamp: 'two days ago' },
    { id: 4, start_time_timestamp: Number.NaN },
    { id: 5 },
    { id: 6, start_time_timestamp: atLocalDay(DAY, 10), duration: 'half an hour' },
  ];
  assert.deepEqual(eventsForDay(events, DAY).map((e) => e.id), [6]);
});

test('eventsForDay survives empty input', () => {
  assert.deepEqual(eventsForDay(undefined, DAY), []);
  assert.deepEqual(eventsForDay(null, DAY), []);
  assert.deepEqual(eventsForDay([], DAY), []);
});
