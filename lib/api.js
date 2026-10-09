const API_PATH = 'api/v1';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * HTTP client for the bookmarks API.
 *
 * The module intentionally knows nothing about chrome.* and takes fetch as a
 * parameter: this lets it be tested in Node with a fake fetch and no
 * dependencies.
 */
export function createApi({ apiHost, auth = null, fetchImpl = globalThis.fetch }) {
  const base = `${String(apiHost).replace(/\/+$/, '')}/${API_PATH}`;

  async function request(method, path, { body = null, authorized = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authorized && auth) {
      headers['access-token'] = auth.accessToken;
      headers.client = auth.client;
      headers.uid = auth.uid;
    }
    const response = await fetchImpl(`${base}/${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new ApiError(response.status, `${method} ${path} → ${response.status}`);
    }
    return response;
  }

  async function json(method, path, options) {
    const response = await request(method, path, options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    async signIn(email, password) {
      const response = await request('POST', 'auth/sign_in', {
        body: { email, password },
        authorized: false,
      });
      const accessToken = response.headers.get('access-token');
      const client = response.headers.get('client');
      const uid = response.headers.get('uid');
      if (!accessToken || !client || !uid) {
        throw new ApiError(response.status, 'sign_in did not return tokens in headers');
      }
      return { accessToken, client, uid, source: 'password' };
    },

    signOut() {
      return json('DELETE', 'auth/sign_out');
    },

    getPages() {
      return json('GET', 'pages');
    },

    getWidgets(pageUniqid) {
      return json('GET', `bookmarksgroups?page_id=${encodeURIComponent(pageUniqid)}`);
    },

    getWidget(widgetId) {
      return json('GET', `bookmarksgroups/${encodeURIComponent(widgetId)}`);
    },

    createPage(name) {
      return json('POST', 'pages', { body: { name } });
    },

    createWidget({ pageUniqid, name, position, widgettype = 'bookmarks' }) {
      return json('POST', 'bookmarksgroups', {
        body: {
          page_id: pageUniqid,
          name,
          widgettype,
          postion: position,
          columnid: 0,
        },
      });
    },

    createBookmark({ widgetId, name, url, description }) {
      return json('POST', 'bookmarks', {
        body: { id: widgetId, bookmark: { name, url, description } },
      });
    },

    getMemo(memoId) {
      return json('GET', `memos/${encodeURIComponent(memoId)}`);
    },

    updateMemo(memoId, content) {
      return json('PUT', `memos/${encodeURIComponent(memoId)}`, { body: { content } });
    },

    getTasks(widgetId) {
      return json('GET', `tasks/${encodeURIComponent(widgetId)}`);
    },

    createTask({ widgetId, name, description, position }) {
      return json('POST', 'tasks', {
        body: { widget_id: widgetId, task: { name, description, position } },
      });
    },

    updateTask(taskId, { name, description, position }) {
      return json('PATCH', `tasks/${encodeURIComponent(taskId)}`, {
        body: { task: { name, description, position } },
      });
    },

    deleteTask(taskId) {
      return json('DELETE', `tasks/${encodeURIComponent(taskId)}`);
    },

    setTaskFinished(taskId, finished) {
      return json('POST', 'tasks/setfinished', { body: { task_id: taskId, finished } });
    },

    updateTaskPositions(widgetId, tasks) {
      return json('POST', 'tasks/updatepositions', { body: { id: widgetId, tasks } });
    },

    getCalendarEvents() {
      return json('GET', 'calendarevents');
    },

    getCalendarEventsByDate(eventdate) {
      return json('POST', 'calendarevents/showbydate', { body: { eventdate } });
    },

    createCalendarEvent({
      eventdate,
      startTime,
      duration,
      prenotificationTime,
      eventtype,
      name,
      description,
    }) {
      return json('POST', 'calendarevents', {
        body: {
          event: {
            eventtype,
            start_time: startTime,
            eventdate,
            duration,
            prenotification_time: prenotificationTime,
            eventinfo: { name, description },
          },
        },
      });
    },

    deleteCalendarEvent(id) {
      return json('DELETE', `calendarevents/${encodeURIComponent(id)}`);
    },

    getCalendarSettings() {
      return json('GET', 'calendarevents/usersettings');
    },

    getSiteMeta(url) {
      return json('POST', 'helpmethods/getsitemeta', { body: { url, lang: 'en' } });
    },
  };
}
