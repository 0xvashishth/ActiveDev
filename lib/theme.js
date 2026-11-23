/**
 * Light / dark / system theme. Kept tiny and separate from settings.js so it
 * can be applied as early as possible on every page without pulling in the
 * rest of the settings machinery.
 */
import { STORAGE_KEYS } from './constants.js';

export const THEMES = ['system', 'light', 'dark'];
export const DEFAULT_THEME = 'system';

export function isValidTheme(value) {
  return THEMES.includes(value);
}

export async function getTheme() {
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  const theme = stored?.theme;
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

export async function setTheme(theme) {
  if (!isValidTheme(theme)) throw new Error(`Invalid theme: ${theme}`);
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS] || {};
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { ...stored, theme } });
  return theme;
}

/**
 * Applies the theme to `documentElement.dataset.theme`. 'system' removes the
 * attribute entirely so the stylesheet's `prefers-color-scheme` query decides.
 */
export function applyTheme(doc, theme) {
  if (theme === 'light' || theme === 'dark') doc.documentElement.dataset.theme = theme;
  else delete doc.documentElement.dataset.theme;
}

/** Loads the stored theme, applies it, and keeps it in sync with changes made on other pages. */
export async function initTheme(doc) {
  applyTheme(doc, await getTheme());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
      const theme = changes[STORAGE_KEYS.SETTINGS].newValue?.theme;
      applyTheme(doc, isValidTheme(theme) ? theme : DEFAULT_THEME);
    }
  });
}

export function nextTheme(current) {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}

export function themeIcon(theme) {
  return { system: '🖥️', light: '☀️', dark: '🌙' }[theme] || '🖥️';
}
