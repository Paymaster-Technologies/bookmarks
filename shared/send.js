/**
 * Wrapper over service worker messages: unwraps { ok, data } and throws
 * errors with a status field.
 *
 * Lives in shared/ rather than lib/: the module touches chrome.runtime, and by
 * convention lib/ knows about chrome.* only in storage.js. One copy for all
 * extension pages — the popup, options and onboarding used to carry their own,
 * and changing the worker response format required three identical edits.
 *
 * chrome.runtime.lastError is checked first: with an unloaded worker or a
 * closed channel Chrome calls the callback with undefined and puts the reason
 * there, and without reading lastError it also logs an unhandled error.
 *
 * @param {string} type message type (SCREAMING_SNAKE_CASE)
 * @param {object} [payload] message body
 * @returns {Promise<*>} the data field of a successful response
 */
export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        const error = new Error((response && response.error && response.error.message) || 'error');
        error.status = (response && response.error && response.error.status) || 0;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}
