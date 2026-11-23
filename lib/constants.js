export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'ghrr_access_token',
  TOKEN_SCOPES: 'ghrr_token_scopes',
  USER_INFO: 'ghrr_user_info',
  REVIEW_REQUEST_PRS: 'ghrr_review_request_prs',
  MY_PRS: 'ghrr_my_prs',
  SEEN_REVIEW_IDS: 'ghrr_seen_review_ids',
  NOTIFICATION_MAP: 'ghrr_notification_map',
  LAST_CHECKED: 'ghrr_last_checked',
  LAST_ERROR: 'ghrr_last_error',
  INITIAL_CHECK_DONE: 'ghrr_initial_check_done',
  ORGS: 'ghrr_orgs',
  ORGS_CHECKED_AT: 'ghrr_orgs_checked_at',
  SSO_ORGS: 'ghrr_sso_orgs',
  RATE_LIMIT_RESET: 'ghrr_rate_limit_reset',
  APP_INFO: 'ghrr_app_info',
  SETTINGS: 'ghrr_settings',
  NOTES: 'ghrr_notes',
  ACTIVITY: 'ghrr_activity',
};

// chrome.storage.session key (cleared when the browser restarts).
export const SESSION_KEYS = {
  FOCUS_TRACKER: 'ghrr_focus_tracker',
};

// Keys kept across logout: preferences, app info and the user's own notes.
const PERSISTENT_KEYS = [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.APP_INFO, STORAGE_KEYS.NOTES, STORAGE_KEYS.ACTIVITY];

// Keys that belong to the signed-in GitHub account; wiped on logout / re-login.
export const USER_SCOPED_KEYS = Object.values(STORAGE_KEYS).filter((key) => !PERSISTENT_KEYS.includes(key));

export const POLL_INTERVAL_OPTIONS = [1, 3, 5, 10, 15, 30];

export const DEFAULT_FOCUS_SITES = ['youtube.com', 'netflix.com', 'twitch.tv', 'reddit.com', 'x.com', 'instagram.com'];

export const DEFAULT_SETTINGS = {
  pollIntervalMinutes: 3,
  notifyReviewRequests: true,
  notifyReviewsOnMyPRs: true,
  includeDraftReviewRequests: true,

  // Focus monitor (opt-in): nudges you toward pending reviews when you spend
  // a long stretch on distracting sites.
  focusEnabled: false,
  focusSites: DEFAULT_FOCUS_SITES,
  focusThresholdMinutes: 30,
  focusRepeatMinutes: 15,
  focusWorkHoursOnly: false,
  focusWorkStartHour: 9,
  focusWorkEndHour: 18,
  focusWeekdaysOnly: true,
};

export const FOCUS_THRESHOLD_OPTIONS = [10, 15, 20, 30, 45, 60, 90, 120];
export const FOCUS_REPEAT_OPTIONS = [5, 10, 15, 20, 30, 60];
export const FOCUS_SNOOZE_MINUTES = 60;
export const FOCUS_ALARM_NAME = 'focus-tick';

export const ALARM_NAME = 'github-check';

// Upper bound on PRs fetched per list (search API max page size is 100).
export const MAX_PRS = 50;

// GraphQL detail queries are batched to keep each request small and fast.
export const GRAPHQL_BATCH_SIZE = 20;

// Org access checks are comparatively expensive and rarely change.
export const ORG_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export const MAX_SEEN_REVIEW_IDS = 2000;
export const MAX_NOTIFICATION_MAP_ENTRIES = 100;

// OAuth scopes requested by the server. `read:org` is required to list the
// organizations (and teams) the user belongs to, including private memberships.
export const REQUIRED_SCOPES = ['repo', 'read:org'];

// Change this to your deployed server URL before building/publishing
export const SERVER_URL = 'https://active-dev-murex.vercel.app';
