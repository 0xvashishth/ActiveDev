import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, fire, flush } from './helpers/dom-mock.js';
import { prNode, review, searchItem, thread } from './helpers/github-mock.js';
// (review/thread are used throughout to build realistic GraphQL fixtures.)
import { buildPullRequestModel } from '../lib/pr-model.js';
import { STORAGE_KEYS } from '../lib/constants.js';

function reviewRequestPR(overrides = {}) {
  const item = searchItem({ owner: 'acme', repo: 'api', number: 482, title: 'Add idempotency keys', author: 'alice' });
  const node = prNode(item, {
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
    reviews: { totalCount: 1, nodes: [review('R1', 'bob', 'APPROVED', '2024-05-01T00:00:00Z')] },
    reviewThreads: { totalCount: 2, nodes: [thread({ starter: 'bob' }), thread({ resolved: true, starter: 'bob' })] },
    ...overrides,
  });
  return buildPullRequestModel(item, node, { viewerLogin: 'me' });
}

function myPR(overrides = {}) {
  const item = searchItem({ owner: 'acme', repo: 'web', number: 9, title: 'Dark mode', author: 'me' });
  const node = prNode(item, { reviewDecision: 'CHANGES_REQUESTED', ...overrides });
  return buildPullRequestModel(item, node, { viewerLogin: 'me' });
}

function baseStatus(overrides = {}) {
  return {
    authenticated: true,
    user: { login: 'me', avatar_url: '' },
    reviewRequests: [reviewRequestPR()],
    myPRs: [myPR()],
    lastChecked: Date.now(),
    lastError: null,
    orgs: [],
    ssoOrgs: [],
    missingScopes: [],
    appInfo: null,
    settings: { includeDraftReviewRequests: true },
    ...overrides,
  };
}

// popup.js has no top-level mutable state of its own (the one `let` is
// reassigned at the start of every initPopup() call), so it's imported once
// here and reused, rather than re-imported (and re-instrumented for
// coverage) fresh for every test. Importing it registers a top-level
// `document.addEventListener('DOMContentLoaded', ...)`, which needs *some*
// global `document` to exist; a throwaway bootstrap DOM provides one. Tests
// never dispatch DOMContentLoaded on it, and call initPopup() directly.
const bootstrap = setupDom('popup/popup.html');
const popupModule = await import('../popup/popup.js');
const { _resetToastStateForTests } = await import('../popup/dom.js');
bootstrap.cleanup();

let ctx;

beforeEach(() => {
  ctx = setupDom('popup/popup.html');
});
afterEach(() => {
  // dom.js *is* a true singleton (popup.js imports it without cache-busting);
  // clear any toast left mid-flight by the test that just ran.
  _resetToastStateForTests();
  ctx.cleanup();
});

/** Installs a scripted chrome.runtime.sendMessage and returns the popup's public API. */
async function boot(handler) {
  ctx.chrome.runtime.sendMessage = (msg) => Promise.resolve(handler(msg));
  return popupModule.initPopup();
}

test('unauthenticated: shows the connect prompt on PR tabs, hides chrome and refresh, Notes still works', async () => {
  await boot(() => ({ authenticated: false }));
  const { document } = ctx;

  assert.equal(document.getElementById('main-content').classList.contains('unauth'), true);
  assert.equal(document.getElementById('refresh-btn').classList.contains('hidden'), true);
  assert.equal(document.getElementById('user-section').classList.contains('hidden'), true);
  assert.equal(document.getElementById('review-badge').classList.contains('hidden'), true);

  document.querySelector('.tab[data-tab="notes"]').click();
  await flush();
  assert.equal(document.getElementById('auth-required').offsetParent !== undefined, true);
  assert.equal(document.getElementById('main-content').dataset.activeTab, 'notes');
});

test('authenticated: renders user info, review/my-PR cards with indicators, banners and last-checked', async () => {
  const status = baseStatus({
    lastError: { message: 'boom', kind: 'unknown', at: Date.now() },
    missingScopes: ['read:org'],
    ssoOrgs: [{ id: 1, login: 'ssoco' }],
    orgs: [{ login: 'restricted-co', access: 'oauth_restricted' }],
  });
  await boot(() => status);
  const { document } = ctx;

  assert.equal(document.getElementById('username').textContent, 'me');
  assert.equal(document.getElementById('review-badge').textContent, '1');
  assert.equal(document.getElementById('myprs-badge').textContent, '1');
  assert.match(document.getElementById('review-list').textContent, /Add idempotency keys/);
  assert.match(document.getElementById('review-list').textContent, /already reviewed by 1/i);
  assert.match(document.getElementById('myprs-list').textContent, /Dark mode/);

  const banners = document.getElementById('banners').textContent;
  assert.match(banners, /Last update failed/);
  assert.match(banners, /read:org/);
  assert.match(banners, /ssoco uses SAML SSO/);
  assert.match(banners, /restricted-co restricts third-party apps/);

  assert.match(document.getElementById('last-checked').textContent, /Updated/);
});

test('first load (no lastChecked yet) shows skeletons, not a misleading empty state, then refreshes automatically', async () => {
  const responses = [baseStatus({ lastChecked: null, reviewRequests: [], myPRs: [] })];
  let checkNowCalls = 0;
  await boot((msg) => {
    if (msg.type === 'CHECK_NOW') {
      checkNowCalls++;
      responses.push(baseStatus({ lastChecked: Date.now() }));
      return { success: true };
    }
    return responses[responses.length - 1];
  });
  await flush(4);
  const { document } = ctx;
  assert.equal(checkNowCalls, 1, 'auto-refreshes once on first load');
  assert.equal(document.getElementById('review-empty').classList.contains('hidden'), true, 'real data replaces the skeleton');
  assert.match(document.getElementById('review-list').textContent, /Add idempotency keys/);
});

test('review request card: team request, re-review requested, started-by-viewer threads, labels, and Enter opens it', async () => {
  const pr = reviewRequestPR({
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'backend', name: 'Backend', organization: { login: 'acme' } } }] },
    viewerLatestReview: { state: 'COMMENTED', submittedAt: '2024-05-01T00:00:00Z', commit: { oid: 'sha-old' } },
    reviewThreads: { totalCount: 1, nodes: [thread({ starter: 'me' })] },
    labels: { nodes: [{ name: 'backend', color: '0e8a16' }] },
  });
  const status = baseStatus({ reviewRequests: [pr] });
  await boot(() => status);
  const { document, chrome } = ctx;

  const text = document.getElementById('review-list').textContent;
  assert.match(text, /via acme\/backend/);
  assert.match(text, /Re-review requested/);
  assert.match(text, /1 of yours still open/);
  assert.match(text, /backend/); // label

  fire(document.querySelector('#review-list .pr-item'), 'keydown', { key: 'Enter' });
  assert.deepEqual(chrome.tabs._created, [pr.htmlUrl]);
});

test('review request card: all conversations resolved renders the all-clear chip', async () => {
  const pr = reviewRequestPR({ reviewThreads: { totalCount: 2, nodes: [thread({ resolved: true, starter: 'bob' }), thread({ resolved: true, starter: 'bob' })] } });
  await boot(() => baseStatus({ reviewRequests: [pr] }));
  assert.match(ctx.document.getElementById('review-list').textContent, /All 2 conversations resolved/);
});

test('my PR card: awaiting-your-reply threads, plain approved/changes-requested states, and no-reviews-yet', async () => {
  const awaiting = myPR({ reviewDecision: null, reviewThreads: { totalCount: 1, nodes: [thread({ starter: 'bob', last: 'bob' })] } });
  await boot(() => baseStatus({ myPRs: [awaiting] }));
  assert.match(ctx.document.getElementById('myprs-list').textContent, /awaiting your reply/);

  const approved = myPR({ reviewDecision: null, reviews: { totalCount: 1, nodes: [review('R1', 'bob', 'APPROVED', '2024-05-01T00:00:00Z')] } });
  await boot(() => baseStatus({ myPRs: [approved] }));
  assert.match(ctx.document.getElementById('myprs-list').textContent, /✓ Approved/);

  const changesRequested = myPR({ reviewDecision: null, reviews: { totalCount: 1, nodes: [review('R2', 'bob', 'CHANGES_REQUESTED', '2024-05-01T00:00:00Z')] } });
  await boot(() => baseStatus({ myPRs: [changesRequested] }));
  assert.match(ctx.document.getElementById('myprs-list').textContent, /✗ Changes requested/);

  const noReviews = myPR({ reviewDecision: null });
  await boot(() => baseStatus({ myPRs: [noReviews] }));
  assert.match(ctx.document.getElementById('myprs-list').textContent, /Awaiting first review/);
});

test('an SSO-hiding org with no locally-known login still gets a (generic) banner', async () => {
  await boot(() => baseStatus({ ssoOrgs: [{ id: 999, login: null }] }));
  assert.match(ctx.document.getElementById('banners').textContent, /1 organization hid results because SAML SSO/);
});

test('tab choice is remembered even if localStorage throws (e.g. private browsing)', async () => {
  await boot(() => baseStatus());
  const realSetItem = ctx.window.localStorage.setItem.bind(ctx.window.localStorage);
  ctx.window.localStorage.setItem = () => {
    throw new Error('quota exceeded');
  };
  assert.doesNotThrow(() => ctx.document.querySelector('.tab[data-tab="my-prs"]').click());
  ctx.window.localStorage.setItem = realSetItem;
});

test('the filter box narrows both lists and the clear button resets it', async () => {
  const status = baseStatus({
    reviewRequests: [reviewRequestPR(), buildPullRequestModel(searchItem({ owner: 'other', repo: 'x', number: 1, title: 'Unrelated', author: 'zed' }))],
  });
  await boot(() => status);
  const { document } = ctx;

  const input = document.getElementById('filter-input');
  const clear = document.getElementById('filter-clear');
  assert.equal(clear.classList.contains('hidden'), true);

  input.value = 'idempotency';
  fire(input, 'input');
  assert.equal(clear.classList.contains('hidden'), false);
  assert.equal(document.querySelectorAll('#review-list .pr-item').length, 1);
  assert.equal(document.getElementById('review-empty').classList.contains('hidden'), true);

  input.value = 'no-such-pr-anywhere';
  fire(input, 'input');
  assert.match(document.getElementById('review-empty').textContent, /match the filter/);

  clear.click();
  assert.equal(input.value, '');
  assert.equal(clear.classList.contains('hidden'), true);
  assert.equal(document.querySelectorAll('#review-list .pr-item').length, 2);
});

test('clicking a PR card opens it; pinning a PR adds it to notes without opening the PR', async () => {
  const status = baseStatus();
  await boot(() => status);
  const { document, chrome } = ctx;

  document.querySelector('#review-list .pr-item').click();
  assert.deepEqual(chrome.tabs._created, ['https://github.com/acme/api/pull/482']);

  const pin = document.querySelector('#review-list .pin-btn');
  assert.equal(pin.classList.contains('pinned'), false);
  pin.click();
  await flush(2);
  assert.equal(chrome.tabs._created.length, 1, 'pinning does not also open the PR');
  assert.equal(pin.classList.contains('pinned'), true);
  assert.match(document.getElementById('toast').textContent, /Added to today's notes/);

  const notes = (await chrome.storage.local.get(STORAGE_KEYS.NOTES))[STORAGE_KEYS.NOTES];
  assert.equal(notes.items.length, 1);
  assert.match(notes.items[0].text, /Review acme\/api#482/);
});

test('refresh button calls CHECK_NOW and re-renders; retry re-runs GET_STATUS after an error', async (t) => {
  let calls = 0;
  const status = baseStatus();
  await boot((msg) => {
    calls++;
    if (msg.type === 'CHECK_NOW') return { success: true };
    if (msg.type === 'GET_STATUS' && calls === 1) throw new Error('offline');
    return status;
  });
  const { document } = ctx;
  assert.equal(document.getElementById('error-state').classList.contains('hidden'), false);
  assert.match(document.getElementById('error-message').textContent, /offline/);

  ctx.chrome.runtime.sendMessage = async (msg) => (msg.type === 'CHECK_NOW' ? { success: true } : status);
  document.getElementById('retry-btn').click();
  await flush(2);
  assert.equal(document.getElementById('error-state').classList.contains('hidden'), true);

  // A click handler runs synchronously up to its first `await`, so the
  // disabled/"Checking…" state is observable immediately, before the
  // (mocked, instant) message round-trip resolves on the next microtask.
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.click();
  assert.equal(refreshBtn.disabled, true);
  assert.equal(refreshBtn.textContent, 'Checking…');
  await flush(3);
  assert.equal(refreshBtn.disabled, false);
  assert.equal(refreshBtn.textContent, 'Refresh');
});

test('tab switching persists the last tab across reloads and triggers a focus refresh', async () => {
  let focusStatusCalls = 0;
  await boot((msg) => {
    if (msg.type === 'GET_FOCUS_STATUS') {
      focusStatusCalls++;
      return { enabled: false, activity: { days: {} } };
    }
    return baseStatus();
  });
  const { document } = ctx;

  document.querySelector('.tab[data-tab="focus"]').click();
  await flush(2);
  assert.equal(focusStatusCalls, 1);
  assert.equal(ctx.window.localStorage.getItem('activedev:lastTab'), 'focus');
  assert.equal(document.getElementById('focus-tab').classList.contains('active'), true);
  assert.equal(document.getElementById('review-requests-tab').classList.contains('active'), false);

  ctx.cleanup();
  ctx = setupDom('popup/popup.html');
  ctx.window.localStorage.setItem('activedev:lastTab', 'my-prs');
  ctx.chrome.runtime.sendMessage = async () => baseStatus();
  await popupModule.initPopup();
  assert.equal(ctx.document.getElementById('my-prs-tab').classList.contains('active'), true);
});

test('theme toggle cycles system -> light -> dark and persists', async () => {
  await boot(() => baseStatus());
  const { document, chrome } = ctx;
  const button = document.getElementById('theme-toggle');
  assert.equal(button.textContent, '🖥️');

  button.click();
  await flush();
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(button.textContent, '☀️');

  button.click();
  await flush();
  assert.equal(document.documentElement.dataset.theme, 'dark');

  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.equal(stored.theme, 'dark');
});

test('user menu: opens, closes on outside click and Escape, Settings and Disconnect both work', async () => {
  await boot(() => baseStatus());
  const { document, chrome } = ctx;
  const menuBtn = document.getElementById('user-menu-btn');
  const panel = document.getElementById('user-menu-panel');

  menuBtn.click();
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(menuBtn.getAttribute('aria-expanded'), 'true');

  fire(document.body, 'click');
  assert.equal(panel.classList.contains('hidden'), true);

  menuBtn.click();
  fire(document, 'keydown', { key: 'Escape' });
  assert.equal(panel.classList.contains('hidden'), true);

  let openedOptions = false;
  chrome.runtime.openOptionsPage = () => (openedOptions = true);
  menuBtn.click();
  document.getElementById('menu-settings-btn').click();
  assert.equal(openedOptions, true);
  assert.equal(panel.classList.contains('hidden'), true, 'the menu also closes after choosing an action');

  menuBtn.click();
  document.getElementById('menu-logout-btn').click();
  await flush(2);
  assert.equal((await chrome.storage.local.get(STORAGE_KEYS.ACCESS_TOKEN))[STORAGE_KEYS.ACCESS_TOKEN], undefined);
  assert.match(document.getElementById('toast').textContent, /Disconnected/);
});

test('background polls update the open popup live via storage.onChanged', async () => {
  const status = baseStatus({ reviewRequests: [] });
  await boot(() => status);
  const { document, chrome } = ctx;
  assert.equal(document.querySelectorAll('#review-list .pr-item').length, 0);

  status.reviewRequests = [reviewRequestPR()];
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_CHECKED]: Date.now() });
  await flush(2);
  assert.equal(document.querySelectorAll('#review-list .pr-item').length, 1);
});

test('settings and footer Settings button both open the options page', async () => {
  await boot(() => baseStatus());
  const { document, chrome } = ctx;
  let opened = 0;
  chrome.runtime.openOptionsPage = () => opened++;
  document.getElementById('settings-btn').click();
  document.getElementById('open-options-btn').click();
  assert.equal(opened, 2);
});
