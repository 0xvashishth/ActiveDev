import { STORAGE_KEYS, DEFAULT_SERVER_URL } from './constants.js';

export async function getServerUrl() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SERVER_URL);
  return result[STORAGE_KEYS.SERVER_URL] || DEFAULT_SERVER_URL;
}

export async function setServerUrl(url) {
  const normalized = url.replace(/\/+$/, '');
  await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: normalized });
}

export async function clearServerUrl() {
  await chrome.storage.local.remove(STORAGE_KEYS.SERVER_URL);
}

export async function authenticate() {
  const serverUrl = await getServerUrl();
  const extensionId = chrome.runtime.id;
  const chromeRedirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL(`${serverUrl}/api/auth/start`);
  authUrl.searchParams.set('extension_id', extensionId);
  authUrl.searchParams.set('redirect_uri', chromeRedirectUri);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const url = new URL(responseUrl);
  const token = url.searchParams.get('access_token');

  if (!token) {
    throw new Error('No access token received from authentication server.');
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: token,
  });

  return token;
}

export async function getAccessToken() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
  return result[STORAGE_KEYS.ACCESS_TOKEN] || null;
}

export async function isAuthenticated() {
  const token = await getAccessToken();
  return token !== null;
}

export async function logout() {
  const keysToRemove = [
    STORAGE_KEYS.ACCESS_TOKEN,
    STORAGE_KEYS.USER_INFO,
    STORAGE_KEYS.REVIEW_REQUEST_PRS,
    STORAGE_KEYS.MY_PRS,
    STORAGE_KEYS.MY_PRS_STATE,
    STORAGE_KEYS.NOTIFIED_REVIEWS,
    STORAGE_KEYS.LAST_CHECKED,
    STORAGE_KEYS.INITIAL_CHECK_DONE,
  ];
  await chrome.storage.local.remove(keysToRemove);
}
