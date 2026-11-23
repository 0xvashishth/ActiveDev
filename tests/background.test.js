import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { installFetchMock, jsonResponse, prNode, review, searchItem, thread } from './helpers/github-mock.js';
import { STORAGE_KEYS, SERVER_URL, ALARM_NAME } from '../lib/constants.js';

const RESTRICTED_MSG = 'the `locked` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';

// ----- fake GitHub "world" that tests mutate between polls -----
const teamRequest = searchItem({ owner: 'acme', repo: 'api', number: 11, title: 'Team request', author: 'alice' });
const directRequest = searchItem({ owner: 'me', repo: 'tool', number: 2, title: 'Direct request', author: 'bob', draft: true });
const myPr = searchItem({ owner: 'acme', repo: 'web', number: 5, title: 'My feature', author: 'me' });
const laterRequest = searchItem({ owner: 'acme', repo: 'api', number: 12, title: 'Brand new request', author: 'carol' });

const world = {
  userStatus: 200,
  reviewRequests: [teamRequest, directRequest],
  myPRs: [myPr],
  details: {
    [teamRequest.node_id]: prNode(teamRequest, {
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'backend', name: 'Backend', organization: { login: 'acme' } } }] },
      reviews: { totalCount: 1, nodes: [review('RV1', 'dave', 'APPROVED', '2024-05-02T00:00:00Z')] },
      reviewThreads: { totalCount: 2, nodes: [thread({ starter: 'dave' }), thread({ resolved: true, starter: 'dave' })] },
    }),
    [directRequest.node_id]: prNode(directRequest, {
      isDraft: true,
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
    }),
    [myPr.node_id]: prNode(myPr, {
      reviews: { totalCount: 1, nodes: [review('RV2', 'erin', 'COMMENTED', '2024-05-02T00:00:00Z')] },
      reviewThreads: { totalCount: 1, nodes: [thread({ starter: 'erin' })] },
    }),
    [laterRequest.node_id]: prNode(laterRequest, {
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
      viewerLatestReview: { state: 'COMMENTED', submittedAt: '2024-05-01T00:00:00Z', commit: { oid: 'sha-old' } },
    }),
  },
  searchSsoHeader: 'partial-results; organizations=3',
};

let fetchMock;
let chromeMock;

function routes() {
  return [
    [
      (url) => url.href === 'https://api.github.com/user',
      () =>
        world.userStatus === 200
          ? jsonResponse({ login: 'me', avatar_url: 'https://avatars/me' }, { headers: { 'x-oauth-scopes': 'repo, read:org, read:user' } })
          : jsonResponse({ message: 'Bad credentials' }, { status: world.userStatus }),
    ],
    [
      'https://api.github.com/search/issues',
      (url) => {
        const q = url.searchParams.get('q');
        const items = q.includes('review-requested:me') ? world.reviewRequests : world.myPRs;
        if (world.searchRateLimited) {
          return jsonResponse({ message: 'limit' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } });
        }
        return jsonResponse({ total_count: items.length, items }, { headers: world.searchSsoHeader ? { 'x-github-sso': world.searchSsoHeader } : {} });
      },
    ],
    [
      'https://api.github.com/graphql',
      (url, body) => {
        if (body.query.includes('OrgAccess')) {
          return jsonResponse({
            data: { o0: { login: 'acme' }, o1: { login: 'locked', teams: null }, o2: { login: 'samlco' } },
            errors: [{ type: 'FORBIDDEN', path: ['o1', 'teams'], message: RESTRICTED_MSG }],
          });
        }
        return jsonResponse({ data: { nodes: body.variables.ids.map((id) => world.details[id] || null) } });
      },
    ],
    ['https://api.github.com/user/orgs', () => jsonResponse([{ id: 1, login: 'acme' }, { id: 2, login: 'locked' }, { id: 3, login: 'samlco' }])],
    ['https://api.github.com/user/memberships/orgs', () => jsonResponse([])],
    ['https://api.github.com/users/me/orgs', () => jsonResponse([])],
    [`${SERVER_URL}/api/auth/app`, () => jsonResponse({ client_id: 'Iv1.client' })],
  ];
}

const send = (message) => chrome.runtime.sendMessage(message);
const stored = async (key) => (await chrome.storage.local.get(key))[key];

before(async () => {
  chromeMock = installChromeMock();
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
  fetchMock = installFetchMock(routes());
  await import('../background.js');
});
after(() => fetchMock.restore());

test('service worker start registers the polling alarm', async () => {
  await new Promise((r) => setTimeout(r, 10));
  const alarm = await chrome.alarms.get(ALARM_NAME);
  assert.equal(alarm.periodInMinutes, 3);
});

test('first poll stores enriched PRs, org access and SSO info without notifying', async () => {
  const [a, b] = await Promise.all([send({ type: 'CHECK_NOW' }), send({ type: 'CHECK_NOW' })]);
  assert.deepEqual(a, { success: true });
  assert.deepEqual(b, { success: true });
  const userCalls = fetchMock.calls.filter((c) => c.url.href === 'https://api.github.com/user');
  assert.equal(userCalls.length, 1, 'concurrent checks share a single run');

  const status = await send({ type: 'GET_STATUS' });
  assert.equal(status.authenticated, true);
  assert.equal(status.user.login, 'me');
  assert.deepEqual(status.missingScopes, []);

  const team = status.reviewRequests.find((p) => p.number === 11);
  assert.equal(team.viewerRequestVia, 'team');
  assert.deepEqual(team.requestedTeams, ['acme/backend']);
  assert.deepEqual(team.otherReviewers.map((r) => r.login), ['dave'], 'already reviewed by someone else');
  assert.equal(team.threads.unresolved, 1);
  assert.equal(team.threads.resolved, 1);

  const mine = status.myPRs[0];
  assert.equal(mine.threads.awaitingViewer, 1, 'unresolved thread waiting on my reply');

  const orgs = Object.fromEntries(status.orgs.map((o) => [o.login, o.access]));
  assert.deepEqual(orgs, { acme: 'ok', locked: 'oauth_restricted', samlco: 'sso_required' });
  assert.deepEqual(status.ssoOrgs, [{ id: 3, login: 'samlco' }]);

  assert.equal(chromeMock.notifications._created.length, 0, 'no notifications on the first check');
  assert.equal(chromeMock.action._badge.text, '2');
});

test('second poll notifies about a new (re-)request and a new review on my PR', async () => {
  world.reviewRequests = [teamRequest, directRequest, laterRequest];
  world.details[myPr.node_id].reviews.nodes.push(review('RV3', 'frank', 'CHANGES_REQUESTED', '2024-05-03T00:00:00Z', 'sha-head', 'Please add tests'));
  world.details[myPr.node_id].reviews.nodes.push(review('RV4', 'me', 'COMMENTED', '2024-05-03T01:00:00Z'));

  await send({ type: 'CHECK_NOW' });
  const created = chromeMock.notifications._created;
  assert.equal(created.length, 2);

  const req = created.find((n) => n.id.startsWith('ghrr-review-'));
  assert.equal(req.title, 'Re-review requested');
  assert.match(req.message, /acme\/api#12: Brand new request/);

  const rev = created.find((n) => n.id.startsWith('ghrr-reviewed-'));
  assert.equal(rev.title, 'frank requested changes on #5');
  assert.equal(rev.contextMessage, 'Please add tests');

  // Clicking a notification opens the PR / review.
  chromeMock.notifications.onClicked.dispatch(rev.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(chromeMock.tabs._created.at(-1), /pullrequestreview-RV3/);

  // Polling again with no changes must not notify again.
  await send({ type: 'CHECK_NOW' });
  assert.equal(created.length, 2);
});

test('draft filter applies to popup list and badge', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { includeDraftReviewRequests: false, pollIntervalMinutes: 10 } });
  await send({ type: 'SETTINGS_UPDATED' });
  const status = await send({ type: 'GET_STATUS' });
  assert.equal(status.reviewRequests.some((p) => p.draft), false);
  assert.equal(chromeMock.action._badge.text, '2');
  assert.equal((await chrome.alarms.get(ALARM_NAME)).periodInMinutes, 10, 'alarm follows the new interval');
});

test('rate limiting keeps cached data, records the error and skips scheduled polls', async () => {
  world.searchRateLimited = true;
  const result = await send({ type: 'CHECK_NOW' });
  assert.equal(result.success, false);
  const status = await send({ type: 'GET_STATUS' });
  assert.equal(status.lastError.kind, 'rate_limited');
  assert.equal(status.reviewRequests.length, 2, 'cached PRs are still shown');
  assert.ok((await stored(STORAGE_KEYS.RATE_LIMIT_RESET)) > Date.now());

  const before = fetchMock.calls.length;
  chromeMock.alarms.onAlarm.dispatch({ name: ALARM_NAME });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchMock.calls.length, before, 'scheduled poll skipped until the limit resets');

  world.searchRateLimited = false;
  await send({ type: 'CHECK_NOW' });
  assert.equal((await send({ type: 'GET_STATUS' })).lastError, null, 'error cleared after a successful poll');
});

test('focus monitor wiring: cleared reviews are recorded and focus notifications are routed', async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { ...(await stored(STORAGE_KEYS.SETTINGS)), focusEnabled: true },
  });
  await send({ type: 'FOCUS_SETTINGS_UPDATED' });
  assert.ok(await chrome.alarms.get('focus-tick'));

  world.reviewRequests = [teamRequest]; // the other two were reviewed
  await send({ type: 'CHECK_NOW' });
  const activity = await stored(STORAGE_KEYS.ACTIVITY);
  assert.equal(Object.values(activity.days)[0].reviewsCleared, 2);

  const sent = await send({ type: 'FOCUS_TEST_NUDGE' });
  assert.equal(sent.sent, true);
  const nudge = chromeMock.notifications._created.at(-1);
  assert.match(nudge.message, /Team request/);

  chromeMock.notifications.onButtonClicked.dispatch(nudge.id, 1); // Snooze
  await new Promise((r) => setTimeout(r, 20));
  const status = await send({ type: 'GET_FOCUS_STATUS' });
  assert.ok(status.snoozedUntil > Date.now());
  assert.equal(chromeMock.tabs._created.filter((u) => u.includes('acme/api/pull/11')).length, 0, 'snooze does not open the PR');
});

test('a non-auth error does not log the user out; a 401 does', async () => {
  world.userStatus = 500;
  await send({ type: 'CHECK_NOW' });
  assert.equal(await stored(STORAGE_KEYS.ACCESS_TOKEN), 'tok');

  world.userStatus = 401;
  await send({ type: 'CHECK_NOW' });
  assert.equal(await stored(STORAGE_KEYS.ACCESS_TOKEN), undefined);
  assert.equal(await stored(STORAGE_KEYS.REVIEW_REQUEST_PRS), undefined);
  assert.ok(await stored(STORAGE_KEYS.SETTINGS), 'settings survive logout');
  assert.ok(await stored(STORAGE_KEYS.ACTIVITY), 'focus history survives logout');
  assert.deepEqual(await send({ type: 'GET_STATUS' }), { authenticated: false });
});
