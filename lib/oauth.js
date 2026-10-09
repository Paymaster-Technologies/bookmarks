/**
 * Sign-in page URLs for external providers.
 *
 * Telegram is intentionally not included: its sign-in cannot be opened by URL.
 *
 * The URL is built from the environment's oauthOrigin, not apiHost — see the
 * comment above ENVIRONMENTS in lib/environments.js.
 */
const PROVIDERS = {
  google_oauth2: 'auth/google_oauth2',
  webmoney: 'auth/webmoney?locale=ru',
};

export const OAUTH_PROVIDERS = Object.keys(PROVIDERS);

export function isKnownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

/**
 * @returns {string|null} sign-in page URL, or null for an unknown
 * provider or a missing oauthOrigin (OAuth is unavailable in this environment)
 */
export function oauthUrl(oauthOrigin, provider) {
  if (!oauthOrigin || !isKnownProvider(provider)) return null;
  return `${String(oauthOrigin).replace(/\/+$/, '')}/api/v1/${PROVIDERS[provider]}`;
}

/** @returns {boolean} whether OAuth is available in this environment */
export function isOauthAvailable(environment) {
  return Boolean(environment && environment.oauthOrigin);
}
