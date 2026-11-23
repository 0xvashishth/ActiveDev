/**
 * Focus monitor: pure logic (no chrome.* access) for
 *  - classifying the active tab (distracting site / reviewing a GitHub PR),
 *  - accumulating daily totals and the current "distraction session",
 *  - deciding when to nudge and writing the nudge message,
 *  - building insights for the Focus tab.
 *
 * Activity data is aggregate only: per day, milliseconds per site. No URLs,
 * titles or timestamps of individual visits are stored.
 *
 * ActivityState (chrome.storage.local):
 *   { version: 1, days: { 'YYYY-MM-DD': DayStats } }
 *   DayStats = { sites: { 'youtube.com': ms }, reviewMs, nudges, nudgeClicks,
 *                reviewsCleared, longestSessionMs }
 */

export const MAX_SEGMENT_MS = 3 * 60 * 1000; // cap per sample; guards against sleep/hibernate gaps
export const SESSION_BREAK_MS = 5 * 60 * 1000; // a break this long ends a distraction session
export const HISTORY_DAYS = 30;
export const IDLE_DETECTION_SECONDS = 120;

const SITE_LABELS = {
  'youtube.com': 'YouTube',
  'netflix.com': 'Netflix',
  'twitch.tv': 'Twitch',
  'reddit.com': 'Reddit',
  'x.com': 'X',
  'twitter.com': 'Twitter',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'tiktok.com': 'TikTok',
  'primevideo.com': 'Prime Video',
  'hotstar.com': 'Hotstar',
  'disneyplus.com': 'Disney+',
  '9gag.com': '9GAG',
  'news.ycombinator.com': 'Hacker News',
};

export const SUGGESTED_SITES = Object.keys(SITE_LABELS);

// ---------------------------------------------------------------------------
// Sites & URL classification
// ---------------------------------------------------------------------------

/**
 * Turns user input ("https://www.YouTube.com/watch?v=1", "youtube.com") into a
 * bare registrable-ish host ("youtube.com"). Returns null if invalid.
 */
export function normalizeSite(input) {
  let value = String(input ?? '').trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z]+:\/\//.test(value)) value = `https://${value}`;
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (host === 'github.com' || host.endsWith('.github.com')) return null; // that's where reviews happen
  return host;
}

export function siteLabel(site) {
  return SITE_LABELS[site] || site;
}

/** Match pattern granting access to a site and all its subdomains. */
export function originPatternForSite(site) {
  return `*://*.${site}/*`;
}

export function hostMatchesSite(hostname, site) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === site || host.endsWith(`.${site}`);
}

const PR_PATH_RE = /^\/[^/]+\/[^/]+\/pull\/\d+/;

/**
 * @returns {{category: 'distraction', site: string} | {category: 'review', site: null} | null}
 */
export function classifyUrl(url, sites) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  if (parsed.hostname === 'github.com' && PR_PATH_RE.test(parsed.pathname)) {
    return { category: 'review', site: null };
  }
  // Longest match wins (e.g. "news.ycombinator.com" over "ycombinator.com").
  const match = [...(sites || [])]
    .sort((a, b) => b.length - a.length)
    .find((site) => hostMatchesSite(parsed.hostname, site));
  return match ? { category: 'distraction', site: match } : null;
}

/**
 * Whether time should be counted right now.
 * - Screen locked, or Chrome is not the focused app: never. (Music playing in a
 *   background tab while you work in your IDE is not a distraction.)
 * - Otherwise: the user is active, or the tab is playing audio (watching a
 *   video involves no mouse/keyboard input, so "idle" alone isn't "away").
 */
export function isCounting({ idleState, windowFocused, audible }) {
  if (idleState === 'locked' || !windowFocused) return false;
  return idleState === 'active' || !!audible;
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

export function emptyActivity() {
  return { version: 1, days: {} };
}

export function emptyDay() {
  return { sites: {}, reviewMs: 0, nudges: 0, nudgeClicks: 0, reviewsCleared: 0, longestSessionMs: 0 };
}

export function emptySession() {
  return { ms: 0, startedAt: null, lastDistractionAt: null, lastNudgeAtMs: 0, site: null };
}

export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.days !== 'object' || raw.days === null) return emptyActivity();
  const days = {};
  for (const [key, day] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !day || typeof day !== 'object') continue;
    days[key] = { ...emptyDay(), ...day, sites: { ...(day.sites || {}) } };
  }
  return { version: 1, days };
}

function withDay(activity, day, fn) {
  const current = activity.days[day] ? { ...activity.days[day], sites: { ...activity.days[day].sites } } : emptyDay();
  return { ...activity, days: { ...activity.days, [day]: fn(current) } };
}

/** Adds a counted time segment to the day's totals. */
export function addTime(activity, day, observation, ms) {
  if (!observation || ms <= 0) return activity;
  return withDay(activity, day, (d) => {
    if (observation.category === 'distraction') {
      d.sites[observation.site] = (d.sites[observation.site] || 0) + ms;
    } else if (observation.category === 'review') {
      d.reviewMs += ms;
    }
    return d;
  });
}

export function incrementDay(activity, day, field, by = 1) {
  return withDay(activity, day, (d) => ({ ...d, [field]: (d[field] || 0) + by }));
}

export function recordLongestSession(activity, day, sessionMs) {
  return withDay(activity, day, (d) => ({ ...d, longestSessionMs: Math.max(d.longestSessionMs || 0, sessionMs) }));
}

export function pruneActivity(activity, today, keepDays = HISTORY_DAYS) {
  const cutoff = shiftDay(today, -(keepDays - 1));
  const days = Object.fromEntries(Object.entries(activity.days).filter(([key]) => key >= cutoff));
  return { ...activity, days };
}

/**
 * Extends the distraction session with a segment ending at `now`.
 * A gap longer than SESSION_BREAK_MS since the last distraction starts a new session.
 */
export function advanceSession(session, { site, elapsed, now }) {
  const segmentStart = now - elapsed;
  let next = { ...session };
  if (!next.lastDistractionAt || segmentStart - next.lastDistractionAt > SESSION_BREAK_MS) {
    next = { ...emptySession(), startedAt: segmentStart };
  }
  next.ms += elapsed;
  next.lastDistractionAt = now;
  next.site = site;
  return next;
}

/** The session is over once the user has been away from distracting sites for a while. */
export function isSessionActive(session, now) {
  return !!session?.lastDistractionAt && now - session.lastDistractionAt <= SESSION_BREAK_MS;
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

export function withinWorkHours(date, settings) {
  if (!settings.focusWorkHoursOnly) return true;
  const weekday = date.getDay();
  if (settings.focusWeekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  const hour = date.getHours() + date.getMinutes() / 60;
  const start = Number(settings.focusWorkStartHour);
  const end = Number(settings.focusWorkEndHour);
  // Supports overnight ranges such as 22 → 6.
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Decides whether the session has earned a nudge (pending work is checked separately). */
export function isNudgeDue({ session, settings, now, snoozedUntil = 0 }) {
  if (!settings.focusEnabled) return false;
  if (now < snoozedUntil) return false;
  if (!withinWorkHours(new Date(now), settings)) return false;
  const threshold = settings.focusThresholdMinutes * 60_000;
  const repeat = settings.focusRepeatMinutes * 60_000;
  if (session.ms < threshold) return false;
  if (session.lastNudgeAtMs > 0 && session.ms - session.lastNudgeAtMs < repeat) return false;
  return true;
}

export function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function waitingFor(pr, now) {
  const since = Date.parse(pr.createdAt || pr.updatedAt);
  if (!Number.isFinite(since)) return null;
  // createdAt is when the PR was opened (the request time isn't in search results).
  const days = Math.floor((now - since) / 86_400_000);
  if (days >= 2) return `The PR was opened ${days} days ago.`;
  if (days === 1) return 'The PR was opened yesterday.';
  return null;
}

/**
 * Orders review requests by how useful it is to do them now:
 * re-requests first (someone is blocked on you), then small PRs (quick wins),
 * then the oldest. Drafts go last.
 */
export function rankReviewRequests(prs) {
  const size = (pr) => (pr.additions ?? 500) + (pr.deletions ?? 500);
  return [...(prs || [])].sort((a, b) => {
    if (!!a.draft !== !!b.draft) return a.draft ? 1 : -1;
    const reA = a.viewerReview ? 0 : 1;
    const reB = b.viewerReview ? 0 : 1;
    if (reA !== reB) return reA - reB;
    const quickA = size(a) <= 100 ? 0 : 1;
    const quickB = size(b) <= 100 ? 0 : 1;
    if (quickA !== quickB) return quickA - quickB;
    return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
  });
}

const CLOSERS = [
  'Finish it first, then enjoy the rest! 🎬',
  'Knock it out now, the rest will still be there afterwards. 🍿',
  'A few focused minutes now unblocks a teammate for the whole day. 🙌',
  'Do it first and enjoy the rest guilt-free. ✅',
];

/**
 * Builds the reminder. Priority: review requests → my PRs that need me →
 * today's open todos. Returns null when there's nothing pending (no nudge).
 *
 * @param {{ reviewRequests, myPRs, todos, site, sessionMs, now, variant }} ctx
 * @returns {{ title, message, contextMessage, url, kind } | null}
 */
export function buildNudge({ reviewRequests = [], myPRs = [], todos = [], site, sessionMs, now = Date.now(), variant = 0 }) {
  const where = siteLabel(site);
  const spent = formatDuration(sessionMs);
  const closer = CLOSERS[variant % CLOSERS.length];

  const ranked = rankReviewRequests(reviewRequests);
  if (ranked.length > 0) {
    const pr = ranked[0];
    const ref = `${pr.owner}/${pr.repo}#${pr.number}`;
    const hints = [];
    if (pr.viewerReview) hints.push('They re-requested your review.');
    const lines = (pr.additions ?? 0) + (pr.deletions ?? 0);
    if (pr.additions != null && lines <= 100) hints.push(`It's small (+${pr.additions}/−${pr.deletions}), a quick win.`);
    const approvers = (pr.otherReviewers || []).filter((r) => r.state === 'APPROVED').map((r) => r.login);
    if (approvers.length) hints.push(`${approvers[0]} already approved; yours may be the last one needed.`);
    const waited = waitingFor(pr, now);
    if (waited) hints.push(waited);

    const lead = ranked.length === 1
      ? `Instead of more ${where}, there's a pending review: ${pr.author ? `${pr.author}'s ` : ''}"${pr.title}" (${ref}).`
      : `Instead of more ${where}, there are ${ranked.length} pending reviews. Start with "${pr.title}" (${ref}).`;
    return {
      kind: 'review',
      title: `⏰ ${spent} on ${where}. A review is waiting for you`,
      message: `${lead} ${closer}`,
      contextMessage: hints.slice(0, 2).join(' '),
      url: pr.htmlUrl,
    };
  }

  const needsMe = (myPRs || []).filter(
    (pr) => (pr.changesRequested || []).length > 0 || (pr.threads?.awaitingViewer || 0) > 0
  );
  if (needsMe.length > 0) {
    const pr = needsMe[0];
    const reason = pr.threads?.awaitingViewer
      ? `${pr.threads.awaitingViewer} conversation${pr.threads.awaitingViewer === 1 ? ' is' : 's are'} awaiting your reply`
      : `${pr.changesRequested[0]} requested changes`;
    return {
      kind: 'my-pr',
      title: `⏰ ${spent} on ${where}. Your PR needs you`,
      message: `On "${pr.title}" (${pr.owner}/${pr.repo}#${pr.number}), ${reason}. Address it first, then enjoy the rest!`,
      contextMessage: 'Getting your PR merged today beats another episode.',
      url: pr.htmlUrl,
    };
  }

  const openTodos = (todos || []).filter((t) => !t.done);
  if (openTodos.length > 0) {
    const todo = openTodos[0];
    return {
      kind: 'todo',
      title: `⏰ ${spent} on ${where}. Today's todos are waiting`,
      message: `You still have ${openTodos.length} open todo${openTodos.length === 1 ? '' : 's'} today, like "${todo.text}". ${closer}`,
      contextMessage: '',
      url: todo.link?.url || null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function shiftDay(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function distractionTotal(day) {
  return Object.values(day?.sites || {}).reduce((a, b) => a + b, 0);
}

export function siteBreakdown(day) {
  return Object.entries(day?.sites || {})
    .map(([site, ms]) => ({ site, label: siteLabel(site), ms }))
    .filter((s) => s.ms >= 60_000)
    .sort((a, b) => b.ms - a.ms);
}

/** Last `count` days (oldest first), including days without data. */
export function lastDays(activity, today, count = 7) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const key = shiftDay(today, -i);
    const day = activity.days[key] || emptyDay();
    out.push({ key, distractionMs: distractionTotal(day), reviewMs: day.reviewMs || 0, reviewsCleared: day.reviewsCleared || 0 });
  }
  return out;
}

/** Short, human-readable observations for the Focus tab. */
export function buildInsights(activity, today) {
  const insights = [];
  const day = activity.days[today] || emptyDay();
  const todayDistraction = distractionTotal(day);
  const week = lastDays(activity, today, 7);
  const previous = week.slice(0, -1).filter((d) => d.distractionMs > 0 || d.reviewMs > 0);

  const top = siteBreakdown(day)[0];
  if (top) {
    const share = Math.round((top.ms / todayDistraction) * 100);
    insights.push(`${top.label} is your biggest distraction today: ${formatDuration(top.ms)}${share < 100 ? ` (${share}%)` : ''}.`);
  }

  if (previous.length >= 2) {
    const avg = previous.reduce((a, d) => a + d.distractionMs, 0) / previous.length;
    if (avg >= 5 * 60_000) {
      // Today is still in progress, so only "already above average" is a fair comparison.
      const diff = Math.round(((todayDistraction - avg) / avg) * 100);
      if (diff >= 10) {
        insights.push(`You're already ${diff}% above your recent daily average (${formatDuration(avg)}).`);
      } else if (todayDistraction > 0) {
        insights.push(`So far below your recent daily average of ${formatDuration(avg)}. Keep it up!`);
      }
    }
  }

  if (day.reviewMs >= 60_000 || todayDistraction >= 60_000) {
    insights.push(
      `Time on GitHub PRs today: ${formatDuration(day.reviewMs)}, compared with ${formatDuration(todayDistraction)} on distracting sites.`
    );
  }

  if (day.reviewsCleared > 0) {
    insights.push(`You've cleared ${day.reviewsCleared} review request${day.reviewsCleared === 1 ? '' : 's'} today. 🎉`);
  }

  if (day.longestSessionMs >= 15 * 60_000) {
    insights.push(`Longest uninterrupted distraction streak: ${formatDuration(day.longestSessionMs)}.`);
  }

  const weekNudges = Object.entries(activity.days)
    .filter(([key]) => key >= shiftDay(today, -6))
    .reduce((acc, [, d]) => ({ nudges: acc.nudges + (d.nudges || 0), clicks: acc.clicks + (d.nudgeClicks || 0) }), { nudges: 0, clicks: 0 });
  if (weekNudges.nudges > 0) {
    insights.push(
      `This week you acted on ${weekNudges.clicks} of ${weekNudges.nudges} reminder${weekNudges.nudges === 1 ? '' : 's'}.`
    );
  }

  return insights;
}
