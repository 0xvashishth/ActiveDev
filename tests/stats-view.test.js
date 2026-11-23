import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, flush } from './helpers/dom-mock.js';
import { STORAGE_KEYS } from '../lib/constants.js';

const { mountStatsView } = await import('../popup/stats-view.js');

let ctx;
let container;
beforeEach(() => {
  ctx = setupDom('popup/popup.html');
  container = ctx.document.getElementById('stats-tab');
});
afterEach(() => ctx.cleanup());

function sample(overrides = {}) {
  return {
    version: 1,
    login: 'me',
    fetchedAt: Date.now() - 5 * 60_000,
    totals: { prsReviewed: 1280, prsMerged: 96, prsAuthored: 120, prsOpen: 4, mergeRate: 80 },
    windows: {
      last30: { reviewsSubmitted: 14, prsOpened: 6, prsMerged: 5 },
      thisYear: { reviewsSubmitted: 210, prsOpened: 40, prsMerged: 33 },
    },
    repos: [
      { nameWithOwner: 'acme/api', url: 'https://github.com/acme/api', isPrivate: true, reviewed: 400, merged: 30, authored: 40, exact: true },
      { nameWithOwner: 'acme/web', url: 'https://github.com/acme/web', isPrivate: false, reviewed: 120, merged: 50, authored: 55, exact: true },
      { nameWithOwner: 'me/dotfiles', url: 'https://github.com/me/dotfiles', isPrivate: false, reviewed: 0, merged: 3, authored: 0, exact: false },
    ],
    coverage: { reviewedSampled: 100, mergedSampled: 96, reposOmitted: 2, truncated: true },
    ...overrides,
  };
}

/** Scripts the background: GET returns `get`, REFRESH returns `refresh` (or throws). */
function script({ get, refresh }) {
  const calls = [];
  ctx.chrome.runtime.sendMessage = async (msg) => {
    calls.push(msg.type);
    if (msg.type === 'GET_CONTRIBUTIONS') return typeof get === 'function' ? get() : get;
    if (msg.type === 'REFRESH_CONTRIBUTIONS') return typeof refresh === 'function' ? refresh() : refresh;
    return undefined;
  };
  return calls;
}

const repoNames = () => [...container.querySelectorAll('.repo-name')].map((a) => a.textContent.replace('🔒 ', ''));

test('renders totals, recent windows, and the per-repo breakdown from cached data', async () => {
  script({ get: { authenticated: true, data: sample(), stale: false } });
  await mountStatsView(container).load();

  const text = container.textContent;
  assert.match(text, /1\.3k/); // 1280 reviewed, compact
  assert.match(text, /PRs reviewed/);
  assert.match(text, /96/);
  assert.match(text, /PRs opened/);
  assert.match(container.querySelector('.stat-sub').textContent, /80% merged/);
  assert.match(text, /Last 30 days/);
  assert.match(text, /14 reviews/);
  assert.match(text, /This year/);
  assert.match(text, /updated 5m ago/);
  assert.deepEqual(repoNames(), ['acme/api', 'acme/web', 'me/dotfiles'], 'default sort is by activity');
  assert.match(container.querySelector('.repo-name').textContent, /^🔒 /, 'private repos get a lock');
  assert.match(text, /~ recent only/, 'inexact repos are flagged');
  assert.match(text, /2 more not shown/);
  assert.match(text, /75% merged/); // acme/api: 30 of 40
});

test('sort buttons reorder the repository list', async () => {
  script({ get: { authenticated: true, data: sample(), stale: false } });
  const view = mountStatsView(container);
  await view.load();

  const seg = (label) => [...container.querySelectorAll('.seg')].find((b) => b.textContent === label);
  seg('Merged').click();
  assert.deepEqual(repoNames(), ['acme/web', 'acme/api', 'me/dotfiles']);
  assert.equal(seg('Merged').getAttribute('aria-pressed'), 'true');

  seg('Name').click();
  assert.deepEqual(repoNames(), ['acme/api', 'acme/web', 'me/dotfiles']);

  seg('Reviewed').click();
  assert.equal(repoNames()[0], 'acme/api');
  assert.equal(view.getState().sortBy, 'reviewed');
});

test('clicking a repository opens it on GitHub', async () => {
  script({ get: { authenticated: true, data: sample(), stale: false } });
  await mountStatsView(container).load();
  container.querySelector('.repo-name').click();
  assert.deepEqual(ctx.chrome.tabs._created, ['https://github.com/acme/api']);
});

test('no cached data: shows the intro; "Load my stats" fetches and renders', async () => {
  const calls = script({ get: { authenticated: true, data: null, stale: true }, refresh: { success: true, data: sample() } });
  // stale + no data → load() auto-refreshes; make the first GET non-stale to test the manual button instead
  ctx.chrome.runtime.sendMessage = async (msg) => {
    calls.push(msg.type);
    if (msg.type === 'GET_CONTRIBUTIONS') return { authenticated: true, data: null, stale: false };
    return { success: true, data: sample() };
  };
  const view = mountStatsView(container);
  await view.load();
  assert.match(container.textContent, /No stats yet/);

  container.querySelector('.btn-primary').click();
  await flush(2);
  assert.match(container.textContent, /PRs reviewed/);
  assert.deepEqual(calls, ['GET_CONTRIBUTIONS', 'REFRESH_CONTRIBUTIONS']);
});

test('stale cached data is shown immediately and refreshed in the background', async () => {
  const fresh = sample({ totals: { prsReviewed: 2000, prsMerged: 1, prsAuthored: 1, prsOpen: 0, mergeRate: 100 } });
  const calls = script({
    get: { authenticated: true, data: sample({ fetchedAt: Date.now() - 10 * 3_600_000 }), stale: true },
    refresh: { success: true, data: fresh },
  });
  await mountStatsView(container).load();
  assert.deepEqual(calls, ['GET_CONTRIBUTIONS', 'REFRESH_CONTRIBUTIONS']);
  assert.match(container.textContent, /2\.0k/, 'the refreshed numbers replaced the stale ones');
});

test('a refresh failure keeps the last saved numbers and explains what happened', async () => {
  script({ get: { authenticated: true, data: sample(), stale: false }, refresh: { success: false, error: 'rate limited' } });
  await mountStatsView(container).load();
  container.querySelector('.stats-header button').click();
  await flush(2);
  assert.match(container.textContent, /Refresh failed: rate limited\. Showing the last saved numbers\./);
  assert.match(container.textContent, /PRs reviewed/);
});

test('a refresh failure with nothing cached offers Try again; a transport error is reported too', async () => {
  script({ get: { authenticated: true, data: null, stale: true }, refresh: { success: false, error: 'GraphQL down' } });
  await mountStatsView(container).load();
  assert.match(container.textContent, /Could not load stats/);
  assert.match(container.textContent, /GraphQL down/);
  assert.equal(container.querySelector('.btn-primary').textContent, 'Try again');

  ctx.chrome.runtime.sendMessage = async () => {
    throw new Error('no background');
  };
  await mountStatsView(container).load();
  assert.match(container.textContent, /no background/);
});

test('while loading with no data yet, a spinner is shown and the refresh button is disabled', async () => {
  let resolveRefresh;
  script({
    get: { authenticated: true, data: null, stale: true },
    refresh: () => new Promise((resolve) => (resolveRefresh = resolve)),
  });
  const view = mountStatsView(container);
  const loading = view.load();
  await flush();
  assert.ok(container.querySelector('.spinner'));
  assert.equal(container.querySelector('.stats-header button').disabled, true);
  assert.match(container.textContent, /Counting your reviews and merges/);
  resolveRefresh({ success: true, data: sample() });
  await loading;
  assert.equal(container.querySelector('.spinner'), null);

  // A second refresh while one is in flight is ignored.
  script({ get: {}, refresh: () => new Promise(() => {}) });
  view.refresh();
  await flush();
  assert.equal(view.getState().refreshing, true);
  view.refresh();
  assert.equal(view.getState().refreshing, true);
});

test('signed out: nothing is rendered beyond the intro, and no refresh is attempted', async () => {
  const calls = script({ get: { authenticated: false, data: null, stale: false } });
  await mountStatsView(container).load();
  assert.deepEqual(calls, ['GET_CONTRIBUTIONS']);
  assert.match(container.textContent, /No stats yet/);
});

test('a refresh completed by another page (storage change) updates the view live', async () => {
  script({ get: { authenticated: true, data: sample(), stale: false } });
  await mountStatsView(container).load();
  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.CONTRIBUTIONS]: sample({ totals: { prsReviewed: 7, prsMerged: 7, prsAuthored: 7, prsOpen: 0, mergeRate: 100 } }) });
  await flush();
  assert.match(container.querySelector('.stats').textContent, /7PRs reviewed/);
  await ctx.chrome.storage.local.remove(STORAGE_KEYS.CONTRIBUTIONS); // a removal (logout) is ignored, not a crash
});

test('an empty repository list explains itself', async () => {
  script({ get: { authenticated: true, data: sample({ repos: [], coverage: { reposOmitted: 0 } }), stale: false } });
  await mountStatsView(container).load();
  assert.match(container.textContent, /No reviewed or merged pull requests found yet/);
  assert.equal(container.textContent.includes('more not shown'), false);
});
