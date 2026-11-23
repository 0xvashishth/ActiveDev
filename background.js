import {
  ALARM_NAME,
  MAX_NOTIFICATION_MAP_ENTRIES,
  MAX_SEEN_REVIEW_IDS,
  ORG_CHECK_INTERVAL_MS,
  REQUIRED_SCOPES,
  STORAGE_KEYS,
} from './lib/constants.js';
import { getSettings } from './lib/settings.js';
import { initFocusMonitor } from './lib/focus-monitor.js';
import { dateKey, itemsForDay, loadNotes } from './lib/notes.js';
import { getAccessToken, getAppInfo, logout } from './lib/auth.js';
import {
  authoredPRsQuery,
  checkOrganizationAccess,
  fetchPullRequestDetails,
  getUserOrganizations,
  getViewer,
  reviewRequestsQuery,
  searchPullRequests,
} from './lib/github-api.js';
import {
  buildPullRequestModel,
  describeReviewState,
  findNewReviewRequests,
  findNewReviewsOnMyPRs,
} from './lib/pr-model.js';

const NOTIFICATION_PREFIX_REVIEW_REQUEST = 'ghrr-review-';
const NOTIFICATION_PREFIX_REVIEWED = 'ghrr-reviewed-';

// Storage keys used by v1.0 that are no longer needed.
const LEGACY_KEYS = ['ghrr_my_prs_state', 'ghrr_notified_reviews', 'ghrr_oauth_state'];

// ---------------------------------------------------------------------------
// Settings & alarm
// ---------------------------------------------------------------------------

/** Creates the polling alarm, or re-creates it if the interval changed. */
async function ensureAlarm() {
  const { pollIntervalMinutes } = await getSettings();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== pollIntervalMinutes) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: alarm ? pollIntervalMinutes : 0.5,
      periodInMinutes: pollIntervalMinutes,
    });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.local.remove(LEGACY_KEYS);
  await ensureAlarm();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

// Service workers are restarted frequently; make sure polling survives that.
ensureAlarm();

// ---------------------------------------------------------------------------
// Focus monitor
// ---------------------------------------------------------------------------

/** What a focus reminder can point you to: reviews, your PRs, today's todos. */
async function getPendingWork() {
  const [settings, stored, notes] = await Promise.all([
    getSettings(),
    chrome.storage.local.get([STORAGE_KEYS.ACCESS_TOKEN, STORAGE_KEYS.REVIEW_REQUEST_PRS, STORAGE_KEYS.MY_PRS]),
    loadNotes(),
  ]);
  const signedIn = !!stored[STORAGE_KEYS.ACCESS_TOKEN];
  return {
    reviewRequests: signedIn ? visibleReviewRequests(stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [], settings) : [],
    myPRs: signedIn ? stored[STORAGE_KEYS.MY_PRS] || [] : [],
    todos: itemsForDay(notes, dateKey()).filter((item) => !item.done),
  };
}

const focusMonitor = initFocusMonitor({ getPendingWork });
focusMonitor.sync().catch((error) => console.warn('Focus monitor start failed:', error));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    performCheck().catch((error) => console.error('Scheduled check failed:', error));
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise
      .then((result) => sendResponse(result ?? { success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  };

  switch (message?.type) {
    case 'CHECK_NOW':
      return respond(performCheck({ force: true }));
    case 'GET_STATUS':
      return respond(getCachedStatus());
    case 'USER_AUTHENTICATED':
      return respond(ensureAlarm().then(() => performCheck({ force: true, checkOrgs: true })));
    case 'CHECK_ORGS':
      return respond(performCheck({ force: true, checkOrgs: true }));
    case 'SETTINGS_UPDATED':
      return respond(ensureAlarm().then(refreshBadge));
    case 'GET_FOCUS_STATUS':
      return respond(focusMonitor.getStatus());
    case 'FOCUS_SETTINGS_UPDATED':
      return respond(focusMonitor.sync());
    case 'FOCUS_SNOOZE':
      return respond(focusMonitor.snooze(message.minutes));
    case 'FOCUS_RESUME':
      return respond(focusMonitor.resume());
    case 'FOCUS_TEST_NUDGE':
      return respond(focusMonitor.testNudge());
    case 'FOCUS_RESET_ACTIVITY':
      return respond(focusMonitor.resetActivity());
    case 'USER_LOGGED_OUT':
      return respond(
        Promise.all([chrome.alarms.clear(ALARM_NAME), chrome.action.setBadgeText({ text: '' })])
      );
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener((notificationId) => {
  if (focusMonitor.handlesNotification(notificationId)) return focusMonitor.onNotificationClicked(notificationId);
  openNotificationTarget(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (focusMonitor.handlesNotification(notificationId)) {
    return focusMonitor.onNotificationButton(notificationId, buttonIndex);
  }
  if (buttonIndex === 0) openNotificationTarget(notificationId);
});

chrome.notifications.onClosed.addListener(async (notificationId) => {
  const map = await getNotificationMap();
  if (map[notificationId]) {
    delete map[notificationId];
    await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFICATION_MAP]: map });
  }
});

async function getNotificationMap() {
  return (await chrome.storage.local.get(STORAGE_KEYS.NOTIFICATION_MAP))[STORAGE_KEYS.NOTIFICATION_MAP] || {};
}

async function openNotificationTarget(notificationId) {
  const map = await getNotificationMap();
  const url = map[notificationId];
  if (url) await chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
}

async function notify(notificationId, url, options) {
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      priority: 2,
      buttons: [{ title: 'View PR' }],
      requireInteraction: true,
      ...options,
    });
    return [notificationId, url];
  } catch (error) {
    console.warn('Failed to create notification:', error);
    return null;
  }
}

async function saveNotificationTargets(entries) {
  const valid = entries.filter(Boolean);
  if (valid.length === 0) return;
  const map = { ...(await getNotificationMap()), ...Object.fromEntries(valid) };
  const trimmed = Object.fromEntries(Object.entries(map).slice(-MAX_NOTIFICATION_MAP_ENTRIES));
  await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFICATION_MAP]: trimmed });
}

function repoLabel(pr) {
  return pr.owner && pr.repo ? `${pr.owner}/${pr.repo}` : 'unknown repo';
}

async function notifyReviewRequests(prs) {
  const entries = [];
  for (const pr of prs) {
    const reRequested = !!pr.viewerReview;
    const via = pr.viewerRequestVia === 'team' && pr.requestedTeams.length
      ? ` (via ${pr.requestedTeams.join(', ')})`
      : '';
    const others = pr.otherReviewers.length
      ? ` · already reviewed by ${pr.otherReviewers.map((r) => r.login).join(', ')}`
      : '';
    entries.push(
      await notify(`${NOTIFICATION_PREFIX_REVIEW_REQUEST}${pr.id}-${Date.now()}`, pr.htmlUrl, {
        title: reRequested ? 'Re-review requested' : 'Review requested',
        message: `${repoLabel(pr)}#${pr.number}: ${pr.title}`,
        contextMessage: `by ${pr.author || 'unknown'}${via}${others}`.slice(0, 200),
      })
    );
  }
  await saveNotificationTargets(entries);
}

async function notifyNewReviews(items) {
  const entries = [];
  for (const { pr, review } of items) {
    entries.push(
      await notify(`${NOTIFICATION_PREFIX_REVIEWED}${review.id}`, review.url || pr.htmlUrl, {
        title: `${review.author} ${describeReviewState(review.state)} #${pr.number}`,
        message: `${repoLabel(pr)}: ${pr.title}`,
        contextMessage: review.bodySnippet || '',
      })
    );
  }
  await saveNotificationTargets(entries);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function visibleReviewRequests(prs, settings) {
  return settings.includeDraftReviewRequests ? prs : prs.filter((pr) => !pr.draft);
}

async function refreshBadge() {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.REVIEW_REQUEST_PRS, STORAGE_KEYS.LAST_ERROR]);
  const prs = visibleReviewRequests(stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [], settings);
  const lastError = stored[STORAGE_KEYS.LAST_ERROR];

  if (prs.length > 0) {
    await chrome.action.setBadgeText({ text: prs.length > 99 ? '99+' : String(prs.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
  } else if (lastError) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d29922' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let inflightCheck = null;

/**
 * Runs one poll. Concurrent callers (alarm + popup refresh) share the same run.
 * @param {{force?: boolean, checkOrgs?: boolean}} options
 */
function performCheck(options = {}) {
  if (!inflightCheck) {
    inflightCheck = runCheck(options).finally(() => {
      inflightCheck = null;
    });
  }
  return inflightCheck;
}

async function runCheck({ force = false, checkOrgs = false } = {}) {
  if (!(await getAccessToken())) return { success: false, error: 'Not authenticated' };

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.RATE_LIMIT_RESET,
    STORAGE_KEYS.INITIAL_CHECK_DONE,
    STORAGE_KEYS.REVIEW_REQUEST_PRS,
    STORAGE_KEYS.SEEN_REVIEW_IDS,
    STORAGE_KEYS.ORGS,
    STORAGE_KEYS.ORGS_CHECKED_AT,
  ]);

  const rateLimitReset = stored[STORAGE_KEYS.RATE_LIMIT_RESET];
  if (!force && rateLimitReset && Date.now() < rateLimitReset) {
    return { success: false, error: 'Rate limited; skipping scheduled check.' };
  }

  try {
    const settings = await getSettings();
    const { user, scopes } = await getViewer();
    const login = user.login;

    const [reviewSearch, authoredSearch] = await Promise.all([
      searchPullRequests(reviewRequestsQuery(login)),
      searchPullRequests(authoredPRsQuery(login)),
    ]);

    const { details, errors: detailErrors } = await fetchPullRequestDetails([
      ...reviewSearch.items.map((item) => item.node_id),
      ...authoredSearch.items.map((item) => item.node_id),
    ]);
    if (detailErrors.length) console.warn('Some PR details could not be loaded:', detailErrors);

    const toModel = (item) =>
      buildPullRequestModel(item, details.get(item.node_id), {
        viewerLogin: login,
        detailsError: details.has(item.node_id) ? null : 'Details unavailable (access restricted or API error).',
      });
    const reviewRequests = reviewSearch.items.map(toModel);
    const myPRs = authoredSearch.items.map(toModel);

    // Organizations: refresh periodically, or immediately when search reports
    // that an org hid results because of SAML SSO.
    const ssoOrgIds = [...new Set([...reviewSearch.ssoOrganizationIds, ...authoredSearch.ssoOrganizationIds])];
    let orgs = stored[STORAGE_KEYS.ORGS] || null;
    const orgsStale = Date.now() - (stored[STORAGE_KEYS.ORGS_CHECKED_AT] || 0) > ORG_CHECK_INTERVAL_MS;
    const orgUpdates = {};
    if (checkOrgs || orgsStale || !orgs) {
      try {
        orgs = await loadOrganizations(login, ssoOrgIds);
        orgUpdates[STORAGE_KEYS.ORGS] = orgs;
        orgUpdates[STORAGE_KEYS.ORGS_CHECKED_AT] = Date.now();
      } catch (error) {
        if (['rate_limited', 'unauthorized'].includes(error.kind)) throw error;
        console.warn('Organization check failed:', error);
      }
    }
    const ssoOrgs = ssoOrgIds.map((id) => {
      const org = (orgs || []).find((o) => o.id === id);
      return { id, login: org?.login || null };
    });

    // Notifications (never on the very first check: everything would be "new").
    const initialCheckDone = !!stored[STORAGE_KEYS.INITIAL_CHECK_DONE];
    const { fresh: newReviews, seen } = findNewReviewsOnMyPRs(myPRs, stored[STORAGE_KEYS.SEEN_REVIEW_IDS], {
      viewerLogin: login,
    });
    if (initialCheckDone) {
      // Requests that disappeared since the last poll were (almost always) reviewed.
      const currentIds = new Set(reviewRequests.map((pr) => pr.id));
      const cleared = (stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || []).filter((pr) => !currentIds.has(pr.id)).length;
      await focusMonitor.recordReviewsCleared(cleared);

      if (settings.notifyReviewRequests) {
        const previous = stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [];
        const newRequests = visibleReviewRequests(findNewReviewRequests(previous, reviewRequests), settings);
        await notifyReviewRequests(newRequests);
      }
      if (settings.notifyReviewsOnMyPRs) {
        await notifyNewReviews(newReviews);
      }
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.USER_INFO]: { login, avatar_url: user.avatar_url, html_url: user.html_url, name: user.name },
      ...(scopes ? { [STORAGE_KEYS.TOKEN_SCOPES]: scopes } : {}),
      [STORAGE_KEYS.REVIEW_REQUEST_PRS]: reviewRequests,
      [STORAGE_KEYS.MY_PRS]: myPRs,
      [STORAGE_KEYS.SEEN_REVIEW_IDS]: [...seen].slice(-MAX_SEEN_REVIEW_IDS),
      [STORAGE_KEYS.SSO_ORGS]: ssoOrgs,
      [STORAGE_KEYS.INITIAL_CHECK_DONE]: true,
      [STORAGE_KEYS.LAST_CHECKED]: Date.now(),
      ...orgUpdates,
    });
    await chrome.storage.local.remove([STORAGE_KEYS.LAST_ERROR, STORAGE_KEYS.RATE_LIMIT_RESET]);
    await refreshBadge();
    return { success: true };
  } catch (error) {
    console.error('Background check failed:', error);

    if (error.kind === 'unauthorized') {
      await logout();
      await chrome.action.setBadgeText({ text: '' });
      return { success: false, error: error.message };
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_ERROR]: { message: error.message, kind: error.kind || 'unknown', at: Date.now() },
      ...(error.kind === 'rate_limited' && error.resetAt ? { [STORAGE_KEYS.RATE_LIMIT_RESET]: error.resetAt } : {}),
    });
    await refreshBadge();
    return { success: false, error: error.message };
  }
}

async function loadOrganizations(login, ssoOrgIds) {
  getAppInfo(); // cache the OAuth client ID for "grant access" links (best effort)
  const orgs = await getUserOrganizations(login);
  const access = orgs.length ? await checkOrganizationAccess(orgs.map((o) => o.login)) : new Map();
  const ssoSet = new Set(ssoOrgIds);
  return orgs.map((org) => {
    const result = access.get(org.login) || { access: 'error', message: 'Not checked' };
    // Search telling us results were hidden by SSO is authoritative.
    const status = ssoSet.has(org.id) ? 'sso_required' : result.access;
    return { ...org, access: status, message: result.message };
  });
}

async function getCachedStatus() {
  if (!(await getAccessToken())) return { authenticated: false };

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.USER_INFO,
    STORAGE_KEYS.TOKEN_SCOPES,
    STORAGE_KEYS.REVIEW_REQUEST_PRS,
    STORAGE_KEYS.MY_PRS,
    STORAGE_KEYS.LAST_CHECKED,
    STORAGE_KEYS.LAST_ERROR,
    STORAGE_KEYS.ORGS,
    STORAGE_KEYS.SSO_ORGS,
    STORAGE_KEYS.APP_INFO,
  ]);
  const settings = await getSettings();
  const scopes = stored[STORAGE_KEYS.TOKEN_SCOPES];

  return {
    authenticated: true,
    user: stored[STORAGE_KEYS.USER_INFO] || null,
    reviewRequests: visibleReviewRequests(stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [], settings),
    myPRs: stored[STORAGE_KEYS.MY_PRS] || [],
    lastChecked: stored[STORAGE_KEYS.LAST_CHECKED] || null,
    lastError: stored[STORAGE_KEYS.LAST_ERROR] || null,
    orgs: stored[STORAGE_KEYS.ORGS] || [],
    ssoOrgs: stored[STORAGE_KEYS.SSO_ORGS] || [],
    missingScopes: Array.isArray(scopes) ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s)) : [],
    appInfo: stored[STORAGE_KEYS.APP_INFO] || null,
    settings,
  };
}
