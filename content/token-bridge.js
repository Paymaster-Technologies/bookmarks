/**
 * Picks up devise_token_auth tokens from the site's localStorage.
 *
 * Every sign-in method (email and password, Google, WebMoney, Telegram,
 * embedded widgets) stores them under the same keys.
 *
 * Only accessToken, client and uid are read. tokenType and expiry aren't needed.
 *
 * This is a classic content script, not an ES module: in MV3 content_scripts
 * don't support import.
 */
(function sendTokensToExtension() {
  let accessToken = null;
  let client = null;
  let uid = null;
  try {
    accessToken = localStorage.getItem('accessToken');
    client = localStorage.getItem('client');
    uid = localStorage.getItem('uid');
  } catch {
    return; // localStorage may be unavailable, e.g. when site data is blocked
  }

  if (!accessToken || !client || !uid) return;

  // An unavailable service worker (e.g. one that just restarted) isn't the
  // site page's problem: the next visit picks up the tokens again, and without
  // .catch() the unhandled rejection would surface in the site's own devtools
  // console.
  chrome.runtime.sendMessage({
    type: 'TOKENS',
    payload: { accessToken, client, uid, origin: window.location.origin },
  }).catch(() => {});
})();
