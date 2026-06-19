import {
  getClientCredentials,
  saveClientCredentials,
  clearClientCredentials,
  authenticate,
  isAuthenticated,
  logout,
  getRedirectURL,
} from '../lib/auth.js';
import { getCurrentUser } from '../lib/github-api.js';

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    clientId: document.getElementById('client-id'),
    clientSecret: document.getElementById('client-secret'),
    redirectUrl: document.getElementById('redirect-url'),
    saveAuthBtn: document.getElementById('save-auth-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    copyUrlBtn: document.getElementById('copy-url-btn'),
    authStatus: document.getElementById('auth-status'),
    connectedUser: document.getElementById('connected-user'),
    statusMessage: document.getElementById('status-message'),
  };

  const redirectUri = getRedirectURL();
  elements.redirectUrl.textContent = redirectUri;

  elements.copyUrlBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(redirectUri).then(() => {
      elements.copyUrlBtn.textContent = 'Copied!';
      setTimeout(() => {
        elements.copyUrlBtn.textContent = 'Copy';
      }, 2000);
    });
  });

  await loadCredentials(elements);
  await updateAuthStatus(elements);

  elements.saveAuthBtn.addEventListener('click', async () => {
    await handleAuthenticate(elements);
  });

  elements.logoutBtn.addEventListener('click', async () => {
    await handleLogout(elements);
  });
});

async function loadCredentials(elements) {
  const { clientId, clientSecret } = await getClientCredentials();
  if (clientId) elements.clientId.value = clientId;
  if (clientSecret) elements.clientSecret.value = clientSecret;
}

async function updateAuthStatus(elements) {
  const authenticated = await isAuthenticated();
  if (authenticated) {
    try {
      const user = await getCurrentUser();
      elements.authStatus.classList.remove('hidden');
      elements.connectedUser.textContent = user.login;
    } catch {
      elements.authStatus.classList.add('hidden');
    }
  } else {
    elements.authStatus.classList.add('hidden');
  }
}

async function handleAuthenticate(elements) {
  const clientId = elements.clientId.value.trim();
  const clientSecret = elements.clientSecret.value.trim();

  if (!clientId || !clientSecret) {
    showStatus(elements, 'Please enter both Client ID and Client Secret.', 'error');
    return;
  }

  elements.saveAuthBtn.disabled = true;
  elements.saveAuthBtn.textContent = 'Authenticating...';
  hideStatus(elements);

  try {
    await saveClientCredentials(clientId, clientSecret);
    const token = await authenticate();

    if (token) {
      await chrome.runtime.sendMessage({ type: 'USER_AUTHENTICATED' });
      const user = await getCurrentUser();
      elements.authStatus.classList.remove('hidden');
      elements.connectedUser.textContent = user.login;
      showStatus(elements, `Successfully authenticated as ${user.login}.`, 'success');
      elements.saveAuthBtn.textContent = 'Re-authenticate';
    }
  } catch (error) {
    showStatus(elements, `Authentication failed: ${error.message}`, 'error');
    elements.saveAuthBtn.textContent = 'Save & Authenticate';
  }

  elements.saveAuthBtn.disabled = false;
}

async function handleLogout(elements) {
  try {
    await logout();
    await clearClientCredentials();
    await chrome.runtime.sendMessage({ type: 'USER_LOGGED_OUT' });
    elements.authStatus.classList.add('hidden');
    elements.clientId.value = '';
    elements.clientSecret.value = '';
    showStatus(elements, 'Disconnected successfully.', 'success');
    elements.saveAuthBtn.textContent = 'Save & Authenticate';
  } catch (error) {
    showStatus(elements, `Logout failed: ${error.message}`, 'error');
  }
}

function showStatus(elements, message, type) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = type;
  elements.statusMessage.classList.remove('hidden');
}

function hideStatus(elements) {
  elements.statusMessage.classList.add('hidden');
}
