import {
  authenticate,
  isAuthenticated,
  logout,
} from '../lib/auth.js';
import { getCurrentUser } from '../lib/github-api.js';

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    loginBtn: document.getElementById('login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    authStatus: document.getElementById('auth-status'),
    connectedUser: document.getElementById('connected-user'),
    statusMessage: document.getElementById('status-message'),
  };

  await updateAuthStatus(elements);

  elements.loginBtn.addEventListener('click', async () => {
    await handleLogin(elements);
  });

  elements.logoutBtn.addEventListener('click', async () => {
    await handleLogout(elements);
  });
});

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
  elements.loginBtn.disabled = true;
  elements.loginBtn.textContent = 'Authenticating...';
  hideStatus(elements);

  try {
    const token = await authenticate();

    if (token) {
      await chrome.runtime.sendMessage({ type: 'USER_AUTHENTICATED' });
      const user = await getCurrentUser();
      elements.authStatus.classList.remove('hidden');
      elements.connectedUser.textContent = user.login;
      showStatus(elements, `Connected as ${user.login}.`, 'success');
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
    showStatus(elements, 'Disconnected.', 'success');
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
