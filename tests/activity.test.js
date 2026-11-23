import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/constants.js';
import {
  SESSION_BREAK_MS,
  addTime,
  advanceSession,
  buildInsights,
  buildNudge,
  classifyUrl,
  emptyActivity,
  emptySession,
  formatDuration,
  incrementDay,
  isCounting,
  isNudgeDue,
  lastDays,
  normalizeSite,
  pruneActivity,
  rankReviewRequests,
  recordLongestSession,
  siteBreakdown,
  withinWorkHours,
} from '../lib/activity.js';

const MIN = 60_000;
const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, focusEnabled: true, ...over });

test('normalizeSite accepts URLs and hosts, rejects junk and GitHub', () => {
  assert.equal(normalizeSite('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(normalizeSite(' reddit.com '), 'reddit.com');
  assert.equal(normalizeSite('m.twitch.tv'), 'm.twitch.tv');
  assert.equal(normalizeSite('not a site'), null);
  assert.equal(normalizeSite('localhost'), null);
  assert.equal(normalizeSite('github.com'), null);
  assert.equal(normalizeSite(''), null);
});

test('classifyUrl: listed sites (incl. subdomains), GitHub PR pages, everything else ignored', () => {
  const sites = ['youtube.com', 'ycombinator.com', 'news.ycombinator.com'];
  assert.deepEqual(classifyUrl('https://m.youtube.com/watch?v=1', sites), { category: 'distraction', site: 'youtube.com' });
  assert.deepEqual(classifyUrl('https://news.ycombinator.com/', sites), { category: 'distraction', site: 'news.ycombinator.com' });
  assert.equal(classifyUrl('https://notyoutube.com/', sites), null, 'suffix must be a real subdomain');
  assert.deepEqual(classifyUrl('https://github.com/acme/api/pull/12/files', sites), { category: 'review', site: null });
  assert.equal(classifyUrl('https://github.com/acme/api/issues/3', sites), null);
  assert.equal(classifyUrl('chrome://extensions', sites), null);
  assert.equal(classifyUrl('http://[not-a-valid-host', sites), null, 'an unparseable URL is ignored, not thrown');
  assert.equal(classifyUrl(undefined, sites), null, 'no host permission → no URL → not tracked');
});

test('isCounting: focused Chrome + (active or watching a video); never locked or in the background', () => {
  assert.equal(isCounting({ idleState: 'active', windowFocused: true, audible: false }), true);
  assert.equal(isCounting({ idleState: 'idle', windowFocused: true, audible: false }), false);
  assert.equal(isCounting({ idleState: 'idle', windowFocused: true, audible: true }), true, 'watching a video');
  assert.equal(isCounting({ idleState: 'active', windowFocused: false, audible: false }), false);
  assert.equal(isCounting({ idleState: 'active', windowFocused: false, audible: true }), false, 'music while coding in the IDE');
  assert.equal(isCounting({ idleState: 'locked', windowFocused: true, audible: true }), false);
});

test('advanceSession accumulates and resets after a long break', () => {
  let s = emptySession();
  s = advanceSession(s, { site: 'youtube.com', elapsed: MIN, now: 10 * MIN });
  s = advanceSession(s, { site: 'youtube.com', elapsed: MIN, now: 11 * MIN });
  assert.equal(s.ms, 2 * MIN);
  // short detour (3 min) keeps the session
  s = advanceSession(s, { site: 'reddit.com', elapsed: MIN, now: 15 * MIN });
  assert.equal(s.ms, 3 * MIN);
  assert.equal(s.site, 'reddit.com');
  // long break starts over
  s = advanceSession(s, { site: 'youtube.com', elapsed: MIN, now: 15 * MIN + SESSION_BREAK_MS + 2 * MIN });
  assert.equal(s.ms, MIN);
});

test('isNudgeDue: threshold, repeat interval, snooze, disabled', () => {
  const base = { session: { ...emptySession(), ms: 29 * MIN }, settings: settings(), now: Date.now() };
  assert.equal(isNudgeDue(base), false, 'below 30 min default');
  assert.equal(isNudgeDue({ ...base, session: { ...base.session, ms: 30 * MIN } }), true);
  assert.equal(isNudgeDue({ ...base, session: { ...base.session, ms: 40 * MIN, lastNudgeAtMs: 30 * MIN } }), false, 'repeat after 15 min');
  assert.equal(isNudgeDue({ ...base, session: { ...base.session, ms: 45 * MIN, lastNudgeAtMs: 30 * MIN } }), true);
  assert.equal(isNudgeDue({ ...base, session: { ...base.session, ms: 60 * MIN }, snoozedUntil: base.now + 1 }), false);
  assert.equal(isNudgeDue({ ...base, session: { ...base.session, ms: 60 * MIN }, settings: settings({ focusEnabled: false }) }), false);
});

test('withinWorkHours handles weekends and overnight ranges', () => {
  const s = settings({ focusWorkHoursOnly: true, focusWorkStartHour: 9, focusWorkEndHour: 18, focusWeekdaysOnly: true });
  assert.equal(withinWorkHours(new Date(2024, 4, 6, 10), s), true); // Monday 10:00
  assert.equal(withinWorkHours(new Date(2024, 4, 6, 18), s), false);
  assert.equal(withinWorkHours(new Date(2024, 4, 4, 10), s), false); // Saturday
  const night = { ...s, focusWorkStartHour: 22, focusWorkEndHour: 6, focusWeekdaysOnly: false };
  assert.equal(withinWorkHours(new Date(2024, 4, 6, 23), night), true);
  assert.equal(withinWorkHours(new Date(2024, 4, 6, 12), night), false);
  assert.equal(withinWorkHours(new Date(2024, 4, 4, 3), settings()), true, 'no restriction when disabled');
});

const pr = (over) => ({
  owner: 'acme', repo: 'api', number: 1, title: 'T', author: 'alice', htmlUrl: 'https://github.com/acme/api/pull/1',
  additions: 400, deletions: 100, createdAt: '2024-05-01T00:00:00Z', otherReviewers: [], draft: false, viewerReview: null, ...over,
});

test('rankReviewRequests: re-requests, then quick wins, then oldest; drafts last', () => {
  const ranked = rankReviewRequests([
    pr({ number: 1, createdAt: '2024-05-01T00:00:00Z' }),
    pr({ number: 2, draft: true, additions: 1, deletions: 0 }),
    pr({ number: 3, additions: 20, deletions: 5 }),
    pr({ number: 4, viewerReview: { state: 'COMMENTED' } }),
    pr({ number: 5, createdAt: '2024-04-01T00:00:00Z' }),
  ]);
  assert.deepEqual(ranked.map((p) => p.number), [4, 3, 5, 1, 2]);
});

test('buildNudge: review reminder with the user-requested tone and useful hints', () => {
  const now = Date.parse('2024-05-04T00:00:00Z');
  const nudge = buildNudge({
    reviewRequests: [pr({ title: 'Add caching', additions: 30, deletions: 4, otherReviewers: [{ login: 'bob', state: 'APPROVED' }] })],
    site: 'youtube.com',
    sessionMs: 65 * MIN,
    now,
  });
  assert.equal(nudge.kind, 'review');
  assert.equal(nudge.title, '⏰ 1h 05m on YouTube. A review is waiting for you');
  assert.match(nudge.message, /^Instead of more YouTube, there's a pending review: alice's "Add caching" \(acme\/api#1\)\. Finish it first, then enjoy the rest!/);
  assert.match(nudge.contextMessage, /small \(\+30\/−4\), a quick win/);
  assert.match(nudge.contextMessage, /bob already approved/);
  assert.equal(nudge.url, 'https://github.com/acme/api/pull/1');
});

test('buildNudge: multiple reviews, then my PRs, then todos, else nothing', () => {
  const many = buildNudge({ reviewRequests: [pr({ number: 1 }), pr({ number: 2 })], site: 'reddit.com', sessionMs: 30 * MIN });
  assert.match(many.message, /there are 2 pending reviews/);

  const mine = buildNudge({
    myPRs: [pr({ title: 'Mine', changesRequested: [], threads: { awaitingViewer: 2 } })],
    site: 'x.com',
    sessionMs: 30 * MIN,
  });
  assert.equal(mine.kind, 'my-pr');
  assert.match(mine.message, /2 conversations are awaiting your reply/);

  const todo = buildNudge({ todos: [{ text: 'Write docs', done: false }], site: 'x.com', sessionMs: 30 * MIN });
  assert.equal(todo.kind, 'todo');
  assert.match(todo.message, /1 open todo today, like "Write docs"/);
  assert.equal(todo.url, null);

  assert.equal(buildNudge({ site: 'x.com', sessionMs: 30 * MIN }), null);
});

test('buildNudge rotates the closing line', () => {
  const a = buildNudge({ reviewRequests: [pr()], site: 'x.com', sessionMs: 30 * MIN, variant: 0 });
  const b = buildNudge({ reviewRequests: [pr()], site: 'x.com', sessionMs: 30 * MIN, variant: 1 });
  assert.notEqual(a.message, b.message);
});

test('aggregation, breakdown, history and pruning', () => {
  let a = emptyActivity();
  a = addTime(a, '2024-05-06', { category: 'distraction', site: 'youtube.com' }, 50 * MIN);
  a = addTime(a, '2024-05-06', { category: 'distraction', site: 'reddit.com' }, 10 * MIN);
  a = addTime(a, '2024-05-06', { category: 'distraction', site: 'x.com' }, 20_000); // < 1 min: hidden in breakdown
  a = addTime(a, '2024-05-06', { category: 'review' }, 25 * MIN);
  a = incrementDay(a, '2024-05-06', 'reviewsCleared', 2);
  a = addTime(a, '2024-03-01', { category: 'review' }, MIN);

  assert.deepEqual(siteBreakdown(a.days['2024-05-06']).map((s) => s.label), ['YouTube', 'Reddit']);
  const week = lastDays(a, '2024-05-06', 7);
  assert.equal(week.length, 7);
  assert.equal(week[6].reviewMs, 25 * MIN);
  assert.equal(week[0].distractionMs, 0);
  assert.deepEqual(Object.keys(pruneActivity(a, '2024-05-06').days), ['2024-05-06']);
});

test('buildInsights summarises the day and compares with the recent average', () => {
  let a = emptyActivity();
  for (const day of ['2024-05-03', '2024-05-04', '2024-05-05']) {
    a = addTime(a, day, { category: 'distraction', site: 'youtube.com' }, 100 * MIN);
  }
  a = addTime(a, '2024-05-06', { category: 'distraction', site: 'youtube.com' }, 45 * MIN);
  a = addTime(a, '2024-05-06', { category: 'distraction', site: 'reddit.com' }, 15 * MIN);
  a = addTime(a, '2024-05-06', { category: 'review' }, 30 * MIN);
  a = incrementDay(a, '2024-05-06', 'reviewsCleared', 3);
  a = incrementDay(a, '2024-05-06', 'nudges', 2);
  a = incrementDay(a, '2024-05-06', 'nudgeClicks', 1);
  a = recordLongestSession(a, '2024-05-06', 22 * MIN);

  const insights = buildInsights(a, '2024-05-06').join('\n');
  assert.match(insights, /Longest uninterrupted distraction streak: 22m/);
  assert.match(insights, /YouTube is your biggest distraction today: 45m \(75%\)/);
  assert.match(insights, /So far below your recent daily average of 1h 40m/);
  const heavy = addTime(a, '2024-05-06', { category: 'distraction', site: 'youtube.com' }, 90 * MIN);
  assert.match(buildInsights(heavy, '2024-05-06').join('\n'), /already 50% above your recent daily average \(1h 40m\)/);
  assert.match(insights, /Time on GitHub PRs today: 30m, compared with 1h on distracting sites/);
  assert.match(insights, /cleared 3 review requests today/);
  assert.match(insights, /acted on 1 of 2 reminders/);
});

test('formatDuration', () => {
  assert.equal(formatDuration(59_000), '0m');
  assert.equal(formatDuration(61 * MIN), '1h 01m');
  assert.equal(formatDuration(120 * MIN), '2h');
});
