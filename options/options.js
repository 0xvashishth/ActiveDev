import { authenticate, isAuthenticated, logout, getAppInfo, appSettingsUrl } from '../lib/auth.js';
import { getCurrentUser } from '../lib/github-api.js';
import {
  FOCUS_REPEAT_OPTIONS,
  FOCUS_THRESHOLD_OPTIONS,
  POLL_INTERVAL_OPTIONS,
  REQUIRED_SCOPES,
  STORAGE_KEYS,
} from '../lib/constants.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { SUGGESTED_SITES, normalizeSite, originPatternForSite, siteLabel } from '../lib/activity.js';
import { dateKey, emptyNotes, exportNotes, loadNotes, mergeNotes, updateNotes } from '../lib/notes.js';
import { getTheme, initTheme, setTheme } from '../lib/theme.js';

const ACCESS_LABELS = {
  ok: { text: 'No restrictions detected', tone: 'ok' },
  oauth_restricted: { text: 'Blocked by OAuth App access restrictions', tone: 'bad' },
  sso_required: { text: 'SAML SSO authorization required', tone: 'bad' },
  error: { text: 'Could not verify access', tone: 'unknown' },
};

/**
 * Wires up the options page. Exported so tests can build a DOM, import this
 * module, and call it directly without firing a real DOMContentLoaded event.
 */
export async function initOptions() {
  const $ = (id) => document.getElementById(id);
  const elements = {
    loginBtn: $('login-btn'),
    logoutBtn: $('logout-btn'),
    authStatus: $('auth-status'),
    connectedUser: $('connected-user'),
    statusMessage: $('status-message'),
    scopeWarning: $('scope-warning'),
    orgsCard: $('orgs-card'),
    orgsList: $('orgs-list'),
    orgsEmpty: $('orgs-empty'),
    orgsCheckedAt: $('orgs-checked-at'),
    recheckOrgsBtn: $('recheck-orgs-btn'),
    appSettingsLink: $('app-settings-link'),
    pollInterval: $('poll-interval'),
    notifyReviewRequests: $('notify-review-requests'),
    notifyReviews: $('notify-reviews'),
    includeDrafts: $('include-drafts'),
    settingsSaved: $('settings-saved'),
  };

  $('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

  await initTheme(document);
  const themeSelect = $('theme-select');
  themeSelect.value = await getTheme();
  themeSelect.addEventListener('change', () => setTheme(themeSelect.value));

  initSettingsNav();

  await Promise.all([
    updateAuthStatus(elements),
    renderOrgs(elements),
    initSettings(elements),
    initNotesBackup(),
    initFocusMonitor(),
  ]);
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();

  getAppInfo().then((info) => {
    elements.appSettingsLink.href = appSettingsUrl(info);
  });

  elements.loginBtn.addEventListener('click', () => handleLogin(elements));
  elements.logoutBtn.addEventListener('click', () => handleLogout(elements));
  elements.recheckOrgsBtn.addEventListener('click', async () => {
    elements.recheckOrgsBtn.disabled = true;
    elements.recheckOrgsBtn.textContent = 'Checking…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_ORGS' });
      if (result && result.success === false) showStatus(elements, result.error, 'error');
    } finally {
      elements.recheckOrgsBtn.disabled = false;
      elements.recheckOrgsBtn.textContent = 'Re-check';
      await renderOrgs(elements);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.ORGS] || changes[STORAGE_KEYS.TOKEN_SCOPES] || changes[STORAGE_KEYS.ACCESS_TOKEN]) {
      renderOrgs(elements);
      renderScopeWarning(elements);
    }
    if (changes[STORAGE_KEYS.NOTES]) renderNotesSummary();
  });

  // Exposed for tests; harmless in production.
  return { elements };
}

document.addEventListener('DOMContentLoaded', initOptions);

// ---------------------------------------------------------------------------
// Quick-jump section nav (the page has grown long)
// ---------------------------------------------------------------------------

function initSettingsNav() {
  const nav = document.getElementById('settings-nav');
  if (!nav) return;
  const sections = [...document.querySelectorAll('.card[id]')]
    .map((card) => ({ id: card.id, title: card.querySelector('h2')?.textContent?.trim() }))
    .filter((s) => s.title);
  if (sections.length === 0) return;

  const links = new Map();
  for (const { id, title } of sections) {
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.textContent = title;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#${id}`);
      setActiveLink(id);
    });
    nav.append(link);
    links.set(id, link);
  }

  function setActiveLink(id) {
    for (const [linkId, link] of links) link.classList.toggle('active', linkId === id);
  }
  setActiveLink(sections[0].id);

  // Progressive enhancement: highlight the section currently in view.
  // (IntersectionObserver isn't implemented by the jsdom test environment.)
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveLink(visible.target.id);
      },
      { rootMargin: '-10% 0px -70% 0px' }
    );
    for (const { id } of sections) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
  }
}

async function updateAuthStatus(elements) {
  if (!(await isAuthenticated())) {
    elements.authStatus.classList.add('hidden');
    return;
  }
  const cached = (await chrome.storage.local.get(STORAGE_KEYS.USER_INFO))[STORAGE_KEYS.USER_INFO];
  try {
    const user = cached || (await getCurrentUser());
    elements.authStatus.classList.remove('hidden');
    elements.connectedUser.textContent = user.login;
    elements.loginBtn.textContent = 'Re-authenticate';
  } catch {
    elements.authStatus.classList.add('hidden');
  }
  await renderScopeWarning(elements);
}

async function renderScopeWarning(elements) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.TOKEN_SCOPES, STORAGE_KEYS.ACCESS_TOKEN]);
  const scopes = stored[STORAGE_KEYS.TOKEN_SCOPES];
  const missing = stored[STORAGE_KEYS.ACCESS_TOKEN] && Array.isArray(scopes)
    ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
    : [];
  elements.scopeWarning.classList.toggle('hidden', missing.length === 0);
  elements.scopeWarning.textContent = missing.length
    ? `Your current login is missing: ${missing.join(', ')}. Click "Re-authenticate" so organization pull requests can be fetched.`
    : '';
}

async function renderOrgs(elements) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.ORGS, STORAGE_KEYS.ORGS_CHECKED_AT, STORAGE_KEYS.ACCESS_TOKEN]);
  if (!stored[STORAGE_KEYS.ACCESS_TOKEN]) {
    elements.orgsCard.classList.add('hidden');
    return;
  }
  elements.orgsCard.classList.remove('hidden');

  const orgs = stored[STORAGE_KEYS.ORGS];
  const checkedAt = stored[STORAGE_KEYS.ORGS_CHECKED_AT];
  elements.orgsList.replaceChildren();
  elements.orgsEmpty.classList.toggle('hidden', !Array.isArray(orgs) || orgs.length > 0);
  elements.orgsCheckedAt.textContent = checkedAt
    ? `Last checked ${new Date(checkedAt).toLocaleString()}`
    : 'Not checked yet — click Re-check.';

  for (const org of orgs || []) {
    const info = ACCESS_LABELS[org.access] || ACCESS_LABELS.error;
    const li = document.createElement('li');
    li.className = 'org-item';

    const avatar = document.createElement('img');
    avatar.src = org.avatarUrl || `https://github.com/${encodeURIComponent(org.login)}.png?size=40`;
    avatar.alt = '';
    avatar.className = 'org-avatar';

    const name = document.createElement('a');
    name.href = `https://github.com/${encodeURIComponent(org.login)}`;
    name.target = '_blank';
    name.rel = 'noopener';
    name.textContent = org.login;

    const status = document.createElement('span');
    status.className = `org-status ${info.tone}`;
    status.textContent = info.text;
    if (org.message) status.title = org.message;

    li.append(avatar, name, status);

    if (org.access === 'sso_required') {
      li.append(linkButton('Authorize SSO', `https://github.com/orgs/${encodeURIComponent(org.login)}/sso`));
    } else if (org.access === 'oauth_restricted') {
      li.append(linkButton('Grant / request', elements.appSettingsLink.href));
    }
    elements.orgsList.append(li);
  }
}

function linkButton(text, href) {
  const a = document.createElement('a');
  a.className = 'btn-small';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

async function initSettings(elements) {
  const settings = await getSettings();

  for (const minutes of POLL_INTERVAL_OPTIONS) {
    const option = document.createElement('option');
    option.value = String(minutes);
    option.textContent = minutes === 1 ? '1 minute' : `${minutes} minutes`;
    elements.pollInterval.append(option);
  }
  elements.pollInterval.value = String(settings.pollIntervalMinutes);
  elements.notifyReviewRequests.checked = settings.notifyReviewRequests;
  elements.notifyReviews.checked = settings.notifyReviewsOnMyPRs;
  elements.includeDrafts.checked = settings.includeDraftReviewRequests;

  const save = async () => {
    const next = {
      pollIntervalMinutes: Number(elements.pollInterval.value),
      notifyReviewRequests: elements.notifyReviewRequests.checked,
      notifyReviewsOnMyPRs: elements.notifyReviews.checked,
      includeDraftReviewRequests: elements.includeDrafts.checked,
    };
    await updateSettings(next); // merge: never drop other settings (e.g. focus monitor)
    await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
    elements.settingsSaved.classList.remove('hidden');
    setTimeout(() => elements.settingsSaved.classList.add('hidden'), 1500);
  };

  [elements.pollInterval, elements.notifyReviewRequests, elements.notifyReviews, elements.includeDrafts].forEach(
    (el) => el.addEventListener('change', save)
  );
}

// ---------------------------------------------------------------------------
// Focus monitor
// ---------------------------------------------------------------------------

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

function fillSelect(select, values, label) {
  select.replaceChildren(
    ...values.map((v) => {
      const option = document.createElement('option');
      option.value = String(v);
      option.textContent = label(v);
      return option;
    })
  );
}

async function initFocusMonitor() {
  const $ = (id) => document.getElementById(id);
  const el = {
    enabled: $('focus-enabled'),
    enabledLabel: $('focus-enabled-label'),
    sites: $('focus-sites'),
    addForm: $('focus-add-site'),
    siteInput: $('focus-site-input'),
    suggestions: $('focus-suggestions'),
    threshold: $('focus-threshold'),
    repeat: $('focus-repeat'),
    workHours: $('focus-work-hours'),
    workRow: $('focus-work-hours-row'),
    workStart: $('focus-work-start'),
    workEnd: $('focus-work-end'),
    weekdays: $('focus-weekdays'),
    testBtn: $('focus-test-btn'),
    resetBtn: $('focus-reset-btn'),
    message: $('focus-message'),
  };
  const minutes = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);
  fillSelect(el.threshold, FOCUS_THRESHOLD_OPTIONS, minutes);
  fillSelect(el.repeat, FOCUS_REPEAT_OPTIONS, minutes);
  const hours = Array.from({ length: 24 }, (_, i) => i);
  fillSelect(el.workStart, hours, hourLabel);
  fillSelect(el.workEnd, hours, hourLabel);

  let settings = await getSettings();

  const message = (text, type = 'success') => {
    el.message.textContent = text;
    el.message.className = `help-text small ${type}`;
  };

  const save = async (patch) => {
    settings = await updateSettings(patch);
    await chrome.runtime.sendMessage({ type: 'FOCUS_SETTINGS_UPDATED' });
    await render();
  };

  async function hasAccess(site) {
    return chrome.permissions.contains({ origins: [originPatternForSite(site)] }).catch(() => false);
  }

  async function render() {
    el.enabled.checked = settings.focusEnabled;
    el.enabledLabel.textContent = settings.focusEnabled ? 'On' : 'Off';
    el.threshold.value = String(settings.focusThresholdMinutes);
    el.repeat.value = String(settings.focusRepeatMinutes);
    el.workHours.checked = settings.focusWorkHoursOnly;
    el.workStart.value = String(settings.focusWorkStartHour);
    el.workEnd.value = String(settings.focusWorkEndHour);
    el.weekdays.checked = settings.focusWeekdaysOnly;
    el.workRow.classList.toggle('disabled', !settings.focusWorkHoursOnly);
    [el.workStart, el.workEnd, el.weekdays].forEach((input) => (input.disabled = !settings.focusWorkHoursOnly));

    const chips = [];
    for (const site of settings.focusSites) {
      const missing = settings.focusEnabled && !(await hasAccess(site));
      const li = document.createElement('li');
      li.className = `site-chip${missing ? ' missing' : ''}`;
      li.append(siteLabel(site) === site ? site : `${siteLabel(site)} (${site})`);
      if (missing) {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = 'not allowed';
        warn.title = 'Chrome has not granted access to this site, so time on it is not measured.';
        const grant = document.createElement('button');
        grant.className = 'chip-btn grant';
        grant.textContent = 'Allow';
        grant.addEventListener('click', async () => {
          const granted = await chrome.permissions.request({ origins: [originPatternForSite(site)] });
          if (!granted) message(`Access to ${site} was not granted.`, 'error');
          await render();
        });
        li.append(warn, grant);
      }
      const remove = document.createElement('button');
      remove.className = 'chip-btn';
      remove.textContent = '✕';
      remove.title = `Remove ${site}`;
      remove.setAttribute('aria-label', `Remove ${site}`);
      remove.addEventListener('click', async () => {
        await chrome.permissions.remove({ origins: [originPatternForSite(site)] }).catch(() => {});
        await save({ focusSites: settings.focusSites.filter((s) => s !== site) });
      });
      li.append(remove);
      chips.push(li);
    }
    el.sites.replaceChildren(...chips);

    el.suggestions.replaceChildren(
      ...SUGGESTED_SITES.filter((site) => !settings.focusSites.includes(site)).map((site) => {
        const button = document.createElement('button');
        button.className = 'suggestion';
        button.textContent = `+ ${siteLabel(site)}`;
        button.title = `Add ${site}`;
        button.addEventListener('click', () => addSite(site));
        return button;
      })
    );
  }

  /** Permission prompts must run directly inside the click handler (user gesture). */
  async function addSite(raw) {
    const site = normalizeSite(raw);
    if (!site) {
      message(`"${raw}" doesn't look like a website address.`, 'error');
      return;
    }
    if (settings.focusSites.includes(site)) {
      message(`${site} is already in the list.`, 'error');
      return;
    }
    if (settings.focusEnabled) {
      const granted = await chrome.permissions.request({ origins: [originPatternForSite(site)] });
      if (!granted) {
        message(`Chrome access to ${site} was not granted, so it was not added.`, 'error');
        return;
      }
    }
    el.siteInput.value = '';
    await save({ focusSites: [...settings.focusSites, site] });
    message(`Added ${site}.`);
  }

  el.enabled.addEventListener('change', async () => {
    if (el.enabled.checked) {
      const origins = settings.focusSites.map(originPatternForSite);
      const granted = origins.length === 0 || (await chrome.permissions.request({ origins }));
      if (!granted) {
        el.enabled.checked = false;
        message('Chrome access to the listed sites is needed to measure time on them. Nothing was enabled.', 'error');
        return;
      }
      await save({ focusEnabled: true });
      message(`Focus monitor is on. You'll get a reminder after ${minutes(settings.focusThresholdMinutes)} on these sites when work is pending.`);
    } else {
      await chrome.permissions.remove({ origins: settings.focusSites.map(originPatternForSite) }).catch(() => {});
      await save({ focusEnabled: false });
      message('Focus monitor is off and site access was removed. Your history is kept until you delete it.');
    }
  });

  el.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addSite(el.siteInput.value);
  });

  el.threshold.addEventListener('change', () => save({ focusThresholdMinutes: Number(el.threshold.value) }));
  el.repeat.addEventListener('change', () => save({ focusRepeatMinutes: Number(el.repeat.value) }));
  el.workHours.addEventListener('change', () => save({ focusWorkHoursOnly: el.workHours.checked }));
  el.workStart.addEventListener('change', () => save({ focusWorkStartHour: Number(el.workStart.value) }));
  el.workEnd.addEventListener('change', () => save({ focusWorkEndHour: Number(el.workEnd.value) }));
  el.weekdays.addEventListener('change', () => save({ focusWeekdaysOnly: el.weekdays.checked }));

  el.testBtn.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'FOCUS_TEST_NUDGE' });
    if (result?.sent) message('Test reminder sent. Check your notifications.');
    else message(result?.reason || result?.error || 'Could not send a test reminder.', 'error');
  });

  el.resetBtn.addEventListener('click', async () => {
    if (!confirm('Delete all focus activity history? This cannot be undone.')) return;
    await chrome.runtime.sendMessage({ type: 'FOCUS_RESET_ACTIVITY' });
    message('Activity history deleted.');
  });

  await render();
}

// ---------------------------------------------------------------------------
// Notes backup
// ---------------------------------------------------------------------------

async function renderNotesSummary() {
  const notes = await loadNotes();
  const open = notes.items.filter((i) => !i.done).length;
  const days = Object.keys(notes.dayNotes).length;
  document.getElementById('notes-summary').textContent =
    `${notes.items.length} todo${notes.items.length === 1 ? '' : 's'} (${open} open), ` +
    `notes on ${days} day${days === 1 ? '' : 's'}.`;
}

function showNotesMessage(text, type) {
  const el = document.getElementById('notes-message');
  el.textContent = text;
  el.className = `help-text small ${type}`;
}

async function initNotesBackup() {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('notes-import-file');
  await renderNotesSummary();

  $('notes-export-btn').addEventListener('click', async () => {
    const blob = new Blob([exportNotes(await loadNotes())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activedev-notes-${dateKey()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotesMessage('Backup downloaded.', 'success');
  });

  $('notes-import-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || (!Array.isArray(data.items) && !data.dayNotes)) {
        throw new Error('This file does not look like an ActiveDev notes backup.');
      }
      const { added, updated } = await updateNotes((current) => mergeNotes(current, data));
      showNotesMessage(`Imported: ${added} new todo${added === 1 ? '' : 's'}, ${updated} updated. Existing notes were kept.`, 'success');
    } catch (error) {
      showNotesMessage(`Import failed: ${error instanceof SyntaxError ? 'invalid JSON file.' : error.message}`, 'error');
    }
  });

  $('notes-delete-btn').addEventListener('click', async () => {
    const notes = await loadNotes();
    if (notes.items.length === 0 && Object.keys(notes.dayNotes).length === 0) {
      showNotesMessage('There are no notes to delete.', 'success');
      return;
    }
    if (!confirm('Delete all todos and notes? This cannot be undone (export a backup first if unsure).')) return;
    await updateNotes(() => emptyNotes());
    showNotesMessage('All notes deleted.', 'success');
  });
}

async function handleLogin(elements) {
  elements.loginBtn.disabled = true;
  elements.loginBtn.textContent = 'Authenticating...';
  hideStatus(elements);

  try {
    const token = await authenticate();
    if (token) {
      const user = await getCurrentUser();
      elements.authStatus.classList.remove('hidden');
      elements.connectedUser.textContent = user.login;
      elements.loginBtn.textContent = 'Re-authenticate';
      showStatus(elements, `Connected as ${user.login}. Fetching pull requests…`, 'success');

      const result = await chrome.runtime.sendMessage({ type: 'USER_AUTHENTICATED' });
      if (result && result.success === false) {
        showStatus(elements, `Connected as ${user.login}, but the first check failed: ${result.error}`, 'error');
      } else {
        showStatus(elements, `Connected as ${user.login}.`, 'success');
      }
      await Promise.all([renderOrgs(elements), renderScopeWarning(elements)]);
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
    elements.orgsCard.classList.add('hidden');
    elements.scopeWarning.classList.add('hidden');
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
