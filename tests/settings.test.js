import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../lib/constants.js';
import { getSettings, updateSettings } from '../lib/settings.js';

beforeEach(() => installChromeMock());

test('getSettings returns the defaults when nothing is stored', async () => {
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
});

test('getSettings merges stored values over the defaults', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { notifyReviewRequests: false } });
  const settings = await getSettings();
  assert.equal(settings.notifyReviewRequests, false);
  assert.equal(settings.pollIntervalMinutes, DEFAULT_SETTINGS.pollIntervalMinutes, 'other defaults are untouched');
});

test('getSettings repairs an invalid poll interval or a non-array focusSites', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { pollIntervalMinutes: 999, focusSites: 'not-an-array' } });
  const settings = await getSettings();
  assert.equal(settings.pollIntervalMinutes, DEFAULT_SETTINGS.pollIntervalMinutes);
  assert.deepEqual(settings.focusSites, DEFAULT_SETTINGS.focusSites);
});

test('updateSettings merges a patch into storage without dropping unrelated keys, and returns the full settings', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: { pollIntervalMinutes: 10, focusEnabled: true } });
  const result = await updateSettings({ notifyReviewRequests: false });
  assert.equal(result.notifyReviewRequests, false);
  assert.equal(result.pollIntervalMinutes, 10);
  assert.equal(result.focusEnabled, true);

  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.deepEqual(stored, { pollIntervalMinutes: 10, focusEnabled: true, notifyReviewRequests: false });
});

test('updateSettings serializes concurrent calls so rapid updates never clobber each other', async () => {
  await Promise.all([
    updateSettings({ a: 1 }),
    updateSettings({ b: 2 }),
    updateSettings({ c: 3 }),
  ]);
  const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
  assert.deepEqual(stored, { a: 1, b: 2, c: 3 });
});

test('a failed write does not jam the queue for later updates', async () => {
  const realSet = chrome.storage.local.set.bind(chrome.storage.local);
  chrome.storage.local.set = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(updateSettings({ a: 1 }), /disk full/);
  chrome.storage.local.set = realSet;

  await updateSettings({ b: 2 });
  assert.deepEqual((await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS], { b: 2 });
});
