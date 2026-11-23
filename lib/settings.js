import { DEFAULT_SETTINGS, POLL_INTERVAL_OPTIONS, STORAGE_KEYS } from './constants.js';

export async function getSettings() {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] || {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  if (!POLL_INTERVAL_OPTIONS.includes(settings.pollIntervalMinutes)) {
    settings.pollIntervalMinutes = DEFAULT_SETTINGS.pollIntervalMinutes;
  }
  if (!Array.isArray(settings.focusSites)) settings.focusSites = [...DEFAULT_SETTINGS.focusSites];
  return settings;
}

let queue = Promise.resolve();

/** Merges `patch` into the stored settings (never drops unrelated keys). */
export function updateSettings(patch) {
  const run = queue.then(async () => {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] || {};
    const next = { ...stored, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
    return { ...DEFAULT_SETTINGS, ...next };
  });
  queue = run.catch(() => {});
  return run;
}
