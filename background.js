import { POLL_INTERVAL_MINUTES, STORAGE_KEYS } from './lib/constants.js';
import { getAccessToken, isAuthenticated, logout } from './lib/auth.js';
import {
  getCurrentUser,
  getReviewRequestsForUser,
  getUserPRs,
  enrichReviewRequest,
  enrichMyPR,
} from './lib/github-api.js';

const NOTIFICATION_PREFIX_REVIEW_REQUEST = 'ghrr-review-';
const NOTIFICATION_PREFIX_REVIEWED = 'ghrr-reviewed-';

async function updateBadge(count) {
  if (count > 0) {
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: '#f85149' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

async function ensureAlarm() {
  const alarm = await chrome.alarms.get('github-check');
  if (!alarm) {
    await chrome.alarms.create('github-check', {
      periodInMinutes: POLL_INTERVAL_MINUTES,
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'github-check') {
    await performCheck();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CHECK_NOW':
      performCheck().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'GET_STATUS':
      getCachedStatus().then(sendResponse);
      return true;
    case 'USER_AUTHENTICATED':
      ensureAlarm();
      performCheck().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    case 'USER_LOGGED_OUT':
      chrome.alarms.clear('github-check');
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ success: true });
      return true;
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  handleNotificationAction(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    handleNotificationAction(notificationId);
  }
});

async function handleNotificationAction(notificationId) {
  const stored = await chrome.storage.local.get('ghrr_notification_map');
  const map = stored.ghrr_notification_map || {};
  const prUrl = map[notificationId];
  if (prUrl) {
    await chrome.tabs.create({ url: prUrl });
  }
}

async function performCheck() {
  const authenticated = await isAuthenticated();
  if (!authenticated) return;

  try {
    const token = await getAccessToken();
    if (!token) return;

    const user = await getCurrentUser();
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_INFO]: user });

    const username = user.login;

    const initialCheckDone = (await chrome.storage.local.get(STORAGE_KEYS.INITIAL_CHECK_DONE))[STORAGE_KEYS.INITIAL_CHECK_DONE];

    await checkReviewRequests(username, !!initialCheckDone);
    await checkMyPRsReviews(username, !!initialCheckDone);

    const reviewPrs = (await chrome.storage.local.get(STORAGE_KEYS.REVIEW_REQUEST_PRS))[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [];
    await updateBadge(reviewPrs.length);

    if (!initialCheckDone) {
      await chrome.storage.local.set({ [STORAGE_KEYS.INITIAL_CHECK_DONE]: true });
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_CHECKED]: Date.now() });
  } catch (error) {
    if (error.message.includes('Token expired') || error.message.includes('Invalid')) {
      await logout();
    }
    console.error('Background check failed:', error);
  }
}

async function checkReviewRequests(username, initialCheckDone) {
  const prs = await getReviewRequestsForUser(username);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.REVIEW_REQUEST_PRS);
  const previousPrs = stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [];

  const previousIds = new Set(previousPrs.map(p => p.id));

  const enriched = [];
  const notificationMap = {};

  for (const pr of prs) {
    const enrichedPr = await enrichReviewRequest(pr);
    enriched.push(enrichedPr);

    if (initialCheckDone && !previousIds.has(pr.id)) {
      const notifId = `${NOTIFICATION_PREFIX_REVIEW_REQUEST}${pr.id}`;
      await chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Review Requested',
        message: `${enrichedPr.owner}/${enrichedPr.repo}#${pr.number}: ${pr.title}`,
        contextMessage: `by ${pr.user?.login || 'unknown'}`,
        priority: 2,
        buttons: [{ title: 'View PR' }],
        requireInteraction: true,
      });
      notificationMap[notifId] = pr.html_url;
    }
  }

  const existingMap = (await chrome.storage.local.get('ghrr_notification_map')).ghrr_notification_map || {};
  await chrome.storage.local.set({
    [STORAGE_KEYS.REVIEW_REQUEST_PRS]: enriched,
    ghrr_notification_map: { ...existingMap, ...notificationMap },
  });
}

async function checkMyPRsReviews(username, initialCheckDone) {
  const prs = await getUserPRs(username);
  const stored = await chrome.storage.local.get([STORAGE_KEYS.MY_PRS_STATE, STORAGE_KEYS.NOTIFIED_REVIEWS]);
  const previousState = stored[STORAGE_KEYS.MY_PRS_STATE] || {};
  const alreadyNotified = stored[STORAGE_KEYS.NOTIFIED_REVIEWS] || [];

  const notifiedSet = new Set(alreadyNotified);
  const newNotified = [...alreadyNotified];
  const notificationMap = {};

  const enriched = [];

  for (const pr of prs) {
    const enrichedPr = await enrichMyPR(pr);
    enriched.push(enrichedPr);

    if (initialCheckDone && enrichedPr.reviews && enrichedPr.reviews.length > 0) {
      const prevState = previousState[pr.id];
      const prevReviewCount = prevState ? prevState.reviewCount : 0;

      if (enrichedPr.reviews.length > prevReviewCount) {
        const newReviews = enrichedPr.reviews.slice(prevReviewCount);
        for (const review of newReviews) {
          const reviewKey = `${pr.id}-${review.id}`;
          if (!notifiedSet.has(reviewKey)) {
            const stateLabel = review.state.charAt(0).toUpperCase() + review.state.slice(1).toLowerCase();
            const notifId = `${NOTIFICATION_PREFIX_REVIEWED}${review.id}`;
            await chrome.notifications.create(notifId, {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: `PR #${pr.number} - ${stateLabel}`,
              message: `${enrichedPr.owner}/${enrichedPr.repo}: ${review.user.login} ${review.state.toLowerCase()} "${pr.title}"`,
              contextMessage: review.body ? review.body.substring(0, 120) : '',
              priority: 2,
              buttons: [{ title: 'View PR' }],
              requireInteraction: true,
            });
            notificationMap[notifId] = pr.html_url;
            notifiedSet.add(reviewKey);
            newNotified.push(reviewKey);
          }
        }
      }
    }
  }

  const newState = {};
  for (const pr of enriched) {
    newState[pr.id] = {
      reviewCount: pr.reviews ? pr.reviews.length : 0,
      lastChecked: Date.now(),
    };
  }

  const existingMap = (await chrome.storage.local.get('ghrr_notification_map')).ghrr_notification_map || {};
  await chrome.storage.local.set({
    [STORAGE_KEYS.MY_PRS]: enriched,
    [STORAGE_KEYS.MY_PRS_STATE]: newState,
    [STORAGE_KEYS.NOTIFIED_REVIEWS]: newNotified.slice(-500),
    ghrr_notification_map: { ...existingMap, ...notificationMap },
  });
}

async function getCachedStatus() {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return { authenticated: false };
  }

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.USER_INFO,
    STORAGE_KEYS.REVIEW_REQUEST_PRS,
    STORAGE_KEYS.MY_PRS,
    STORAGE_KEYS.LAST_CHECKED,
  ]);

  return {
    authenticated: true,
    user: stored[STORAGE_KEYS.USER_INFO],
    reviewRequests: stored[STORAGE_KEYS.REVIEW_REQUEST_PRS] || [],
    myPRs: stored[STORAGE_KEYS.MY_PRS] || [],
    lastChecked: stored[STORAGE_KEYS.LAST_CHECKED],
  };
}
