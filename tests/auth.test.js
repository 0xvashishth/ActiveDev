import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { installFetchMock, jsonResponse } from './helpers/github-mock.js';
import { STORAGE_KEYS, USER_SCOPED_KEYS, SERVER_URL } from '../lib/constants.js';
import {
  appSettingsUrl,
  authenticate,
  getAccessToken,
  getAppInfo,
  isAuthenticated,
  logout,
  parseAuthResponse,
} from '../lib/auth.js';

beforeEach(() => installChromeMock());

test('parseAuthResponse reads the token/scope from the fragment, falling back to the query string', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop';
  const fromFragment = parseAuthResponse(`https://${EXT}.chromiumapp.org/#access_token=tok&scope=repo,read:org`);
  assert.deepEqual(fromFragment, { token: 'tok', scopes: ['repo', 'read:org'] });

  const fromQuery = parseAuthResponse(`https://${EXT}.chromiumapp.org/?access_token=legacy`);
  assert.deepEqual(fromQuery, { token: 'legacy', scopes: null });
});

test('parseAuthResponse surfaces a GitHub-reported error, and rejects a missing token', () => {
  const EXT = 'abcdefghijklmnopabcdefghijklmnop';
  assert.throws(
    () => parseAuthResponse(`https://${EXT}.chromiumapp.org/#error=access_denied&error_description=User%20cancelled.`),
    /Authentication failed: User cancelled\./
  );
  assert.throws(() => parseAuthResponse(`https://${EXT}.chromiumapp.org/#error=server_error`), /Authentication failed: server_error/);
  assert.throws(() => parseAuthResponse(`https://${EXT}.chromiumapp.org/#scope=repo`), /No access token received/);
});

test('authenticate() clears any previous account data before storing the new token and scopes', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.REVIEW_REQUEST_PRS]: [{ id: 1 }], [STORAGE_KEYS.SETTINGS]: { theme: 'dark' } });
  chrome.identity.launchWebAuthFlow = async () => `${chrome.identity.getRedirectURL()}#access_token=newtok&scope=repo read:org`;

  const token = await authenticate();
  assert.equal(token, 'newtok');
  assert.equal((await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN))[STORAGE_KEYS.ACCESS_TOKEN], 'newtok');
  assert.deepEqual((await chrome.storage.local.get(STORAGE_KEYS.TOKEN_SCOPES))[STORAGE_KEYS.TOKEN_SCOPES], ['repo', 'read:org']);
  assert.equal((await chrome.storage.local.get(STORAGE_KEYS.REVIEW_REQUEST_PRS))[STORAGE_KEYS.REVIEW_REQUEST_PRS], undefined);
  assert.deepEqual((await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS], { theme: 'dark' }, 'settings are not user-scoped');
});

test('getAccessToken / isAuthenticated / logout', async () => {
  assert.equal(await getAccessToken(), null);
  assert.equal(await isAuthenticated(), false);

  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok', [STORAGE_KEYS.SETTINGS]: { theme: 'dark' } });
  assert.equal(await getAccessToken(), 'tok');
  assert.equal(await isAuthenticated(), true);

  await logout();
  assert.equal(await getAccessToken(), null);
  assert.deepEqual((await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS], { theme: 'dark' });
});

test('appSettingsUrl links to the app-specific page when a client id is known, else the generic one', () => {
  assert.equal(appSettingsUrl({ clientId: 'Iv1.abc' }), 'https://github.com/settings/connections/applications/Iv1.abc');
  assert.equal(appSettingsUrl(null), 'https://github.com/settings/applications');
  assert.equal(appSettingsUrl({}), 'https://github.com/settings/applications');
});

test('getAppInfo fetches and caches the client id, and tolerates any failure', async () => {
  let calls = 0;
  let fetchMock = installFetchMock([[`${SERVER_URL}/api/auth/app`, () => (calls++, jsonResponse({ client_id: 'Iv1.abc' }))]]);
  assert.deepEqual(await getAppInfo(), { clientId: 'Iv1.abc' });
  assert.deepEqual(await getAppInfo(), { clientId: 'Iv1.abc' });
  assert.equal(calls, 1, 'the second call is served from the cache');
  fetchMock.restore();

  await chrome.storage.local.remove(STORAGE_KEYS.APP_INFO);
  fetchMock = installFetchMock([[`${SERVER_URL}/api/auth/app`, () => jsonResponse({ message: 'down' }, { status: 500 })]]);
  assert.equal(await getAppInfo(), null);
  fetchMock.restore();

  fetchMock = installFetchMock([[`${SERVER_URL}/api/auth/app`, () => jsonResponse({})]]);
  assert.equal(await getAppInfo(), null, 'a response without a client_id is treated as unavailable');
  fetchMock.restore();

  fetchMock = installFetchMock([
    [
      `${SERVER_URL}/api/auth/app`,
      () => {
        throw new Error('network down');
      },
    ],
  ]);
  assert.equal(await getAppInfo(), null);
  fetchMock.restore();
});
