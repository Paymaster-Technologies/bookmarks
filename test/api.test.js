import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../lib/api.js';

const AUTH = { accessToken: 'tok', client: 'cli', uid: 'user@example.com' };

/** Fake fetch: records calls in calls and returns a preset response. */
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

function apiWith(fetchImpl, auth = AUTH) {
  return createApi({ apiHost: 'https://memo.top', auth, fetchImpl });
}

test('every request is sent with a timeout', async () => {
  const fetchImpl = fakeFetch(jsonResponse([]));
  await apiWith(fetchImpl).getPages();
  const { options } = fetchImpl.calls[0];
  assert.ok(options.signal, 'the request must have a signal for timeout cancellation');
});

test('an authorized request carries the three devise_token_auth headers', async () => {
  const fetchImpl = fakeFetch(jsonResponse([]));
  await apiWith(fetchImpl).getPages();
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/pages');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers['access-token'], 'tok');
  assert.equal(options.headers.client, 'cli');
  assert.equal(options.headers.uid, 'user@example.com');
});

test('getWidgets passes the page uniqid as page_id', async () => {
  const fetchImpl = fakeFetch(jsonResponse([]));
  await apiWith(fetchImpl).getWidgets('kzq1x9');
  assert.equal(
    fetchImpl.calls[0].url,
    'https://memo.top/api/v1/bookmarksgroups?page_id=kzq1x9',
  );
});

test('createWidget sends a postion field — the typo is reproduced on purpose', async () => {
  // The API expects a postion field (spelled so in the API), reproduce it
  // literally
  const fetchImpl = fakeFetch(jsonResponse({ id: 7 }));
  await apiWith(fetchImpl).createWidget({ pageUniqid: 'kzq1x9', name: 'Reading', position: 3 });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body, {
    page_id: 'kzq1x9',
    name: 'Reading',
    widgettype: 'bookmarks',
    postion: 3,
    columnid: 0,
  });
  assert.equal('position' in body, false);
});

test('createWidget accepts a widget type, the postion typo stays', async () => {
  // The postion field is the same for all widget types
  const fetchImpl = fakeFetch(jsonResponse({ id: 8 }));
  const api = apiWith(fetchImpl);
  await api.createWidget({ pageUniqid: 'kzq1x9', name: 'Tasks', position: 1, widgettype: 'tasks' });
  await api.createWidget({ pageUniqid: 'kzq1x9', name: 'Notes', position: 2, widgettype: 'memo' });
  const tasksBody = JSON.parse(fetchImpl.calls[0].options.body);
  const memoBody = JSON.parse(fetchImpl.calls[1].options.body);
  assert.equal(tasksBody.widgettype, 'tasks');
  assert.equal(tasksBody.postion, 1);
  assert.equal('position' in tasksBody, false);
  assert.equal(memoBody.widgettype, 'memo');
  assert.equal(memoBody.postion, 2);
});

test('createBookmark puts the widget id into the id field', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 42 }));
  await apiWith(fetchImpl).createBookmark({
    widgetId: 7,
    name: 'Article',
    url: 'https://example.com',
    description: 'Description',
  });
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/bookmarks');
  assert.deepEqual(JSON.parse(options.body), {
    id: 7,
    bookmark: { name: 'Article', url: 'https://example.com', description: 'Description' },
  });
});

test('signIn sends email, not login, and reads tokens from headers', async () => {
  // angular-token uses options.loginField, which defaults to 'email'
  const fetchImpl = fakeFetch(
    jsonResponse(
      { data: {} },
      { headers: { 'access-token': 'new-tok', client: 'new-cli', uid: 'a@b.c' } },
    ),
  );
  const result = await createApi({
    apiHost: 'https://memo.top',
    auth: null,
    fetchImpl,
  }).signIn('a@b.c', 'secret');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), {
    email: 'a@b.c',
    password: 'secret',
  });
  assert.deepEqual(result, {
    accessToken: 'new-tok',
    client: 'new-cli',
    uid: 'a@b.c',
    source: 'password',
  });
});

test('signIn fails if the server returned no tokens in headers', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ data: {} }));
  await assert.rejects(
    () => createApi({ apiHost: 'https://memo.top', auth: null, fetchImpl }).signIn('a', 'b'),
    (error) => error instanceof ApiError,
  );
});

test('getSiteMeta sends the url and lang', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ state: 0, title: 'T' }));
  await apiWith(fetchImpl).getSiteMeta('https://example.com');
  const { options } = fetchImpl.calls[0];
  assert.deepEqual(JSON.parse(options.body), { url: 'https://example.com', lang: 'en' });
});

test('a failed status becomes an ApiError with the code', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ errors: ['nope'] }, { status: 401 }));
  await assert.rejects(
    () => apiWith(fetchImpl).getPages(),
    (error) => error instanceof ApiError && error.status === 401,
  );
});

test('an empty response body does not break parsing', async () => {
  const fetchImpl = fakeFetch({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
  });
  assert.equal(await apiWith(fetchImpl).signOut(), null);
});

test('signOut sends DELETE to auth/sign_out', async () => {
  const fetchImpl = fakeFetch(jsonResponse({}));
  await apiWith(fetchImpl).signOut();
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/auth/sign_out');
  assert.equal(options.method, 'DELETE');
});

test('getWidget requests the widget by numeric id', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 7, bookmarks: [] }));
  await apiWith(fetchImpl).getWidget(7);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/bookmarksgroups/7');
  assert.equal(options.method, 'GET');
});

test('createPage sends only the page name', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 3, uniqid: 'kzq1x9' }));
  await apiWith(fetchImpl).createPage('Work');
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/pages');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { name: 'Work' });
});

test('signIn suppresses auth headers even when tokens exist', async () => {
  // auth is passed on purpose (apiWith supplies AUTH): we test the
  // authorized:false flag itself, not the lack of tokens to send
  const fetchImpl = fakeFetch(
    jsonResponse({ data: {} }, { headers: { 'access-token': 't', client: 'c', uid: 'u' } }),
  );
  await apiWith(fetchImpl).signIn('a@b.c', 'secret');
  const { options } = fetchImpl.calls[0];
  assert.equal('access-token' in options.headers, false);
  assert.equal('client' in options.headers, false);
  assert.equal('uid' in options.headers, false);
});

test('getMemo requests the memo by its own id, not the widget id', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 15, widget_id: 7, content: 'text' }));
  await apiWith(fetchImpl).getMemo(15);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/memos/15');
  assert.equal(options.method, 'GET');
});

test('updateMemo puts content at the top level of the body, not under memo', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 15, content: 'new' }));
  await apiWith(fetchImpl).updateMemo(15, 'new');
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/memos/15');
  assert.equal(options.method, 'PUT');
  assert.deepEqual(JSON.parse(options.body), { content: 'new' });
});

test('getTasks puts the WIDGET id into the URL', async () => {
  const fetchImpl = fakeFetch(jsonResponse([]));
  await apiWith(fetchImpl).getTasks(7);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks/7');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers['access-token'], 'tok');
});

test('createTask puts widget_id at the top level, task fields under task', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 31 }));
  await apiWith(fetchImpl).createTask({
    widgetId: 7,
    name: 'Buy tickets',
    description: 'by Friday',
    position: 3,
  });
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  assert.deepEqual(body, {
    widget_id: 7,
    task: { name: 'Buy tickets', description: 'by Friday', position: 3 },
  });
  // finished is changed only via setTaskFinished
  assert.equal('finished' in body.task, false);
});

test('updateTask puts the TASK id into the URL — unlike getTasks', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 31 }));
  await apiWith(fetchImpl).updateTask(31, { name: 'Tickets', description: '', position: 0 });
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks/31');
  assert.equal(options.method, 'PATCH');
  assert.deepEqual(JSON.parse(options.body), {
    task: { name: 'Tickets', description: '', position: 0 },
  });
});

test('deleteTask targets the task id', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 31 }));
  await apiWith(fetchImpl).deleteTask(31);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks/31');
  assert.equal(options.method, 'DELETE');
});

test('setTaskFinished sends task_id, not id, both as top-level fields', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 31, finished: true }));
  await apiWith(fetchImpl).setTaskFinished(31, true);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks/setfinished');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  assert.deepEqual(body, { task_id: 31, finished: true });
  assert.equal('id' in body, false);
});

test('updateTaskPositions sends POST, and id is the widget', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 7, tasks: [] }));
  await apiWith(fetchImpl).updateTaskPositions(7, [
    { id: 31, position: 0 },
    { id: 32, position: 1 },
  ]);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/tasks/updatepositions');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    id: 7,
    tasks: [
      { id: 31, position: 0 },
      { id: 32, position: 1 },
    ],
  });
});

test('getCalendarEvents fetches the whole list without parameters', async () => {
  const fetchImpl = fakeFetch(jsonResponse([]));
  await apiWith(fetchImpl).getCalendarEvents();
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/calendarevents');
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
});

test('getCalendarEventsByDate sends POST to a separate route', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ events: [] }));
  await apiWith(fetchImpl).getCalendarEventsByDate('2026-09-15T00:00:00+03:00');
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/calendarevents/showbydate');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { eventdate: '2026-09-15T00:00:00+03:00' });
});

test('createCalendarEvent builds a nested event with eventinfo', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ id: 99 }));
  await apiWith(fetchImpl).createCalendarEvent({
    eventdate: '2026-09-15',
    startTime: 32400,
    duration: 1800,
    prenotificationTime: 0,
    eventtype: 'wevent',
    name: 'Call',
    description: 'about the release',
  });
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/calendarevents');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    event: {
      eventtype: 'wevent',
      start_time: 32400,
      eventdate: '2026-09-15',
      duration: 1800,
      prenotification_time: 0,
      eventinfo: { name: 'Call', description: 'about the release' },
    },
  });
});

test('deleteCalendarEvent targets the event id', async () => {
  const fetchImpl = fakeFetch(jsonResponse({}));
  await apiWith(fetchImpl).deleteCalendarEvent(99);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://memo.top/api/v1/calendarevents/99');
  assert.equal(options.method, 'DELETE');
});

test('getCalendarSettings goes to usersettings', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ default_length: 1800, prenotification_time: 0 }));
  const settings = await apiWith(fetchImpl).getCalendarSettings();
  assert.equal(fetchImpl.calls[0].url, 'https://memo.top/api/v1/calendarevents/usersettings');
  assert.deepEqual(settings, { default_length: 1800, prenotification_time: 0 });
});
