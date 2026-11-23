import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers/dom-mock.js';
import { DEFAULT_SETTINGS } from '../lib/constants.js';

// focus-view.js has no top-level mutable state, so it's imported once for
// accurate coverage (see tests/popup.test.js for the full rationale).
const { mountFocusView } = await import('../popup/focus-view.js');
const { _resetToastStateForTests } = await import('../popup/dom.js');

let ctx;
let container;

beforeEach(() => {
  ctx = setupDom('popup/popup.html');
  container = ctx.document.getElementById('focus-tab');
});
afterEach(() => {
  _resetToastStateForTests();
  ctx.cleanup();
});

function baseStatus(overrides = {}) {
  return {
    enabled: true,
    settings: { ...DEFAULT_SETTINGS, focusEnabled: true },
    now: Date.now(),
    current: null,
    session: null,
    snoozedUntil: 0,
    activity: { version: 1, days: {} },
    missingPermissions: [],
    ...overrides,
  };
}

test('disabled: shows the setup intro, and a 7-day chart if there is history', async () => {
  ctx.chrome.runtime.sendMessage = async () => baseStatus({ enabled: false, activity: { days: {} } });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Focus monitor is off/);
  assert.equal(container.querySelector('.week-chart'), null, 'no chart without history');

  const today = new Date().toISOString().slice(0, 10);
  ctx.chrome.runtime.sendMessage = async () =>
    baseStatus({ enabled: false, activity: { days: { [today]: { sites: { 'youtube.com': 600_000 }, reviewMs: 0 } } } });
  await mountFocusView(container).refresh();
  assert.notEqual(container.querySelector('.week-chart'), null, 'history is shown even while off');

  let opened;
  ctx.chrome.tabs.create = ({ url }) => (opened = url);
  container.querySelector('.btn-primary').click();
  assert.match(opened, /options\/options\.html#focus$/);
});

test('on a distracting site: shows the live session, time-to-reminder, and stats/insights', async () => {
  const today = new Date().toISOString().slice(0, 10);
  ctx.chrome.runtime.sendMessage = async () =>
    baseStatus({
      current: { category: 'distraction', site: 'youtube.com', counting: true },
      session: { ms: 20 * 60_000, site: 'youtube.com' },
      activity: { days: { [today]: { sites: { 'youtube.com': 20 * 60_000 }, reviewMs: 0, reviewsCleared: 0 } } },
    });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /YouTube: 20m this session/);
  assert.match(container.textContent, /reminder in 10m/);
  assert.match(container.textContent, /20m/); // stat tile
  assert.match(container.textContent, /YouTube is your biggest distraction today/);
});

test('reminder-is-now and reviewing states render distinct headlines', async () => {
  ctx.chrome.runtime.sendMessage = async () =>
    baseStatus({
      current: { category: 'distraction', site: 'youtube.com', counting: true },
      session: { ms: 61 * 60_000, site: 'youtube.com' },
    });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /reminders are on/);

  ctx.chrome.runtime.sendMessage = async () => baseStatus({ current: { category: 'review', counting: true } });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Reviewing on GitHub/);

  ctx.chrome.runtime.sendMessage = async () =>
    baseStatus({ current: { category: null, counting: false }, session: { ms: 5 * 60_000, site: 'reddit.com' } });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /On a break from Reddit/);

  ctx.chrome.runtime.sendMessage = async () => baseStatus();
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Not on a distracting site right now/);
});

test('snooze and resume round-trip through the background and refresh the view', async () => {
  let snoozeCalls = 0;
  const snoozedUntil = Date.now() + 60 * 60_000;
  ctx.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'FOCUS_SNOOZE') {
      snoozeCalls++;
      assert.equal(msg.minutes, 60);
      return { success: true };
    }
    return baseStatus({ snoozedUntil: snoozeCalls ? snoozedUntil : 0 });
  };
  const view = mountFocusView(container);
  await view.refresh();
  assert.match(container.textContent, /Snooze 60 min/);

  container.querySelector('button.link-btn').click(); // Snooze
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(snoozeCalls, 1);
  assert.match(container.textContent, /Reminders snoozed until/);
  assert.match(ctx.document.getElementById('toast').textContent, /snoozed for 60 minutes/);

  let resumed = false;
  ctx.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'FOCUS_RESUME') {
      resumed = true;
      return { success: true };
    }
    return baseStatus();
  };
  container.querySelector('button.link-btn').click(); // Resume
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resumed, true);
  assert.match(container.textContent, /Snooze 60 min/);
});

test('missing site permissions show a warning with a fix link to Settings', async () => {
  ctx.chrome.runtime.sendMessage = async () => baseStatus({ missingPermissions: ['netflix.com', 'reddit.com'] });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /No access to netflix\.com, reddit\.com/);

  let opened;
  ctx.chrome.tabs.create = ({ url }) => (opened = url);
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Fix').click();
  assert.match(opened, /options\.html#focus$/);
});

test('today with no distraction shows a clean-slate message instead of an empty bar list', async () => {
  ctx.chrome.runtime.sendMessage = async () => baseStatus();
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /No time on distracting sites today/);
  assert.equal(container.querySelector('.insights'), null, 'no insights with nothing to report');
});

test('handles a failed or missing response without throwing', async () => {
  ctx.chrome.runtime.sendMessage = async () => {
    throw new Error('disconnected');
  };
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Could not load focus data: disconnected/);

  ctx.chrome.runtime.sendMessage = async () => ({ success: false, error: 'not ready' });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /not ready/);

  ctx.chrome.runtime.sendMessage = async () => undefined;
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Focus data unavailable/);
});

test('the footer links to Settings and reports how many sites are monitored', async () => {
  ctx.chrome.runtime.sendMessage = async () => baseStatus({ settings: { ...DEFAULT_SETTINGS, focusSites: ['youtube.com'] } });
  await mountFocusView(container).refresh();
  assert.match(container.textContent, /Measuring 1 site ·/);
});
