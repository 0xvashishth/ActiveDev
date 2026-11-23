import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { installFetchMock, jsonResponse, prNode, searchItem } from './helpers/github-mock.js';
import { STORAGE_KEYS, SERVER_URL, ALARM_NAME } from '../lib/constants.js';

// Covers background.js branches that tests/background.test.js's main
// narrative doesn't reach: lifecycle listeners, the message-switch default
// case, notification bookkeeping, and a couple of defensive catch blocks.

let chromeMock;
let fetchMock;
const send = (message) => chrome.runtime.sendMessage(message);
const stored = async (key) => (await chrome.storage.local.get(key))[key];

function routes() {
  return [
    [(url) => url.href === 'https://api.github.com/user', () => jsonResponse({ login: 'me' }, { headers: { 'x-oauth-scopes': 'repo' } })],
    ['https://api.github.com/search/issues', () => jsonResponse({ total_count: 0, items: [] })],
    ['https://api.github.com/graphql', (url, body) => jsonResponse({ data: { nodes: body.variables.ids.map(() => null) } })],
    ['https://api.github.com/user/orgs', () => jsonResponse([{ id: 1, login: 'acme' }])],
    ['https://api.github.com/user/memberships/orgs', () => jsonResponse([])],
    ['https://api.github.com/users/me/orgs', () => jsonResponse([])],
    [`${SERVER_URL}/api/auth/app`, () => jsonResponse({ client_id: 'x' })],
  ];
}

before(async () => {
  chromeMock = installChromeMock();
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
  fetchMock = installFetchMock(routes());
  await import('../background.js');
  await send({ type: 'CHECK_NOW' }); // establish a normal "everything is fine" baseline
});
after(() => fetchMock.restore());

// A few tests below swap in a narrower fetch mock to force an error path;
// reset to the full baseline before each test so that's never order-dependent.
beforeEach(() => {
  fetchMock.restore();
  fetchMock = installFetchMock(routes());
});

test('onInstalled opens the options page on a fresh install, but not on update; both (re)create the alarm', async () => {
  await chrome.alarms.clear(ALARM_NAME);
  chromeMock.runtime.openOptionsPage = () => chromeMock.__opened = (chromeMock.__opened || 0) + 1;

  await chrome.runtime.onInstalled.dispatch({ reason: 'update' });
  assert.equal(chromeMock.__opened, undefined);
  assert.ok(await chrome.alarms.get(ALARM_NAME));

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.runtime.onInstalled.dispatch({ reason: 'install' });
  assert.equal(chromeMock.__opened, 1);
  assert.ok(await chrome.alarms.get(ALARM_NAME));
});

test('onStartup re-creates the alarm if it is somehow missing', async () => {
  await chrome.alarms.clear(ALARM_NAME);
  // The listener itself fires ensureAlarm() without returning/awaiting it.
  await chrome.runtime.onStartup.dispatch();
  await new Promise((r) => setImmediate(r));
  assert.ok(await chrome.alarms.get(ALARM_NAME));
});

test('an unrecognized message type resolves to undefined instead of throwing', async () => {
  await assert.doesNotReject(send({ type: 'SOME_UNKNOWN_MESSAGE' }));
  assert.equal(await send({ type: 'SOME_UNKNOWN_MESSAGE' }), undefined);
});

test('USER_LOGGED_OUT clears the alarm and badge even when sent directly (not just on a 401)', async () => {
  await chrome.action.setBadgeText({ text: '3' });
  const result = await send({ type: 'USER_LOGGED_OUT' });
  assert.deepEqual(result, [true, undefined]);
  assert.equal(await chrome.alarms.get(ALARM_NAME), undefined);
  assert.equal(chromeMock.action._badge.text, '');
  // restore for subsequent tests in this file
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
  await send({ type: 'USER_AUTHENTICATED' });
});

test('clicking the "View PR" button on a plain (non-focus) notification opens its target', async () => {
  await send({ type: 'CHECK_NOW' });
  await chrome.storage.local.set({ ghrr_notification_map: { 'ghrr-review-1': 'https://github.com/a/b/pull/1' } });
  await chromeMock.notifications.onButtonClicked.dispatch('ghrr-review-1', 0);
  assert.ok(chromeMock.tabs._created.includes('https://github.com/a/b/pull/1'));
});

test('a closed notification is removed from the notification map', async () => {
  await chrome.storage.local.set({ ghrr_notification_map: { 'ghrr-review-2': 'https://github.com/a/b/pull/2', keep: 'x' } });
  await chrome.notifications.onClosed.dispatch('ghrr-review-2');
  assert.deepEqual(await stored('ghrr_notification_map'), { keep: 'x' });

  // Closing an id that was already removed (or never existed) is a no-op.
  await chrome.notifications.onClosed.dispatch('never-existed');
  assert.deepEqual(await stored('ghrr_notification_map'), { keep: 'x' });
});

test('a failure creating a notification is logged and does not crash the poll', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const realCreate = chromeMock.notifications.create;
  chromeMock.notifications.create = async () => {
    throw new Error('notifications API unavailable');
  };
  world_reviewRequestOnce();
  const result = await send({ type: 'CHECK_NOW' });
  assert.equal(result.success, true, 'the poll itself still succeeds');
  chromeMock.notifications.create = realCreate;

  function world_reviewRequestOnce() {
    const pr = searchItem({ owner: 'x', repo: 'y', number: 1, title: 'New', author: 'a' });
    fetchMock.restore();
    fetchMock = installFetchMock([
      [(url) => url.href === 'https://api.github.com/user', () => jsonResponse({ login: 'me' }, { headers: { 'x-oauth-scopes': 'repo' } })],
      ['https://api.github.com/search/issues', (url) => jsonResponse({ total_count: url.searchParams.get('q').includes('review-requested') ? 1 : 0, items: url.searchParams.get('q').includes('review-requested') ? [pr] : [] })],
      ['https://api.github.com/graphql', (url, body) => jsonResponse({ data: { nodes: body.variables.ids.map(() => prNode(pr)) } })],
      ['https://api.github.com/user/orgs', () => jsonResponse([])],
      ['https://api.github.com/user/memberships/orgs', () => jsonResponse([])],
      ['https://api.github.com/users/me/orgs', () => jsonResponse([])],
      [`${SERVER_URL}/api/auth/app`, () => jsonResponse({ client_id: 'x' })],
    ]);
  }
});

test('badge shows "!" when the last poll failed and there are no pending review requests to show instead', async () => {
  fetchMock.restore();
  fetchMock = installFetchMock([
    [(url) => url.href === 'https://api.github.com/user', () => jsonResponse({ message: 'oops' }, { status: 500 })],
  ]);
  await chrome.storage.local.set({ [STORAGE_KEYS.REVIEW_REQUEST_PRS]: [] });
  const result = await send({ type: 'CHECK_NOW' });
  assert.equal(result.success, false);
  assert.equal(chromeMock.action._badge.text, '!');
  assert.equal(chromeMock.action._badge.color, '#d29922');
});

test('CHECK_ORGS, FOCUS_SNOOZE, FOCUS_RESUME and FOCUS_RESET_ACTIVITY are wired straight to their handlers', async () => {
  assert.equal((await send({ type: 'CHECK_ORGS' })).success, true);

  await send({ type: 'FOCUS_SNOOZE', minutes: 45 });
  let status = await send({ type: 'GET_FOCUS_STATUS' });
  // The focus monitor is off by default, so snoozing has no visible effect,
  // but the message must still reach focusMonitor.snooze() without throwing.
  assert.equal(status.enabled, false);

  await send({ type: 'FOCUS_RESUME' });
  await send({ type: 'FOCUS_RESET_ACTIVITY' });
});

test('an org-access check failure that is not a rate-limit/auth error is logged but does not fail the poll', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  fetchMock.restore();
  fetchMock = installFetchMock([
    [(url) => url.href === 'https://api.github.com/user', () => jsonResponse({ login: 'me' }, { headers: { 'x-oauth-scopes': 'repo' } })],
    ['https://api.github.com/search/issues', () => jsonResponse({ total_count: 0, items: [] })],
    ['https://api.github.com/graphql', () => jsonResponse({ data: { nodes: [] } })],
    ['https://api.github.com/user/orgs', () => {
      throw new Error('network down');
    }],
    ['https://api.github.com/user/memberships/orgs', () => jsonResponse({ message: 'no' }, { status: 403 })],
    ['https://api.github.com/users/me/orgs', () => jsonResponse({ message: 'no' }, { status: 403 })],
  ]);
  await chrome.storage.local.remove(STORAGE_KEYS.ORGS_CHECKED_AT);
  const result = await send({ type: 'CHECK_NOW' });
  assert.equal(result.success, true);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('Organization check failed')));
});
