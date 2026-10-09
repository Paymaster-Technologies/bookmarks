import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENTS,
  DEFAULT_ENVIRONMENT_ID,
  getEnvironment,
  findEnvironmentByOrigin,
} from '../lib/environments.js';

test('default environment is production on memo.top', () => {
  const env = getEnvironment(DEFAULT_ENVIRONMENT_ID);
  assert.equal(env.apiHost, 'https://memo.top');
  assert.equal(env.siteOrigin, 'https://memo.top');
});

test('saved id of the removed prod environment falls back to memo.top', () => {
  assert.equal(getEnvironment('prod').id, 'memotop');
});

test('unknown id falls back to production', () => {
  assert.equal(getEnvironment('no-such-env').id, DEFAULT_ENVIRONMENT_ID);
  assert.equal(getEnvironment(undefined).id, DEFAULT_ENVIRONMENT_ID);
});

test('all production environments use the same API', () => {
  for (const id of ['memotop', 'beta']) {
    assert.equal(ENVIRONMENTS[id].apiHost, 'https://memo.top');
  }
});

test('environment is found by site origin', () => {
  assert.equal(findEnvironmentByOrigin('https://memo.top').id, 'memotop');
  assert.equal(findEnvironmentByOrigin('https://example.com'), null);
});

test('every environment has an oauthOrigin field', () => {
  for (const env of Object.values(ENVIRONMENTS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'oauthOrigin'), env.id);
  }
});

test('where oauthOrigin is set, it equals the same environment siteOrigin', () => {
  // The token bridge only accepts siteOrigin. If the two ever drift apart,
  // tokens after provider sign-in will be silently dropped.
  for (const env of Object.values(ENVIRONMENTS)) {
    if (env.oauthOrigin !== null) {
      assert.equal(env.oauthOrigin, env.siteOrigin, env.id);
    }
  }
});
