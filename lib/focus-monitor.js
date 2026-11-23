/**
 * Focus monitor runtime (service worker side).
 *
 * Measures time on the distracting sites the user listed (and on GitHub PR
 * pages) and sends a friendly nudge toward pending reviews when a distraction
 * session gets long. Privacy by construction: the extension only holds host
 * permissions for the listed sites, so Chrome does not even reveal the URL of
 * any other tab. Only per-day, per-site totals are stored.
 *
 * Time accounting: every event (tab switch, navigation, window focus, idle
 * change) and a 1-minute alarm "flushes" the elapsed time to whatever was
 * observed at the previous step, then observes the current state.
 */
import {
  FOCUS_ALARM_NAME,
  FOCUS_SNOOZE_MINUTES,
  SESSION_KEYS,
  STORAGE_KEYS,
} from './constants.js';
import { getSettings } from './settings.js';
import {
  IDLE_DETECTION_SECONDS,
  MAX_SEGMENT_MS,
  addTime,
  advanceSession,
  buildNudge,
  classifyUrl,
  emptyActivity,
  emptySession,
  incrementDay,
  isCounting,
  isNudgeDue,
  isSessionActive,
  normalizeActivity,
  originPatternForSite,
  pruneActivity,
  recordLongestSession,
} from './activity.js';
import { dateKey } from './notes.js';

export const FOCUS_NOTIFICATION_PREFIX = 'ghrr-focus-';
const MAX_TRACKED_NOTIFICATIONS = 20;

function emptyTracker() {
  return { current: null, since: null, session: emptySession(), snoozedUntil: 0, nudgeCount: 0, notifications: {} };
}

async function loadTracker() {
  const raw = (await chrome.storage.session.get(SESSION_KEYS.FOCUS_TRACKER))[SESSION_KEYS.FOCUS_TRACKER];
  return raw ? { ...emptyTracker(), ...raw, session: { ...emptySession(), ...raw.session } } : emptyTracker();
}

async function loadActivity() {
  return normalizeActivity((await chrome.storage.local.get(STORAGE_KEYS.ACTIVITY))[STORAGE_KEYS.ACTIVITY]);
}

/**
 * @param {{ now?: () => number, getPendingWork: () => Promise<{reviewRequests, myPRs, todos}> }} deps
 */
export function initFocusMonitor({ now = () => Date.now(), getPendingWork }) {
  let queue = Promise.resolve();
  let settingsCache = null;

  const settings = () => (settingsCache ??= getSettings());

  /** Serializes all tracker work so events never interleave. */
  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch((error) => console.warn('Focus monitor error:', error));
    return run;
  }

  async function observe(sites) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (!tab) return { category: null, site: null, counting: false };
    const classification = classifyUrl(tab.url, sites);
    if (!classification) return { category: null, site: null, counting: false };

    let windowFocused = false;
    try {
      windowFocused = !!(await chrome.windows.get(tab.windowId))?.focused;
    } catch {
      /* window closed meanwhile */
    }
    const idleState = await chrome.idle.queryState(IDLE_DETECTION_SECONDS).catch(() => 'active');
    return { ...classification, counting: isCounting({ idleState, windowFocused, audible: tab.audible }) };
  }

  async function notify(tracker, nudge) {
    const id = `${FOCUS_NOTIFICATION_PREFIX}${now()}`;
    const buttons = nudge.url
      ? [{ title: nudge.kind === 'todo' ? 'Open it' : 'Open it now' }, { title: `Snooze ${FOCUS_SNOOZE_MINUTES} min` }]
      : [{ title: `Snooze ${FOCUS_SNOOZE_MINUTES} min` }];
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: nudge.title,
      message: nudge.message,
      contextMessage: nudge.contextMessage || '',
      priority: 2,
      requireInteraction: true,
      buttons,
    });
    const entries = Object.entries({ ...tracker.notifications, [id]: { url: nudge.url } }).slice(-MAX_TRACKED_NOTIFICATIONS);
    tracker.notifications = Object.fromEntries(entries);
    return id;
  }

  /** One accounting step: flush elapsed time, observe, maybe nudge. */
  function step() {
    return enqueue(async () => {
      const s = await settings();
      const tracker = await loadTracker();
      const t = now();

      if (!s.focusEnabled) {
        if (tracker.current) await chrome.storage.session.set({ [SESSION_KEYS.FOCUS_TRACKER]: emptyTracker() });
        return { tracker: emptyTracker(), settings: s };
      }

      let activity = null;
      const today = dateKey(new Date(t));
      const elapsed = tracker.since ? Math.min(Math.max(t - tracker.since, 0), MAX_SEGMENT_MS) : 0;
      if (tracker.current?.counting && tracker.current.category && elapsed > 0) {
        activity = addTime(await loadActivity(), today, tracker.current, elapsed);
        if (tracker.current.category === 'distraction') {
          tracker.session = advanceSession(tracker.session, { site: tracker.current.site, elapsed, now: t });
          activity = recordLongestSession(activity, today, tracker.session.ms);
        }
      }

      tracker.current = await observe(s.focusSites);
      tracker.since = t;

      const onDistraction = tracker.current.counting && tracker.current.category === 'distraction';
      if (
        onDistraction &&
        isSessionActive(tracker.session, t) &&
        isNudgeDue({ session: tracker.session, settings: s, now: t, snoozedUntil: tracker.snoozedUntil })
      ) {
        const work = await getPendingWork();
        const nudge = buildNudge({
          ...work,
          site: tracker.session.site,
          sessionMs: tracker.session.ms,
          now: t,
          variant: tracker.nudgeCount,
        });
        if (nudge) {
          await notify(tracker, nudge);
          tracker.session.lastNudgeAtMs = tracker.session.ms;
          tracker.nudgeCount += 1;
          activity = incrementDay(activity || (await loadActivity()), today, 'nudges');
        }
      }

      await chrome.storage.session.set({ [SESSION_KEYS.FOCUS_TRACKER]: tracker });
      if (activity) {
        await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY]: pruneActivity(activity, today) });
      }
      return { tracker, settings: s };
    });
  }

  function updateActivity(fn) {
    return enqueue(async () => {
      const today = dateKey(new Date(now()));
      const next = fn(await loadActivity(), today);
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY]: pruneActivity(next, today) });
    });
  }

  function updateTracker(fn) {
    return enqueue(async () => {
      const tracker = await loadTracker();
      await fn(tracker);
      await chrome.storage.session.set({ [SESSION_KEYS.FOCUS_TRACKER]: tracker });
      return tracker;
    });
  }

  /** Creates/removes the tick alarm to match settings. */
  async function sync() {
    settingsCache = null;
    const s = await settings();
    const alarm = await chrome.alarms.get(FOCUS_ALARM_NAME);
    if (s.focusEnabled) {
      chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
      if (!alarm) await chrome.alarms.create(FOCUS_ALARM_NAME, { periodInMinutes: 1 });
    } else if (alarm) {
      await chrome.alarms.clear(FOCUS_ALARM_NAME);
    }
    await step();
  }

  // ---- event listeners (registered synchronously at service worker start) ----

  // Returning the promise chain is harmless for Chrome (listener return
  // values are ignored here) and lets tests await it deterministically.
  const maybeStep = () => settings().then((s) => s.focusEnabled && step());
  chrome.tabs.onActivated.addListener(maybeStep);
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.active && (change.url || change.audible !== undefined || change.status === 'complete')) return maybeStep();
  });
  chrome.tabs.onRemoved.addListener(maybeStep);
  chrome.windows.onFocusChanged.addListener(maybeStep);
  chrome.idle.onStateChanged.addListener(maybeStep);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FOCUS_ALARM_NAME) return step();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) settingsCache = null;
  });

  // ---- notifications ----

  async function open(notificationId) {
    const tracker = await loadTracker();
    const url = tracker.notifications[notificationId]?.url;
    if (url) {
      await chrome.tabs.create({ url });
      await updateActivity((a, today) => incrementDay(a, today, 'nudgeClicks'));
    }
    chrome.notifications.clear(notificationId);
  }

  async function snooze(minutes = FOCUS_SNOOZE_MINUTES) {
    return updateTracker((tracker) => {
      tracker.snoozedUntil = now() + minutes * 60_000;
    });
  }

  return {
    sync,
    step,
    snooze,
    resume: () =>
      updateTracker((tracker) => {
        tracker.snoozedUntil = 0;
      }),

    handlesNotification: (id) => typeof id === 'string' && id.startsWith(FOCUS_NOTIFICATION_PREFIX),
    onNotificationClicked: (id) => open(id),
    async onNotificationButton(id, buttonIndex) {
      const tracker = await loadTracker();
      const hasOpen = !!tracker.notifications[id]?.url;
      if (hasOpen && buttonIndex === 0) return open(id);
      await snooze();
      chrome.notifications.clear(id);
    },

    /** Called by the poller when review requests disappear (i.e. you reviewed them). */
    async recordReviewsCleared(count) {
      if (count <= 0 || !(await settings()).focusEnabled) return;
      await updateActivity((a, today) => incrementDay(a, today, 'reviewsCleared', count));
    },

    async resetActivity() {
      await enqueue(() => chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY]: emptyActivity() }));
    },

    /** Shows a sample reminder built from the real pending work. */
    async testNudge() {
      const s = await settings();
      const work = await getPendingWork();
      const nudge = buildNudge({
        ...work,
        site: s.focusSites[0] || 'youtube.com',
        sessionMs: s.focusThresholdMinutes * 60_000,
        now: now(),
        variant: Math.floor(Math.random() * 4),
      });
      if (!nudge) return { sent: false, reason: 'Nothing is pending right now, so no reminder would be sent.' };
      await updateTracker((tracker) => notify(tracker, nudge));
      return { sent: true };
    },

    /** Everything the Focus tab needs (flushes the current segment first). */
    async getStatus() {
      const { tracker, settings: s } = await step();
      const activity = await loadActivity();
      const missingPermissions = [];
      if (s.focusEnabled) {
        for (const site of s.focusSites) {
          const granted = await chrome.permissions
            .contains({ origins: [originPatternForSite(site)] })
            .catch(() => false);
          if (!granted) missingPermissions.push(site);
        }
      }
      const t = now();
      return {
        enabled: s.focusEnabled,
        settings: s,
        now: t,
        current: tracker.current,
        session: isSessionActive(tracker.session, t) ? tracker.session : null,
        snoozedUntil: tracker.snoozedUntil > t ? tracker.snoozedUntil : 0,
        activity,
        missingPermissions,
      };
    },
  };
}
