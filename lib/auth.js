import { GITHUB_AUTH_BASE, STORAGE_KEYS } from './constants.js';

const CLIENT_ID_KEY = 'ghrr_client_id';
const CLIENT_SECRET_KEY = 'ghrr_client_secret';

export function getRedirectURL() {
  return chrome.identity.getRedirectURL();
}

export async function getClientCredentials() {
  const result = await chrome.storage.local.get([CLIENT_ID_KEY, CLIENT_SECRET_KEY]);
  return {
    clientId: result[CLIENT_ID_KEY] || null,
    clientSecret: result[CLIENT_SECRET_KEY] || null,
  };
}

export async function saveClientCredentials(clientId, clientSecret) {
  await chrome.storage.local.set({
    [CLIENT_ID_KEY]: clientId,
    [CLIENT_SECRET_KEY]: clientSecret,
  });
}

export async function clearClientCredentials() {
  await chrome.storage.local.remove([CLIENT_ID_KEY, CLIENT_SECRET_KEY]);
}

export async function authenticate() {
  const { clientId, clientSecret } = await getClientCredentials();

  if (!clientId || !clientSecret) {
    throw new Error('GitHub OAuth credentials not configured. Set them in the extension options.');
  }

  const redirectUri = getRedirectURL();
  const state = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEYS.OAUTH_STATE]: state });

  const authUrl = `${GITHUB_AUTH_BASE}/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent('repo read:user')}&` +
    `state=${encodeURIComponent(state)}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  const storedState = (await chrome.storage.local.get(STORAGE_KEYS.OAUTH_STATE))[STORAGE_KEYS.OAUTH_STATE];
  if (returnedState && storedState && returnedState !== storedState) {
    throw new Error('State mismatch. Possible CSRF attack.');
  }

  if (!code) {
    throw new Error('No authorization code received from GitHub');
  }

  const tokenResponse = await fetch(`${GITHUB_AUTH_BASE}/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (tokenData.error) {
    throw new Error(`OAuth error: ${tokenData.error_description || tokenData.error}`);
  }

  if (!tokenData.access_token) {
    throw new Error('No access token received from GitHub');
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: tokenData.access_token,
  });

  return tokenData.access_token;
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
