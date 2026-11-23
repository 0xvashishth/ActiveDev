import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { FOCUS_ALARM_NAME, STORAGE_KEYS, DEFAULT_SETTINGS } from '../lib/constants.js';
import { initFocusMonitor } from '../lib/focus-monitor.js';

const MIN = 60_000;
const REVIEW = {
  id: 1, owner: 'acme', repo: 'api', number: 482, title: 'Add idempotency keys', author: 'alice',
  htmlUrl: 'https://github.com/acme/api/pull/482', additions: 40, deletions: 2, createdAt: new Date().toISOString(),
  otherReviewers: [], viewerReview: null, draft: false,
};

let chromeMock;
let clock;
let work;
let monitor;

async function setup(settings = {}) {
  chromeMock = installChromeMock();
  clock = new Date(2024, 4, 6, 10, 0).getTime(); // Monday 10:00 local
  work = { reviewRequests: [REVIEW], myPRs: [], todos: [] };
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { focusEnabled: true, focusSites: ['youtube.com', 'netflix.com'], ...settings },
  });
  chromeMock._browser.grantedOrigins.add('*://*.youtube.com/*'); // netflix NOT granted
  monitor = initFocusMonitor({ now: () => clock, getPendingWork: async () => work });
  await monitor.sync();
}

const browse = (url, extra = {}) => {
  chromeMock._browser.tab = { id: 7, url, ...extra };
};
/** Advances the clock minute by minute, running the 1-minute alarm tick each time. */
async function minutes(n) {
  for (let i = 0; i < n; i++) {
    clock += MIN;
    await monitor.step();
  }
}
const activity = async () => (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITY))[STORAGE_KEYS.ACTIVITY];
const today = async () => Object.values((await activity())?.days || {})[0];
const nudges = () => chromeMock.notifications._created.filter((n) => n.id.startsWith('ghrr-focus-'));

beforeEach(() => setup());

test('enabling creates the tick alarm; disabling removes it and stops tracking', async () => {
  assert.ok(await chrome.alarms.get(FOCUS_ALARM_NAME));
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, focusEnabled: false } });
  await monitor.sync();
  assert.equal(await chrome.alarms.get(FOCUS_ALARM_NAME), undefined);
  browse('https://www.youtube.com/watch?v=1', { audible: true });
  await minutes(40);
  assert.equal(await activity(), undefined, 'nothing recorded while disabled');
  assert.equal(nudges().length, 0);
});

test('an hour of YouTube: nudge at 30 min with the pending review, repeated every 15 min', async () => {
  browse('https://www.youtube.com/watch?v=1', { audible: true });
  chromeMock._browser.idleState = 'idle'; // watching, not touching the mouse: audio keeps it counting
  await monitor.step();

  await minutes(29);
  assert.equal(nudges().length, 0);
  await minutes(1);
  assert.equal(nudges().length, 1);
  const first = nudges()[0];
  assert.equal(first.title, '⏰ 30m on YouTube. A review is waiting for you');
  assert.match(first.message, /Instead of more YouTube, there's a pending review: alice's "Add idempotency keys" \(acme\/api#482\)/);
  assert.match(first.message, /enjoy the rest/);
  assert.deepEqual(first.buttons.map((b) => b.title), ['Open it now', 'Snooze 60 min']);

  await minutes(14);
  assert.equal(nudges().length, 1);
  await minutes(1);
  assert.equal(nudges().length, 2, 'repeats after 15 more minutes');
  assert.notEqual(nudges()[1].message, first.message, 'wording varies');

  const day = await today();
  assert.equal(day.sites['youtube.com'], 45 * MIN);
  assert.equal(day.nudges, 2);
  assert.equal(day.longestSessionMs, 45 * MIN);
});

test('"Open it now" opens the PR and counts as acted on; "Snooze" silences reminders', async () => {
  browse('https://youtube.com/watch?v=1', { audible: true });
  await monitor.step();
  await minutes(30);
  const id = nudges()[0].id;

  await monitor.onNotificationButton(id, 0);
  assert.deepEqual(chromeMock.tabs._created, ['https://github.com/acme/api/pull/482']);
  assert.equal((await today()).nudgeClicks, 1);

  await minutes(15);
  assert.equal(nudges().length, 2);
  await monitor.onNotificationButton(nudges()[1].id, 1); // snooze 60 min
  await minutes(59);
  assert.equal(nudges().length, 2, 'no reminders while snoozed');
  await minutes(1);
  assert.equal(nudges().length, 3, 'reminders resume after the snooze');
});

test('no pending work means no nudge; todos are used when there are no reviews', async () => {
  work = { reviewRequests: [], myPRs: [], todos: [] };
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  await minutes(40);
  assert.equal(nudges().length, 0);

  work = { reviewRequests: [], myPRs: [], todos: [{ text: 'Write release notes', done: false, link: null }] };
  await minutes(1);
  assert.equal(nudges().length, 1);
  assert.match(nudges()[0].message, /open todo today, like "Write release notes"/);
  assert.deepEqual(nudges()[0].buttons.map((b) => b.title), ['Snooze 60 min']);
});

test('time counts only when it should', async () => {
  // In Chrome every one of these changes fires an event (idle.onStateChanged,
  // tabs.onUpdated, windows.onFocusChanged) that closes the running segment.
  const change = async (fn) => {
    fn();
    await monitor.step();
  };
  const b = chromeMock._browser;

  await change(() => browse('https://youtube.com/', { audible: false }));
  await minutes(5); // focused + active: counts
  await change(() => (b.idleState = 'idle'));
  await minutes(5); // idle, silent: does not count
  await change(() => {
    b.idleState = 'locked';
    browse('https://youtube.com/', { audible: true });
  });
  await minutes(5); // locked: never counts
  await change(() => {
    b.idleState = 'active';
    b.windowFocused = false;
    browse('https://youtube.com/', { audible: false });
  });
  await minutes(5); // working in another app
  await change(() => browse('https://youtube.com/', { audible: true }));
  await minutes(5); // music in the background while working in another app
  await change(() => {
    b.windowFocused = true;
    browse('https://www.netflix.com/watch/1', { audible: true });
  });
  await minutes(5); // listed but permission not granted → URL invisible → not tracked
  await change(() => browse('https://example.com/'));
  await minutes(5); // not listed
  await change(() => browse('https://github.com/acme/api/pull/482/files'));
  await minutes(7); // reviewing

  const day = await today();
  assert.equal(day.sites['youtube.com'], 5 * MIN);
  assert.equal(day.sites['netflix.com'], undefined);
  assert.equal(day.reviewMs, 7 * MIN);
});

test('sleep/hibernate gaps are capped instead of counted as watching', async () => {
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  clock += 2 * 60 * MIN; // laptop closed for 2 hours
  await monitor.step();
  assert.equal((await today()).sites['youtube.com'], 3 * MIN);
});

test('a real break resets the session; a quick detour does not', async () => {
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  await minutes(20);
  browse('https://github.com/acme/api/pull/1');
  await minutes(3); // quick detour
  browse('https://youtube.com/', { audible: true });
  await minutes(10);
  assert.equal(nudges().length, 1, 'detour kept the session: 30 min reached');

  browse('https://github.com/acme/api/pull/1');
  await minutes(10); // real break
  browse('https://youtube.com/', { audible: true });
  await minutes(20);
  assert.equal(nudges().length, 1, 'new session has not reached 30 min yet');
});

test('work-hours-only: no reminders on the weekend', async () => {
  await setup({ focusWorkHoursOnly: true, focusWeekdaysOnly: true });
  clock = new Date(2024, 4, 4, 11, 0).getTime(); // Saturday
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  await minutes(90);
  assert.equal(nudges().length, 0);
  assert.equal((await today()).sites['youtube.com'], 90 * MIN, 'time is still measured');
});

test('tab events trigger accounting immediately (not only on the tick)', async () => {
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  clock += 40_000;
  browse('https://example.com/');
  chromeMock.tabs.onActivated.dispatch({ tabId: 7 });
  await new Promise((r) => setTimeout(r, 20));
  await monitor.step(); // wait for queued work
  assert.equal((await today()).sites['youtube.com'], 40_000);
});

test('a closed window (chrome.windows.get throwing) is treated as not focused, not a crash', async () => {
  browse('https://youtube.com/', { audible: false });
  chromeMock._browser.windowFocused = true;
  const realGet = chromeMock.windows.get;
  chromeMock.windows.get = async () => {
    throw new Error('No window with id');
  };
  await monitor.step();
  await minutes(5);
  assert.equal((await today())?.sites?.['youtube.com'], undefined, 'not counted: window is effectively unfocused');
  chromeMock.windows.get = realGet;
});

test('tab lifecycle events (onUpdated for the active tab, onRemoved) trigger accounting too', async () => {
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  clock += 30_000;
  await chromeMock.tabs.onUpdated.dispatch(7, { status: 'complete' }, { active: true });

  clock += 20_000;
  browse('https://example.com/');
  await chromeMock.tabs.onUpdated.dispatch(7, { url: 'x' }, { active: false }); // not the active tab: ignored
  assert.equal((await today()).sites['youtube.com'], 30_000, 'the update on an inactive tab did not flush the 20s segment yet');

  // No step ran while example.com was active, so this whole 20s+15s stretch
  // is (correctly, for sampling-based accounting) attributed to the last
  // *observed* state, which was still youtube.com.
  browse('https://youtube.com/', { audible: true });
  clock += 15_000;
  await chromeMock.tabs.onRemoved.dispatch(99);
  assert.equal((await today()).sites['youtube.com'], 30_000 + 35_000);
});

test('status reports missing permissions, session and snooze; extras work', async () => {
  browse('https://youtube.com/', { audible: true });
  await monitor.step();
  await minutes(12);
  let status = await monitor.getStatus();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.missingPermissions, ['netflix.com']);
  assert.equal(status.current.site, 'youtube.com');
  assert.equal(status.session.ms, 12 * MIN);

  await monitor.snooze(30);
  status = await monitor.getStatus();
  assert.equal(status.snoozedUntil, clock + 30 * MIN);
  await monitor.resume();
  assert.equal((await monitor.getStatus()).snoozedUntil, 0);

  await monitor.recordReviewsCleared(2);
  assert.equal((await today()).reviewsCleared, 2);

  assert.deepEqual(await monitor.testNudge(), { sent: true });
  assert.match(nudges().at(-1).title, /on YouTube/);

  await monitor.resetActivity();
  assert.deepEqual((await activity()).days, {});
});
