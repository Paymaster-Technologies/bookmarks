import { ENVIRONMENTS, DEFAULT_ENVIRONMENT_ID, getEnvironment } from '../lib/environments.js';
import { getEnvironmentId, setEnvironmentId, clearAuth } from '../lib/storage.js';
import { send } from '../shared/send.js';

/**
 * Asks about the folder and waits for the answer.
 *
 * The mirror belongs to an environment: widget ids from another environment
 * are meaningless, and a leftover folder would show foreign data as current.
 */
function askAboutFolder() {
  return new Promise((resolve) => {
    const box = document.getElementById('panel-ask');
    box.hidden = false;
    const finish = async (type) => {
      box.hidden = true;
      try {
        await send(type);
      } catch {
        // The promise must resolve: the environment switch waits on it, and an
        // unsettled promise would leave the options page hanging
      }
      resolve();
    };
    document
      .getElementById('panel-ask-remove')
      .addEventListener('click', () => finish('REMOVE_PANEL_FOLDER'), { once: true });
    document
      .getElementById('panel-ask-keep')
      .addEventListener('click', () => finish('FORGET_PANEL_FOLDER'), { once: true });
  });
}

const select = document.getElementById('environment');
const hint = document.getElementById('hint');
const saved = document.getElementById('saved');

function renderHint(id) {
  const env = getEnvironment(id);
  hint.textContent = `Сайт: ${env.siteOrigin} · API: ${env.apiHost}`;
}

async function init() {
  for (const env of Object.values(ENVIRONMENTS)) {
    const option = document.createElement('option');
    option.value = env.id;
    option.textContent = env.label;
    select.append(option);
  }
  // The saved environment may be missing from the list: it could have been
  // removed from `lib/environments.js` while its id stayed in chrome.storage.
  // Then the select would silently show an empty row — a
  // mismatch where it's unclear which backend the extension talks to. We coerce
  // the value to one that actually exists in the list; getEnvironment below
  // falls back to the default (memo.top) the same way, so the label and the
  // runtime agree.
  const stored = await getEnvironmentId();
  const current = ENVIRONMENTS[stored] ? stored : DEFAULT_ENVIRONMENT_ID;
  select.value = current;
  renderHint(current);
}

select.addEventListener('change', async () => {
  // Order matters. Tokens are cleared first, then the environment is switched:
  // if the page is closed between the two writes, the old environment remains
  // without tokens — the popup will honestly ask to reconnect. The reverse order would
  // leave the new environment with old tokens, and memo.top and beta
  // share one apiHost, so such a token would keep working under the wrong
  // environment label.
  // Order matters here too: SET_PANEL_WIDGETS starts a sync, and with live
  // tokens and the toggle on it would create a new "Memo" folder — exactly
  // the one the user just asked to delete. Tokens are cleared before handing
  // over the empty widget list
  const panel = await send('GET_PANEL');
  if (panel.rootId) await askAboutFolder();
  await clearAuth();
  // The widget selection belonged to the previous environment — its ids mean
  // nothing in the new one
  await send('SET_PANEL_WIDGETS', { widgetIds: [] });
  await setEnvironmentId(select.value);
  renderHint(select.value);
  saved.hidden = false;
});

init();
