# Memo Bookmarks

A browser extension for [Memo.top](https://memo.top). It saves the current tab
as a bookmark, task, or note to any page and widget in your Memo account. It
also keeps your Memo tasks, notes, and calendar open in a side panel next to
the page you're on.

> **Memo.top only.** This extension is a companion to the Memo.top service and
> works only with it. You need a Memo.top account, and the extension doesn't
> work with any other bookmarking service or website.

Works in **Chrome 114+** and **Firefox 128+** from a single codebase (Manifest V3).
The extension's interface is in Russian.

## Features

### Popup: quick capture

Click the toolbar icon and choose what to create:

| Entry type   | What it does |
| ------------ | ------------ |
| **Bookmark** | Saves the tab's title, URL and description to a bookmarks widget. The description is filled in automatically, and you get a warning if the URL is already in that widget. |
| **Task**     | Adds a task to a tasks widget. The title starts out as the tab title. The form stays open after saving, so you can add several tasks in a row. |
| **Note**     | Appends text to the end of a memo widget. The text starts out as the tab title and URL. |

- You can create pages and widgets right from the popup.
- The popup remembers the last entry type you used.
- On pages that can't be bookmarked, such as `chrome://` URLs, only the
  Bookmark option is turned off. Tasks and notes still work there.

### Side panel

A panel that stays open next to the page and has three tabs:

- **Tasks**: a checklist for a tasks widget. You can mark tasks done, expand
  their descriptions, add or delete tasks, and hide finished ones. A counter
  shows how many are still open.
- **Note**: the full text of a memo widget, which you edit and save with a
  **Save** button.
- **Calendar**: a week view that marks days with events. You can see the
  events for a selected day and create or delete simple events.

How to open it:

- **Chrome**: click **Open side panel** at the bottom of the popup.
- **Firefox**: choose **View → Sidebar → Memo**.

### Bookmarks bar mirror (optional)

You can mirror selected Memo bookmark widgets into a `Memo` folder on the
browser's own bookmarks bar, with one subfolder per widget. To set it up, click
**Bar** in the popup header.

- Sync goes one way only, from Memo to the browser. It runs every 15 minutes,
  when the browser starts, after you save a bookmark to a mirrored widget, and
  when you click **Refresh now**.
- If nothing has changed in Memo, the extension doesn't touch your bookmarks.
  This avoids pushing pointless changes through browser sync.
- If you delete a mirrored bookmark by hand, the next sync puts it back. Your
  own bookmarks outside the `Memo` folder are never changed.
- The browser only asks for the `bookmarks` permission when you turn this
  feature on.

### Onboarding

The first time you connect an account, a short three-step welcome page opens.
You can open it again at any time with the **?** button in the popup header.

## Installation

### Chrome (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this repository folder.
3. Click the extension icon and sign in, either with Google, WebMoney, or email
   in the popup, or on the Memo website.

### Firefox (temporary)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json`.

Firefox removes temporary add-ons when it restarts. To install the extension
permanently, the build from `npm run build:firefox` has to be signed through
addons.mozilla.org.

No build step is needed for development: the repository folder is the
extension itself, and it has no runtime dependencies.

## Signing in

There are two ways to connect an account:

1. **Through the Memo website (recommended).** Sign in on the Memo site with
   Google, WebMoney, Telegram, or email. A content script
   (`content/token-bridge.js`) reads the `devise_token_auth` tokens the site
   keeps in `localStorage` and passes them to the extension. The popup's
   **Sign in with Google / WebMoney** buttons open the provider's login page in
   a new tab, and the extension picks up the account once you've signed in.
2. **Email and password in the popup.** The popup sends `POST auth/sign_in`
   directly.

Signing out works differently depending on how you signed in:

- **Tokens taken from the website** are only forgotten by the extension. They
  share a session with the site, so revoking them would also sign you out of
  the website.
- **Tokens from the popup's email form** are revoked on the server.

## Permissions

| Permission                       | Why it's needed |
| -------------------------------- | --------------- |
| `storage`                        | Settings, auth tokens, UI state, and the mirror's bookkeeping |
| `tabs`                           | Reading the active tab's title and URL, and opening login and welcome tabs |
| `alarms`                         | Running the bookmarks-bar sync every 15 minutes |
| `sidePanel`                      | The side panel in Chrome |
| `bookmarks` (optional)           | Requested only when you turn on the bookmarks-bar mirror |
| Host access to Memo domains      | API calls and the token bridge content script |

**Privacy note:** when the bookmark form opens, the extension sends the tab's
URL to the Memo server to fill in the bookmark description. Keep this in mind
for internal or private URLs. The task and note forms don't send the URL.

## Project structure

| Path | Contents |
| ---- | -------- |
| `background/service-worker.js` | Message router. All network calls go through it, and it owns most of the storage. |
| `background/bookmark-sync.js` | Bookmarks-bar mirror sync. It is the only code that calls `chrome.bookmarks`. |
| `content/token-bridge.js` | Reads auth tokens from the Memo website |
| `lib/` | Plain logic that doesn't depend on the browser: API client, URL helpers, widget selection, environments, the mirror diff, calendar date math, and browser differences. The one exception is `storage.js`, which wraps `chrome.storage.local`. |
| `popup/` | Popup UI |
| `panel/` | Side panel UI: tasks, note, and calendar |
| `options/` | Options page, where you choose the environment |
| `welcome/` | Onboarding page |
| `shared/send.js` | A small wrapper for sending messages to the service worker |
| `test/` | Unit tests for `lib/` |
| `tools/` | Development tools that aren't part of the extension: the release build script and the icon generator |

The service worker makes all API calls with `host_permissions`. Browsers don't
apply CORS to these requests, so the Memo backend didn't need any changes.

### One manifest for Chrome and Firefox

The repository has a single `manifest.json` that works in both browsers:

- `background` declares both `service_worker` (used by Chrome) and `scripts`
  (used by Firefox, which runs it as an event page).
- `side_panel` is used by Chrome and `sidebar_action` by Firefox. Each browser
  ignores the other's key.
- The code calls the promise-based `chrome.*` API, which Firefox's MV3 also
  supports, so no polyfill is needed.
- `lib/browser.js` finds the bookmarks bar by its data, not by its position.
  Position alone would be wrong in Firefox, where the bookmarks menu comes
  before the toolbar.

## Development

Requires Node.js 18 or newer. There are no npm dependencies.

```sh
npm test                 # run unit tests (node --test)
npm run build            # build both store packages
npm run build:chrome
npm run build:firefox
```

### Tests

`npm test` covers the pure modules in `lib/`:

- **API client**, including some details of the API contract that are easy to
  get wrong:
  - `page_id` is the page's `uniqid`, not its numeric id.
  - `POST bookmarks` takes the widget id in its `id` field.
  - The widget position field is spelled `postion`. The extension keeps this
    misspelling on purpose because the API expects it.
- **URL helpers, widget selection, and environments.**
- **Bookmarks-bar detection** (`lib/browser.js`), tested against the bookmark
  trees of Chrome 134+, older Chrome, and Firefox.
- **Mirror diffing** (`lib/mirror.js`):
  - If nothing changed in Memo, the sync plan is empty and makes no bookmark
    calls.
  - If the sync fails partway through, the extension's records still match
    what was actually created. This prevents duplicates on the next sync.
- **Calendar date and time conversions** (`lib/calendar.js`).

The UI and the service worker don't have automated tests. Check them by hand
in the browser.

### Release build

`tools/build.mjs` writes `dist/memo-bookmarks-<target>-<version>.zip` for each
browser. It has no dependencies (the zip is written with `node:zlib`), and
builds of the same commit produce identical zips.

The build changes two things compared to the repository:

- **Per-browser manifest.** It removes the other browser's keys from each
  manifest.
- **Version from `package.json`.** It copies the version number from
  `package.json` into the manifest.

The script fails instead of producing a bad package. It stops if:

- a listed file is missing, or a runtime file isn't listed;
- a path the manifest references is missing from the package;
- a manifest still contains the other browser's keys;
- any JavaScript file fails `node --check`;
- an `http(s)` URL with a private or loopback host appears in the package;
- the finished zip doesn't read back with the same contents as the source.

To publish a release, bump `version` in `package.json` only.

## Known limitations

- **Mirror:**
  - Changes go one way only. Bookmarks you add to the `Memo` folder in the
    browser aren't sent back to Memo.
  - If you reorder items on the Memo site, the mirror doesn't reorder them in
    the browser.
  - Bookmark descriptions and Memo icons aren't carried over.
  - Changes can take up to 15 minutes to appear, because the API has no push
    notifications.
  - Only `http` and `https` URLs are mirrored. `javascript:` and other schemes
    are rejected.
- **Notes:**
  - Saving a note replaces the whole note, and the most recent save wins. The
    backend keeps no versions, so if someone edits the note on the website
    between loading and saving, that edit is lost.
  - You can't create a standalone note. A new memo widget comes with an empty
    note, so the way to get a new note is to create a new widget.
- **Not supported:** encrypted widgets, `secretmemo` widgets, calendar booking
  slots, reordering tasks, and editing or deleting bookmarks.
- **Duplicate detection** only checks the selected widget, because the API has
  no endpoint for searching across all of them.
- **Page names** can't start with the Cyrillic letter "yo". The backend rejects these names, and the
  popup tells you so before sending the request.
- **Side panel** requires Chrome 114 or newer. Firefox has no way for an
  extension to open its sidebar, so you open it from the browser menu.

## License

Released into the public domain. See [LICENSE](LICENSE).
