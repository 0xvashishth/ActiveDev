import { STORAGE_KEYS, SERVER_URL, USER_SCOPED_KEYS } from './constants.js';

/**
 * Extracts the OAuth result from the chromiumapp.org redirect URL.
 * The server puts it in the URL fragment; older servers used the query string.
 */
export function parseAuthResponse(responseUrl) {
  const url = new URL(responseUrl);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const pick = (name) => fragment.get(name) ?? url.searchParams.get(name);

  const error = pick('error');
  if (error) {
    throw new Error(`Authentication failed: ${pick('error_description') || error}`);
  }

  const token = pick('access_token');
  if (!token) {
    throw new Error('No access token received from authentication server.');
  }

  const scope = pick('scope');
  return {
    token,
    scopes: scope ? scope.split(/[,\s]+/).filter(Boolean) : null,
  };
}

export async function authenticate() {
  const authUrl = new URL(`${SERVER_URL}/api/auth/start`);
  authUrl.searchParams.set('extension_id', chrome.runtime.id);
  authUrl.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const { token, scopes } = parseAuthResponse(responseUrl);

  // A new login may be a different GitHub account: drop all cached user data.
  await chrome.storage.local.remove(USER_SCOPED_KEYS);
  await chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: token,
    ...(scopes ? { [STORAGE_KEYS.TOKEN_SCOPES]: scopes } : {}),
  });

  return token;
}

export async function getAccessToken() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN);
  return result[STORAGE_KEYS.ACCESS_TOKEN] || null;
}

export async function isAuthenticated() {
  return (await getAccessToken()) !== null;
}

export async function logout() {
  await chrome.storage.local.remove(USER_SCOPED_KEYS);
}

/**
 * Public information about the OAuth app (client ID), used to deep-link to
 * GitHub's "grant organization access" page. Cached; failures are non-fatal.
 */
export async function getAppInfo() {
  const cached = (await chrome.storage.local.get(STORAGE_KEYS.APP_INFO))[STORAGE_KEYS.APP_INFO];
  if (cached?.clientId) return cached;

  try {
    const response = await fetch(`${SERVER_URL}/api/auth/app`);
    if (!response.ok) return null;
    const body = await response.json();
    if (!body?.client_id) return null;
    const info = { clientId: body.client_id };
    await chrome.storage.local.set({ [STORAGE_KEYS.APP_INFO]: info });
    return info;
  } catch {
    return null;
  }
}

/** GitHub page where the user can grant / request org access for this OAuth app. */
export function appSettingsUrl(appInfo) {
  return appInfo?.clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(appInfo.clientId)}`
    : 'https://github.com/settings/applications';
}
