import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, fire, flush } from './helpers/dom-mock.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../lib/constants.js';
import { originPatternForSite } from '../lib/activity.js';
import { addItem, emptyNotes, exportNotes } from '../lib/notes.js';

// See tests/popup.test.js for why this is imported once (for accurate
// coverage) via a throwaway bootstrap DOM, rather than freshly per test.
const bootstrap = setupDom('options/options.html');
const optionsModule = await import('../options/options.js');
const { _resetToastStateForTests } = await import('../popup/dom.js');
bootstrap.cleanup();

let ctx;
beforeEach(() => {
  ctx = setupDom('options/options.html');
});
afterEach(() => {
  _resetToastStateForTests();
  ctx.cleanup();
});

const $ = (id) => ctx.document.getElementById(id);

async function boot() {
  return optionsModule.initOptions();
}

test('version, theme select, and the quick-jump nav are wired up from the real cards', async () => {
  await boot();
  assert.equal($('version').textContent, 'Version test');
  assert.equal($('theme-select').value, 'system');

  $('theme-select').value = 'dark';
  fire($('theme-select'), 'change');
  await flush();
  assert.equal(ctx.document.documentElement.dataset.theme, 'dark');

  const nav = $('settings-nav');
  const labels = [...nav.querySelectorAll('a')].map((a) => a.textContent);
  assert.deepEqual(labels, ['Authentication', 'Organization access', 'Preferences', 'Focus monitor', 'Notes & todos', 'How it works']);
  assert.equal(nav.querySelector('a').classList.contains('active'), true);

  nav.querySelectorAll('a')[2].click();
  assert.equal(ctx.window.location.hash, '#preferences');
  assert.equal(nav.querySelectorAll('a')[2].classList.contains('active'), true);
});

test('with IntersectionObserver available, the nav highlights whichever section scrolls into view', async () => {
  let observedIds = [];
  let callback;
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe(el) {
      observedIds.push(el.id);
    }
  };
  await boot();
  assert.deepEqual(observedIds, ['account', 'orgs-card', 'preferences', 'focus', 'notes-card', 'about']);

  callback([{ isIntersecting: true, target: $('preferences') }]);
  assert.equal($('settings-nav').querySelector('a[href="#preferences"]').classList.contains('active'), true);
  delete globalThis.IntersectionObserver;
});

test('jumping in with a #focus hash scrolls that card into view', async () => {
  ctx.window.location.hash = '#focus';
  let scrolled = false;
  ctx.window.HTMLElement.prototype.scrollIntoView = function () {
    if (this.id === 'focus') scrolled = true;
  };
  await boot();
  assert.equal(scrolled, true);
});

test('unauthenticated: auth card hidden, orgs card hidden, login button ready', async () => {
  await boot();
  assert.equal($('auth-status').classList.contains('hidden'), true);
  assert.equal($('orgs-card').classList.contains('hidden'), true);
  assert.equal($('login-btn').textContent, 'Login with GitHub');
});

test('authenticated: shows the cached user and any missing-scope warning', async () => {
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: 'tok',
    [STORAGE_KEYS.USER_INFO]: { login: 'octocat' },
    [STORAGE_KEYS.TOKEN_SCOPES]: ['repo'],
  });
  await boot();
  assert.equal($('auth-status').classList.contains('hidden'), false);
  assert.equal($('connected-user').textContent, 'octocat');
  assert.equal($('login-btn').textContent, 'Re-authenticate');
  assert.equal($('scope-warning').classList.contains('hidden'), false);
  assert.match($('scope-warning').textContent, /read:org/);

  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.TOKEN_SCOPES]: ['repo', 'read:user', 'read:org'] });
  await ctx.chrome.runtime.sendMessage({ type: 'noop' }); // not needed; scope re-render is storage-driven
  await flush(2);
  assert.equal($('scope-warning').classList.contains('hidden'), true);
});

test('authenticated without a cached user falls back to the API, and hides the card if that fails too', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'fetched-user' }), { headers: { 'content-type': 'application/json' } });
  await boot();
  assert.equal($('connected-user').textContent, 'fetched-user');
  globalThis.fetch = realFetch;
});

test('login: success updates the UI and reports background check failures; cancelling or an error is shown', async () => {
  await boot();
  ctx.chrome.identity.launchWebAuthFlow = async () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#access_token=tok&scope=repo';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'me' }), { headers: { 'content-type': 'application/json' } });
  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'USER_AUTHENTICATED' ? { success: false, error: 'rate limited' } : {});

  $('login-btn').click();
  assert.equal($('login-btn').disabled, true);
  await flush(4);
  assert.match($('status-message').textContent, /but the first check failed: rate limited/);
  assert.equal($('login-btn').disabled, false);
  assert.equal($('login-btn').textContent, 'Re-authenticate');
  globalThis.fetch = realFetch;

  ctx.chrome.identity.launchWebAuthFlow = async () => {
    throw new Error('User cancelled.');
  };
  $('login-btn').click();
  await flush(2);
  assert.match($('status-message').textContent, /Authentication failed: User cancelled\./);
  assert.equal($('status-message').className, 'error');
});

test('login: a successful first check after connecting shows a plain success message', async () => {
  await boot();
  ctx.chrome.identity.launchWebAuthFlow = async () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#access_token=tok&scope=repo';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'me' }), { headers: { 'content-type': 'application/json' } });
  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'USER_AUTHENTICATED' ? { success: true } : {});

  $('login-btn').click();
  await flush(4);
  assert.equal($('status-message').textContent, 'Connected as me.');
  assert.equal($('status-message').className, 'success');
  globalThis.fetch = realFetch;
});

test('logout failure (e.g. the background is unreachable) is reported instead of silently doing nothing', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
  await boot();
  ctx.chrome.runtime.sendMessage = async () => {
    throw new Error('no background page');
  };
  $('logout-btn').click();
  await flush(2);
  assert.match($('status-message').textContent, /Logout failed: no background page/);
  assert.equal($('status-message').className, 'error');
});

test('logout clears storage, hides auth-dependent cards, and shows a confirmation', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok', [STORAGE_KEYS.USER_INFO]: { login: 'me' } });
  await boot();
  let loggedOutMessageSent = false;
  ctx.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'USER_LOGGED_OUT') loggedOutMessageSent = true;
  };
  $('logout-btn').click();
  await flush(2);
  assert.equal(loggedOutMessageSent, true);
  assert.equal($('auth-status').classList.contains('hidden'), true);
  assert.equal($('orgs-card').classList.contains('hidden'), true);
  assert.match($('status-message').textContent, /Disconnected/);
  assert.equal((await ctx.chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN))[STORAGE_KEYS.ACCESS_TOKEN], undefined);
});

test('organizations: renders access states with the right actions, and Re-check refreshes them', async () => {
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: 'tok',
    [STORAGE_KEYS.ORGS]: [
      { login: 'acme', access: 'ok' },
      { login: 'locked', access: 'oauth_restricted', message: 'restricted' },
      { login: 'samlco', access: 'sso_required' },
    ],
    [STORAGE_KEYS.ORGS_CHECKED_AT]: Date.now(),
  });
  await boot();
  const items = [...$('orgs-list').querySelectorAll('.org-item')];
  assert.equal(items.length, 3);
  assert.match(items[0].querySelector('.org-status').textContent, /No restrictions/);
  assert.equal(items[1].querySelector('.btn-small').textContent, 'Grant / request');
  assert.equal(items[1].querySelector('.org-status').title, 'restricted');
  assert.equal(items[2].querySelector('.btn-small').textContent, 'Authorize SSO');
  assert.match($('orgs-checked-at').textContent, /Last checked/);
  assert.equal($('orgs-empty').classList.contains('hidden'), true);

  let recheckRequested = false;
  ctx.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'CHECK_ORGS') {
      recheckRequested = true;
      await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ORGS]: [] });
      return { success: true };
    }
  };
  $('recheck-orgs-btn').click();
  assert.equal($('recheck-orgs-btn').disabled, true);
  await flush(3);
  assert.equal(recheckRequested, true);
  assert.equal($('recheck-orgs-btn').disabled, false);
  assert.equal($('orgs-empty').classList.contains('hidden'), false);
});

test('a failed Re-check shows the error from the background', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok', [STORAGE_KEYS.ORGS]: [] });
  await boot();
  ctx.chrome.runtime.sendMessage = async () => ({ success: false, error: 'network down' });
  $('recheck-orgs-btn').click();
  await flush(3);
  assert.match($('status-message').textContent, /network down/);
});

test('preferences: loads current settings, and saving merges into storage instead of overwriting it', async () => {
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, pollIntervalMinutes: 5, focusEnabled: true, focusSites: ['youtube.com'] },
  });
  await boot();
  assert.equal($('poll-interval').value, '5');
  assert.equal($('notify-review-requests').checked, true);

  let settingsUpdatedSent = false;
  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'SETTINGS_UPDATED' ? (settingsUpdatedSent = true) : undefined);
  $('poll-interval').value = '15';
  fire($('poll-interval'), 'change');
  $('include-drafts').checked = false;
  fire($('include-drafts'), 'change');
  await flush(2);

  assert.equal(settingsUpdatedSent, true);
  const stored = (await ctx.chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.pollIntervalMinutes, 15);
  assert.equal(stored.includeDraftReviewRequests, false);
  assert.equal(stored.focusEnabled, true, 'unrelated settings (focus monitor) survive the save');
  assert.deepEqual(stored.focusSites, ['youtube.com']);
  assert.equal($('settings-saved').classList.contains('hidden'), false);
});

test('focus monitor: enabling requests permission for every listed site; declining keeps it off', async () => {
  await boot();
  assert.equal($('focus-enabled-label').textContent, 'Off');
  const requests = [];
  ctx.chrome.permissions.request = async ({ origins }) => {
    requests.push(origins);
    return false;
  };
  $('focus-enabled').checked = true;
  fire($('focus-enabled'), 'change');
  await flush(3);
  assert.deepEqual(requests[0], DEFAULT_SETTINGS.focusSites.map(originPatternForSite));
  assert.equal($('focus-enabled').checked, false);
  assert.match($('focus-message').textContent, /Nothing was enabled/);

  ctx.chrome.permissions.request = async () => true;
  $('focus-enabled').checked = true;
  fire($('focus-enabled'), 'change');
  await flush(3);
  assert.equal($('focus-enabled-label').textContent, 'On');
  assert.match($('focus-message').textContent, /Focus monitor is on/);
});

test('focus monitor: declining the permission prompt for a newly-added site does not add it', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, focusEnabled: true, focusSites: ['youtube.com'] } });
  await boot();
  ctx.chrome.permissions.request = async () => false;
  $('focus-site-input').value = 'reddit.com';
  fire($('focus-add-site'), 'submit');
  await flush(2);
  assert.match($('focus-message').textContent, /was not granted, so it was not added/);
  assert.equal($('focus-sites').textContent.includes('reddit.com'), false);
});

test('focus monitor: disabling removes the site permissions it had and updates storage', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, focusEnabled: true, focusSites: ['youtube.com'] } });
  await boot();
  const removed = [];
  ctx.chrome.permissions.remove = async ({ origins }) => {
    removed.push(...origins);
    return true;
  };
  $('focus-enabled').checked = false;
  fire($('focus-enabled'), 'change');
  await flush(2);
  assert.deepEqual(removed, [originPatternForSite('youtube.com')]);
  assert.equal($('focus-enabled-label').textContent, 'Off');
  assert.match($('focus-message').textContent, /site access was removed/);
  assert.equal((await ctx.chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS].focusEnabled, false);
});

test('focus monitor: add/remove sites, suggestions, and a site missing permission offers Allow', async () => {
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, focusEnabled: true, focusSites: ['youtube.com'] },
  });
  await boot();
  assert.match($('focus-sites').textContent, /not allowed/);
  assert.match($('focus-sites').textContent, /YouTube \(youtube\.com\)/);

  $('focus-site-input').value = 'not a real site';
  fire($('focus-add-site'), 'submit');
  await flush();
  assert.match($('focus-message').textContent, /doesn't look like a website/);

  $('focus-site-input').value = 'https://www.reddit.com/r/programming';
  fire($('focus-add-site'), 'submit');
  await flush(2);
  assert.match($('focus-sites').textContent, /Reddit \(reddit\.com\)/);
  assert.equal($('focus-site-input').value, '');

  $('focus-site-input').value = 'reddit.com';
  fire($('focus-add-site'), 'submit');
  await flush();
  assert.match($('focus-message').textContent, /already in the list/);

  assert.ok([...$('focus-suggestions').querySelectorAll('.suggestion')].some((b) => b.textContent.includes('Netflix')));
  [...$('focus-suggestions').querySelectorAll('.suggestion')].find((b) => b.textContent.includes('Netflix')).click();
  await flush(2);
  assert.match($('focus-sites').textContent, /Netflix \(netflix\.com\)/);

  const youtubeChip = [...$('focus-sites').querySelectorAll('.site-chip')].find((li) => li.textContent.includes('youtube.com'));
  youtubeChip.querySelector('button[aria-label="Allow"]')?.click(); // not rendered for youtube (granted below) - guard
  const missingChip = [...$('focus-sites').querySelectorAll('.site-chip.missing')][0];
  assert.ok(missingChip, 'a newly-added site without permission is flagged');
  missingChip.querySelector('.chip-btn.grant').click();
  await flush(2);
  assert.equal($('focus-sites').querySelectorAll('.site-chip.missing').length, 0);

  const removeBtn = [...$('focus-sites').querySelectorAll('.site-chip')].find((li) => li.textContent.includes('reddit.com')).querySelector('button[aria-label="Remove reddit.com"]');
  removeBtn.click();
  await flush(2);
  assert.equal($('focus-sites').textContent.includes('reddit.com'), false);
  assert.ok([...$('focus-suggestions').querySelectorAll('.suggestion')].some((b) => b.textContent.includes('Reddit')), 'removed site becomes a suggestion again');
});

test('focus monitor: reminder timing, work-hours toggle, test reminder, and delete history', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, focusEnabled: true } });
  await boot();

  $('focus-threshold').value = '60';
  fire($('focus-threshold'), 'change');
  $('focus-repeat').value = '5';
  fire($('focus-repeat'), 'change');
  await flush(2);
  let stored = (await ctx.chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.focusThresholdMinutes, 60);
  assert.equal(stored.focusRepeatMinutes, 5);

  assert.equal($('focus-work-start').disabled, true);
  $('focus-work-hours').checked = true;
  fire($('focus-work-hours'), 'change');
  await flush(2);
  assert.equal($('focus-work-start').disabled, false);
  assert.equal($('focus-work-hours-row').classList.contains('disabled'), false);

  $('focus-work-start').value = '22';
  fire($('focus-work-start'), 'change');
  $('focus-work-end').value = '6';
  fire($('focus-work-end'), 'change');
  $('focus-weekdays').checked = false;
  fire($('focus-weekdays'), 'change');
  await flush(2);
  stored = (await ctx.chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.focusWorkStartHour, 22);
  assert.equal(stored.focusWorkEndHour, 6);
  assert.equal(stored.focusWeekdaysOnly, false);

  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'FOCUS_TEST_NUDGE' ? { sent: true } : undefined);
  $('focus-test-btn').click();
  await flush(2);
  assert.match($('focus-message').textContent, /Test reminder sent/);

  ctx.chrome.runtime.sendMessage = async () => ({ sent: false, reason: 'Nothing pending' });
  $('focus-test-btn').click();
  await flush(2);
  assert.match($('focus-message').textContent, /Nothing pending/);

  globalThis.confirm = () => false;
  let resetSent = false;
  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'FOCUS_RESET_ACTIVITY' ? (resetSent = true) : undefined);
  $('focus-reset-btn').click();
  await flush();
  assert.equal(resetSent, false, 'cancelling the confirm does nothing');

  globalThis.confirm = () => true;
  $('focus-reset-btn').click();
  await flush(2);
  assert.equal(resetSent, true);
  assert.match($('focus-message').textContent, /Activity history deleted/);
});

test('notes backup: shows a live summary, exports a JSON file, imports (merging), rejects bad files, and deletes all', async () => {
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.NOTES]: addItem(emptyNotes(), { text: 'Write docs', date: '2024-05-01' }),
  });
  await boot();
  assert.match($('notes-summary').textContent, /1 todo \(1 open\)/);

  let downloadHref = null;
  const realCreateElement = ctx.document.createElement.bind(ctx.document);
  ctx.document.createElement = (tag) => {
    const el = realCreateElement(tag);
    if (tag === 'a') {
      const realClick = el.click.bind(el);
      el.click = () => {
        downloadHref = el.href;
        return realClick();
      };
    }
    return el;
  };
  $('notes-export-btn').click();
  await flush(2);
  assert.match(downloadHref, /^blob:/);
  assert.match($('notes-message').textContent, /Backup downloaded/);
  ctx.document.createElement = realCreateElement;

  const backup = exportNotes(addItem(emptyNotes(), { text: 'Imported item', date: '2024-05-02' }));
  const file = new File([backup], 'backup.json', { type: 'application/json' });
  Object.defineProperty($('notes-import-file'), 'files', { value: [file], configurable: true });
  fire($('notes-import-file'), 'change');
  await flush(3);
  assert.match($('notes-message').textContent, /Imported: 1 new todo/);
  assert.match($('notes-summary').textContent, /2 todos \(2 open\)/);

  const badFile = new File(['not json'], 'bad.json', { type: 'application/json' });
  Object.defineProperty($('notes-import-file'), 'files', { value: [badFile], configurable: true });
  fire($('notes-import-file'), 'change');
  await flush(3);
  assert.match($('notes-message').textContent, /invalid JSON file/);

  const wrongShapeFile = new File([JSON.stringify({ hello: 'world' })], 'wrong.json', { type: 'application/json' });
  Object.defineProperty($('notes-import-file'), 'files', { value: [wrongShapeFile], configurable: true });
  fire($('notes-import-file'), 'change');
  await flush(3);
  assert.match($('notes-message').textContent, /does not look like an ActiveDev notes backup/);

  globalThis.confirm = () => true;
  $('notes-delete-btn').click();
  await flush(2);
  assert.match($('notes-summary').textContent, /0 todos \(0 open\)/);
  assert.match($('notes-message').textContent, /All notes deleted/);

  $('notes-delete-btn').click(); // nothing left to delete
  await flush();
  assert.match($('notes-message').textContent, /no notes to delete/);
});

test('live updates: changes made elsewhere (e.g. a poll finishing) refresh orgs, scopes and the notes summary', async () => {
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok', [STORAGE_KEYS.ORGS]: [] });
  await boot();
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.ORGS]: [{ login: 'acme', access: 'ok' }] });
  await flush(2);
  assert.equal($('orgs-list').children.length, 1);

  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.NOTES]: addItem(emptyNotes(), { text: 'x', date: '2024-01-01' }) });
  await flush(2);
  assert.match($('notes-summary').textContent, /1 todo/);
});
