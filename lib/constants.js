export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_AUTH_BASE = 'https://github.com/login/oauth';

export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'ghrr_access_token',
  USER_INFO: 'ghrr_user_info',
  OAUTH_STATE: 'ghrr_oauth_state',
  REVIEW_REQUEST_PRS: 'ghrr_review_request_prs',
  MY_PRS: 'ghrr_my_prs',
  MY_PRS_STATE: 'ghrr_my_prs_state',
  NOTIFIED_REVIEWS: 'ghrr_notified_reviews',
  LAST_CHECKED: 'ghrr_last_checked',
  INITIAL_CHECK_DONE: 'ghrr_initial_check_done',
  SERVER_URL: 'ghrr_server_url',
};

export const POLL_INTERVAL_MINUTES = 3;
export const MAX_PRS = 30;

export const DEFAULT_SERVER_URL = 'http://localhost:3000';
