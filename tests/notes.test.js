import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { STORAGE_KEYS, USER_SCOPED_KEYS } from '../lib/constants.js';
import {
  addDays,
  addItem,
  clearCompleted,
  dateKey,
  dayStats,
  deleteItem,
  editItemText,
  emptyNotes,
  findOpenItemByUrl,
  formatDayLabel,
  itemsForDay,
  loadNotes,
  mergeNotes,
  moveItem,
  moveItemsToDate,
  normalizeNotes,
  overdueItems,
  pruneNotes,
  restoreItem,
  setDayNote,
  setItemDone,
  updateNotes,
  COMPLETED_RETENTION_DAYS,
} from '../lib/notes.js';

const D1 = '2024-05-01';
const D2 = '2024-05-02';
const texts = (items) => items.map((i) => i.text);

function withItems(date, ...names) {
  return names.reduce((s, text) => addItem(s, { text, date }), emptyNotes());
}

test('dateKey uses the local calendar day and addDays crosses month/year boundaries', () => {
  assert.equal(dateKey(new Date(2024, 0, 5, 23, 59)), '2024-01-05');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
});

test('formatDayLabel gives relative names around today', () => {
  assert.equal(formatDayLabel(D2, D2), 'Today');
  assert.equal(formatDayLabel(D1, D2), 'Yesterday');
  assert.equal(formatDayLabel('2024-05-03', D2), 'Tomorrow');
  assert.match(formatDayLabel('2024-04-20', D2), /20/);
});

test('addItem trims/validates text, rejects empty text and bad dates, sanitises links', () => {
  let s = addItem(emptyNotes(), { text: '  Review   PR  ', date: D1, link: { url: 'https://github.com/a/b/pull/1', label: 'a/b#1' } });
  assert.equal(s.items[0].text, 'Review PR');
  assert.equal(s.items[0].link.url, 'https://github.com/a/b/pull/1');
  assert.throws(() => addItem(s, { text: '   ', date: D1 }), /empty/);
  assert.throws(() => addItem(s, { text: 'x', date: 'yesterday' }), /Invalid date/);
  s = addItem(s, { text: 'evil', date: D1, link: { url: 'javascript:alert(1)' } });
  assert.equal(s.items[1].link, null, 'non-http links are dropped');
});

test('toggle, edit, stats', () => {
  let s = withItems(D1, 'a', 'b', 'c');
  const [a, b] = s.items;
  s = setItemDone(s, a.id, true, 1000);
  assert.equal(s.items[0].completedAt, 1000);
  s = editItemText(s, b.id, 'b2');
  assert.deepEqual(dayStats(s, D1), { total: 3, done: 1, open: 2 });
  assert.deepEqual(texts(itemsForDay(s, D1)), ['a', 'b2', 'c']);
  s = setItemDone(s, a.id, false);
  assert.equal(s.items[0].completedAt, null);
  assert.throws(() => editItemText(s, 'missing', 'x'), /not found/);
});

test('delete + undo restores the item at its original position', () => {
  const s = withItems(D1, 'a', 'b', 'c');
  const { state, removed } = deleteItem(s, s.items[1].id);
  assert.deepEqual(texts(state.items), ['a', 'c']);
  assert.deepEqual(texts(restoreItem(state, removed).items), ['a', 'b', 'c']);
  assert.equal(restoreItem(s, removed), s, 'restoring twice is a no-op');
});

test('moveItem reorders open items of a day without touching other days or completed items', () => {
  let s = withItems(D1, 'a', 'b', 'c', 'd');
  s = addItem(s, { text: 'other-day', date: D2 });
  s = setItemDone(s, s.items[1].id, true); // b done
  const d = s.items[3];
  s = moveItem(s, d.id, 0);
  const day = itemsForDay(s, D1);
  assert.deepEqual(texts(day.filter((i) => !i.done)), ['d', 'a', 'c']);
  assert.deepEqual(texts(day.filter((i) => i.done)), ['b']);
  assert.deepEqual(texts(itemsForDay(s, D2)), ['other-day']);
  assert.deepEqual(texts(itemsForDay(moveItem(s, d.id, 99), D1).filter((i) => !i.done)), ['a', 'c', 'd'], 'index is clamped');
});

test('overdue items can be carried over to today, remembering where they came from', () => {
  let s = withItems(D1, 'old-open', 'old-done');
  s = setItemDone(s, s.items[1].id, true);
  s = addItem(s, { text: 'today', date: D2 });
  const overdue = overdueItems(s, D2);
  assert.deepEqual(texts(overdue), ['old-open']);

  s = moveItemsToDate(s, overdue.map((i) => i.id), D2);
  assert.deepEqual(texts(itemsForDay(s, D2)), ['today', 'old-open']);
  assert.equal(itemsForDay(s, D2)[1].carriedFrom, D1);
  assert.deepEqual(overdueItems(s, D2), []);
  assert.deepEqual(texts(itemsForDay(s, D1)), ['old-done'], 'completed history stays on its day');
});

test('clearCompleted only clears the given day', () => {
  let s = withItems(D1, 'a');
  s = addItem(s, { text: 'b', date: D2 });
  s = setItemDone(setItemDone(s, s.items[0].id, true), s.items[1].id, true);
  assert.deepEqual(texts(clearCompleted(s, D1).items), ['b']);
});

test('findOpenItemByUrl detects a PR already pinned to the day', () => {
  const url = 'https://github.com/a/b/pull/1';
  const s = addItem(emptyNotes(), { text: 'x', date: D1, link: { url } });
  assert.ok(findOpenItemByUrl(s, D1, url));
  assert.equal(findOpenItemByUrl(s, D2, url), null);
  assert.equal(findOpenItemByUrl(setItemDone(s, s.items[0].id, true), D1, url), null);
});

test('day notes are stored per day and removed when emptied', () => {
  let s = setDayNote(emptyNotes(), D1, 'Standup: ship v1.1');
  assert.equal(s.dayNotes[D1], 'Standup: ship v1.1');
  s = setDayNote(s, D1, '   ');
  assert.deepEqual(s.dayNotes, {});
});

test('addItem drops a link whose URL cannot be parsed at all', () => {
  const s = addItem(emptyNotes(), { text: 'x', date: D1, link: { url: 'not a url at all' } });
  assert.equal(s.items[0].link, null);
});

test('pruneNotes also caps the total item count, dropping the oldest completed items first', () => {
  const now = Date.now();
  let s = emptyNotes();
  for (let i = 0; i < 2005; i++) {
    s = addItem(s, { text: `old-${i}`, date: D1 });
    s = setItemDone(s, s.items.at(-1).id, true, now - (2005 - i) * 1000);
  }
  s = addItem(s, { text: 'still-open', date: D1 });
  const pruned = pruneNotes(s, now);
  assert.equal(pruned.items.length, 2000);
  assert.ok(texts(pruned.items).includes('still-open'), 'open items are never dropped for being over the cap');
  assert.ok(!texts(pruned.items).includes('old-0'), 'oldest completed items are dropped first');
  assert.ok(texts(pruned.items).includes('old-2004'), 'most recently completed items are kept');
});

test('pruneNotes drops old completed items but keeps open ones forever', () => {
  const now = Date.now();
  let s = withItems(D1, 'old-done', 'old-open', 'recent-done');
  s = setItemDone(s, s.items[0].id, true, now - (COMPLETED_RETENTION_DAYS + 1) * 86_400_000);
  s = setItemDone(s, s.items[2].id, true, now - 86_400_000);
  assert.deepEqual(texts(pruneNotes(s, now).items), ['old-open', 'recent-done']);
});

test('normalizeNotes repairs untrusted data', () => {
  const s = normalizeNotes({
    items: [
      { id: 'x', text: 'ok', date: D1, done: true },
      { id: 'x', text: 'duplicate id', date: D1 },
      { text: '', date: D1 },
      { text: 'bad date', date: 'nope' },
      null,
    ],
    dayNotes: { [D1]: 'note', bad: 'x', [D2]: '  ' },
  });
  assert.deepEqual(texts(s.items), ['ok', 'duplicate id']);
  assert.notEqual(s.items[1].id, 'x');
  assert.ok(s.items[0].completedAt);
  assert.deepEqual(s.dayNotes, { [D1]: 'note' });
  assert.deepEqual(normalizeNotes('garbage'), emptyNotes());
});

test('mergeNotes adds new items, keeps the newest copy, and never loses day notes', () => {
  let local = withItems(D1, 'a');
  local = setDayNote(local, D1, 'mine');
  const a = local.items[0];
  const backup = {
    items: [{ ...a, text: 'a (edited later)', updatedAt: a.updatedAt + 10 }, { id: 'new', text: 'b', date: D2 }],
    dayNotes: { [D1]: 'theirs', [D2]: 'only theirs' },
  };
  const { state, added, updated } = mergeNotes(local, backup);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.deepEqual(texts(state.items), ['a (edited later)', 'b']);
  assert.equal(state.dayNotes[D1], 'mine\n\ntheirs');
  assert.equal(state.dayNotes[D2], 'only theirs');
  assert.equal(mergeNotes(state, backup).added, 0, 'importing twice does not duplicate');
});

test('storage: concurrent updates are serialized and notes survive logout', async () => {
  installChromeMock();
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((text) => updateNotes((s) => addItem(s, { text, date: D1 }))));
  assert.deepEqual(texts((await loadNotes()).items), ['a', 'b', 'c', 'd', 'e']);

  const { state, removed } = await updateNotes((s) => deleteItem(s, s.items[0].id));
  assert.equal(state.items.length, 4);
  assert.equal(removed.item.text, 'a');

  assert.equal(USER_SCOPED_KEYS.includes(STORAGE_KEYS.NOTES), false);
  await chrome.storage.local.remove(USER_SCOPED_KEYS); // what logout() does
  assert.equal((await loadNotes()).items.length, 4);
});

test('storage: a failed update does not block later ones', async () => {
  installChromeMock();
  await assert.rejects(updateNotes((s) => editItemText(s, 'missing', 'x')), /not found/);
  await updateNotes((s) => addItem(s, { text: 'still works', date: D1 }));
  assert.equal((await loadNotes()).items.length, 1);
});
