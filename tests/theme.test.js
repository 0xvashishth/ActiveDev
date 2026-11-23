import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import { applyTheme, getTheme, initTheme, isValidTheme, nextTheme, setTheme, themeIcon } from '../lib/theme.js';

beforeEach(() => installChromeMock());

test('isValidTheme / nextTheme cycle through system -> light -> dark -> system', () => {
  assert.equal(isValidTheme('light'), true);
  assert.equal(isValidTheme('purple'), false);
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(nextTheme('garbage'), 'system', 'unknown values fall back to the start of the cycle');
});

test('themeIcon has a sensible fallback', () => {
  assert.equal(themeIcon('light'), '☀️');
  assert.equal(themeIcon('dark'), '🌙');
  assert.equal(themeIcon('system'), '🖥️');
  assert.equal(themeIcon('nope'), '🖥️');
});

test('getTheme defaults to system and persists valid settings only', async () => {
  assert.equal(await getTheme(), 'system');
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { theme: 'light' } });
  assert.equal(await getTheme(), 'light');
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { theme: 'neon' } });
  assert.equal(await getTheme(), 'system', 'invalid stored value falls back to the default');
});

test('setTheme validates and merges into existing settings', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { pollIntervalMinutes: 10 } });
  assert.equal(await setTheme('dark'), 'dark');
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.deepEqual(stored, { pollIntervalMinutes: 10, theme: 'dark' });
  await assert.rejects(setTheme('neon'), /Invalid theme/);
});

test('applyTheme sets or clears documentElement.dataset.theme', () => {
  const documentElement = { dataset: {} };
  applyTheme({ documentElement }, 'dark');
  assert.equal(documentElement.dataset.theme, 'dark');
  applyTheme({ documentElement }, 'light');
  assert.equal(documentElement.dataset.theme, 'light');
  applyTheme({ documentElement }, 'system');
  assert.equal('theme' in documentElement.dataset, false);
});

test('initTheme applies the stored theme and reacts to changes made elsewhere', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { theme: 'dark' } });
  const documentElement = { dataset: {} };
  await initTheme({ documentElement });
  assert.equal(documentElement.dataset.theme, 'dark');

  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { theme: 'light' } });
  assert.equal(documentElement.dataset.theme, 'light');

  await chrome.storage.local.remove(STORAGE_KEYS.SETTINGS);
  assert.equal('theme' in documentElement.dataset, false);

  // Changes to unrelated storage, or in another area, are ignored.
  documentElement.dataset.theme = 'dark';
  await chrome.storage.local.set({ other: 1 });
  assert.equal(documentElement.dataset.theme, 'dark');
});
