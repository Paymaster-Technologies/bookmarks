/**
 * oauthOrigin is the address provider sign-in must be opened from. It always
 * equals siteOrigin, not apiHost: the token bridge in the content script
 * accepts tokens only from an origin equal to the current environment's
 * siteOrigin, so sign-in has to start and end there.
 * Where OAuth is not available at all, oauthOrigin is null — the popup then
 * offers only email and password sign-in.
 */
export const ENVIRONMENTS = {
  memotop: {
    id: 'memotop',
    label: 'memo.top',
    apiHost: 'https://memo.top',
    siteOrigin: 'https://memo.top',
    oauthOrigin: 'https://memo.top',
  },
  beta: {
    id: 'beta',
    label: 'beta.memo.top',
    apiHost: 'https://memo.top',
    siteOrigin: 'https://beta.memo.top',
    oauthOrigin: 'https://beta.memo.top',
  },
};

// An unknown saved id (e.g. the former 'prod') falls back here via
// getEnvironment.
export const DEFAULT_ENVIRONMENT_ID = 'memotop';

export function getEnvironment(id) {
  return ENVIRONMENTS[id] || ENVIRONMENTS[DEFAULT_ENVIRONMENT_ID];
}

/**
 * Looks up an environment by site origin (e.g. a tab's origin). Currently the
 * function has no runtime callers — it is covered only by tests but kept: the
 * "origin → environment" lookup will be useful if such a call appears.
 */
export function findEnvironmentByOrigin(origin) {
  const found = Object.values(ENVIRONMENTS).find((env) => env.siteOrigin === origin);
  return found || null;
}
