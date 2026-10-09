import test from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_PROVIDERS, isKnownProvider, oauthUrl, isOauthAvailable } from '../lib/oauth.js';

test('only google and webmoney are supported', () => {
  assert.deepEqual([...OAUTH_PROVIDERS].sort(), ['google_oauth2', 'webmoney']);
});

test('sign-in URL is built from the current environment oauthOrigin', () => {
  assert.equal(
    oauthUrl('https://memo.top', 'google_oauth2'),
    'https://memo.top/api/v1/auth/google_oauth2',
  );
  assert.equal(
    oauthUrl('https://memo.top', 'webmoney'),
    'https://memo.top/api/v1/auth/webmoney?locale=ru',
  );
});

test('environments sharing an apiHost get a URL from their own siteOrigin', () => {
  assert.equal(
    oauthUrl('https://memo.top', 'google_oauth2'),
    'https://memo.top/api/v1/auth/google_oauth2',
  );
});

test('trailing slash in oauthOrigin is not doubled', () => {
  assert.equal(
    oauthUrl('https://example.test:3002/', 'google_oauth2'),
    'https://example.test:3002/api/v1/auth/google_oauth2',
  );
});

test('missing oauthOrigin yields no URL (OAuth unavailable)', () => {
  assert.equal(oauthUrl(null, 'google_oauth2'), null);
  assert.equal(oauthUrl('', 'webmoney'), null);
  assert.equal(oauthUrl(undefined, 'google_oauth2'), null);
});

test('unknown provider yields no URL', () => {
  assert.equal(oauthUrl('https://memo.top', 'facebook'), null);
  assert.equal(oauthUrl('https://memo.top', ''), null);
  assert.equal(oauthUrl('https://memo.top', undefined), null);
});

test('inherited Object members are not treated as providers', () => {
  // Without hasOwnProperty the string 'toString' would return the inherited
  // member, and it would end up in the tab URL
  assert.equal(isKnownProvider('toString'), false);
  assert.equal(isKnownProvider('constructor'), false);
  assert.equal(oauthUrl('https://memo.top', 'toString'), null);
});

test('isOauthAvailable reflects whether the environment has an oauthOrigin', () => {
  assert.equal(isOauthAvailable({ oauthOrigin: 'https://memo.top' }), true);
  assert.equal(isOauthAvailable({ oauthOrigin: null }), false);
  assert.equal(isOauthAvailable(undefined), false);
});
