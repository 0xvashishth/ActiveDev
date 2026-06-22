import {
  getServerUrl,
  setServerUrl,
  authenticate,
  isAuthenticated,
  logout,
} from '../lib/auth.js';
import { getCurrentUser } from '../lib/github-api.js';

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    serverUrl: document.getElementById('server-url'),
    loginBtn: document.getElementById('login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    authStatus: document.getElementById('auth-status'),
    connectedUser: document.getElementById('connected-user'),
    statusMessage: document.getElementById('status-message'),
  };

  await loadServerUrl(elements);
  await updateAuthStatus(elements);

  elements.loginBtn.addEventListener('click', async () => {
    await handleLogin(elements);
  });

  elements.logoutBtn.addEventListener('click', async () => {
    await handleLogout(elements);
  });
});

async function loadServerUrl(elements) {
  const url = await getServerUrl();
  elements.serverUrl.value = url;
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

async function handleLogin(elements) {
  const serverUrl = elements.serverUrl.value.trim();

  if (!serverUrl) {
    showStatus(elements, 'Please enter your server URL.', 'error');
    return;
  }

  try {
    new URL(serverUrl);
  } catch {
    showStatus(elements, 'Invalid URL format.', 'error');
    return;
  }

  elements.loginBtn.disabled = true;
  elements.loginBtn.textContent = 'Authenticating...';
  hideStatus(elements);

  try {
    await setServerUrl(serverUrl);
    const token = await authenticate();

    if (token) {
      await chrome.runtime.sendMessage({ type: 'USER_AUTHENTICATED' });
      const user = await getCurrentUser();
      elements.authStatus.classList.remove('hidden');
      elements.connectedUser.textContent = user.login;
      showStatus(elements, `Successfully connected as ${user.login}.`, 'success');
      elements.loginBtn.textContent = 'Re-authenticate';
    }
  } catch (error) {
    showStatus(elements, `Authentication failed: ${error.message}`, 'error');
    elements.loginBtn.textContent = 'Login with GitHub';
  }

  elements.loginBtn.disabled = false;
}

async function handleLogout(elements) {
  try {
    await logout();
    await chrome.runtime.sendMessage({ type: 'USER_LOGGED_OUT' });
    elements.authStatus.classList.add('hidden');
    showStatus(elements, 'Disconnected successfully.', 'success');
    elements.loginBtn.textContent = 'Login with GitHub';
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
