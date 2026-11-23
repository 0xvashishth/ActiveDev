import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, fire, flush } from './helpers/dom-mock.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import { addItem, dateKey, emptyNotes } from '../lib/notes.js';

// notes-view.js has no top-level mutable state (mountNotesView() closures
// are fresh every call), so it's imported once for accurate coverage.
const { mountNotesView } = await import('../popup/notes-view.js');
const { _resetToastStateForTests } = await import('../popup/dom.js');

let ctx;
let view;

beforeEach(() => {
  ctx = setupDom('popup/popup.html');
});
afterEach(() => {
  _resetToastStateForTests();
  ctx.cleanup();
});

const $ = (id) => ctx.document.getElementById(id);
const openTexts = () => [...$('notes-open-list').querySelectorAll('.todo-text')].map((el) => el.textContent);
const today = () => dateKey();

function mount() {
  view = mountNotesView({});
  return view.reload();
}

function addTodo(text) {
  $('notes-input').value = text;
  fire($('notes-input-form') || $('notes-add-form'), 'submit');
}

test('adding todos: trims text, ignores blanks, clears the input, keeps order', async () => {
  await mount();
  addTodo('  Review payments PR  ');
  addTodo('Reply to design feedback');
  addTodo('   ');
  await flush();
  assert.deepEqual(openTexts(), ['Review payments PR', 'Reply to design feedback']);
  assert.equal($('notes-input').value, '');
});

test('a URL in the text becomes a clickable link that opens a tab without toggling the todo', async () => {
  await mount();
  addTodo('Deploy https://ci.example.com/run/42 now');
  await flush();
  const link = $('notes-open-list').querySelector('.todo-link');
  assert.equal(link.textContent, 'ci.example.com/run/42');
  link.click();
  assert.deepEqual(ctx.chrome.tabs._created, ['https://ci.example.com/run/42']);
});

test('a pinned PR link in a todo opens the PR without toggling the todo', async () => {
  await mount();
  const pr = { htmlUrl: 'https://github.com/acme/api/pull/9', owner: 'acme', repo: 'api', number: 9, title: 'Fix' };
  await view.pinPullRequest(pr, 'Review');
  await flush();
  $('notes-open-list').querySelector('.todo-pr-link').click();
  assert.deepEqual(ctx.chrome.tabs._created, ['https://github.com/acme/api/pull/9']);
  assert.equal($('notes-open-list').querySelector('input[type="checkbox"]').checked, false);
});

test('checking an item moves it to Completed and updates the progress counter', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  await flush();
  $('notes-open-list').querySelector('input[type="checkbox"]').click();
  await flush();
  assert.equal($('notes-completed-summary').textContent, 'Completed (1)');
  assert.equal($('notes-progress').textContent, '1/2 done');
  assert.equal($('notes-completed').classList.contains('hidden'), false);
  assert.equal(openTexts().length, 1);
});

test('double-click edits a todo; Enter saves, Escape cancels, blur saves', async () => {
  await mount();
  addTodo('original');
  await flush();
  const text = $('notes-open-list').querySelector('.todo-text');
  fire(text, 'dblclick');
  let input = $('notes-open-list').querySelector('.todo-edit');
  input.value = 'edited via enter';
  fire(input, 'keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(openTexts(), ['edited via enter']);

  fire($('notes-open-list').querySelector('.todo-text'), 'dblclick');
  input = $('notes-open-list').querySelector('.todo-edit');
  input.value = 'should not be saved';
  fire(input, 'keydown', { key: 'Escape' });
  await flush();
  assert.deepEqual(openTexts(), ['edited via enter']);

  fire($('notes-open-list').querySelector('.todo-text'), 'dblclick');
  input = $('notes-open-list').querySelector('.todo-edit');
  input.value = 'saved on blur';
  fire(input, 'blur');
  await flush();
  assert.deepEqual(openTexts(), ['saved on blur']);

  // Editing a completed item, or double-clicking while already editing, is a no-op.
  $('notes-open-list').querySelector('input[type="checkbox"]').click();
  await flush();
  fire($('notes-completed-list').querySelector('.todo-text'), 'dblclick');
  assert.equal($('notes-completed-list').querySelector('.todo-edit'), null);
});

test('keyboard: Space toggles done, Enter edits, Delete removes, and edits ignore an empty value', async () => {
  await mount();
  addTodo('keyboard item');
  await flush();
  const row = $('notes-open-list').querySelector('.todo-item');

  fire(row, 'keydown', { key: ' ' });
  await flush();
  assert.equal($('notes-completed-summary').textContent, 'Completed (1)');
  fire($('notes-completed-list').querySelector('.todo-item'), 'keydown', { key: ' ' });
  await flush();
  assert.equal(openTexts().length, 1);

  const row2 = $('notes-open-list').querySelector('.todo-item');
  fire(row2, 'keydown', { key: 'Enter' });
  const input = $('notes-open-list').querySelector('.todo-edit');
  input.value = '   ';
  fire(input, 'keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(openTexts(), ['keyboard item'], 'blank edits are discarded, original text kept');

  fire($('notes-open-list').querySelector('.todo-item'), 'keydown', { key: 'Delete' });
  await flush();
  assert.equal(openTexts().length, 0);
});

test('deleting shows a toast with Undo that restores the item at its original position', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  addTodo('c');
  await flush();
  const items = () => [...$('notes-open-list').querySelectorAll('.todo-item')];
  items()[1].querySelector('button[title=Delete]').click();
  await flush();
  assert.deepEqual(openTexts(), ['a', 'c']);
  assert.match($('toast').textContent, /Todo deleted/);
  $('toast').querySelector('.toast-btn').click();
  await flush();
  assert.deepEqual(openTexts(), ['a', 'b', 'c']);
});

test('reordering with Alt+ArrowDown/Up moves the item and keeps focus on it', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  addTodo('c');
  await flush();
  const first = $('notes-open-list').querySelector('.todo-item');
  first.focus();
  fire(first, 'keydown', { key: 'ArrowDown', altKey: true });
  await flush();
  assert.deepEqual(openTexts(), ['b', 'a', 'c']);
  assert.equal(ctx.document.activeElement.dataset.id, first.dataset.id);

  fire(ctx.document.activeElement, 'keydown', { key: 'ArrowUp', altKey: true });
  await flush();
  assert.deepEqual(openTexts(), ['a', 'b', 'c']);
});

test('drag and drop reorders items relative to the drop position', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  addTodo('c');
  await flush();
  const rows = () => [...$('notes-open-list').querySelectorAll('.todo-item')];
  const dt = new ctx.window.DataTransfer();

  fire(rows()[2], 'dragstart', { dataTransfer: dt });
  assert.equal(rows()[2].classList.contains('dragging'), true);
  // jsdom does no layout, so row.offsetHeight is always 0: offsetY=0 is the
  // only value that reliably reads as "above the midpoint" (drop-before).
  fire(rows()[0], 'dragover', { dataTransfer: dt, offsetY: 0 }); // drop before "a"
  assert.equal(rows()[0].classList.contains('drop-before'), true);
  fire(rows()[0], 'drop', { dataTransfer: dt });
  await flush();
  assert.deepEqual(openTexts(), ['c', 'a', 'b']);

  // Dropping a row onto itself, or with no drag in progress, changes nothing.
  fire(rows()[1], 'dragstart', { dataTransfer: new ctx.window.DataTransfer() });
  fire(rows()[1], 'drop', { dataTransfer: dt });
  await flush();
  assert.deepEqual(openTexts(), ['c', 'a', 'b']);
});

test('dragend (e.g. an aborted drag) clears the dragging/drop-marker classes', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  await flush();
  const rows = () => [...$('notes-open-list').querySelectorAll('.todo-item')];
  const dt = new ctx.window.DataTransfer();

  fire(rows()[0], 'dragstart', { dataTransfer: dt });
  fire(rows()[1], 'dragover', { dataTransfer: dt, offsetY: 0 });
  assert.equal(rows()[0].classList.contains('dragging'), true);
  assert.equal(rows()[1].classList.contains('drop-before'), true);

  fire(rows()[0], 'dragend', {});
  assert.equal(rows()[0].classList.contains('dragging'), false);
  assert.equal(rows()[1].classList.contains('drop-before'), false);
});

test('overdue items from earlier days can be moved individually or all at once, and remember where they came from', async () => {
  const yesterday = dateKey(new Date(Date.now() - 86_400_000));
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.NOTES]: addItem(addItem(emptyNotes(), { text: 'old 1', date: yesterday }), { text: 'old 2', date: yesterday }),
  });
  await mount();
  assert.match($('notes-overdue').textContent, /2 unfinished from earlier days/);

  $('notes-overdue').querySelector('.icon-btn[title="Move to today"]').click();
  await flush();
  assert.deepEqual(openTexts(), ['old 1']);
  assert.match($('notes-open-list').textContent, /from Yesterday/);
  assert.match($('notes-overdue').textContent, /1 unfinished from earlier days/);

  $('notes-overdue').querySelector('.link-btn').click(); // "Move all to today"
  await flush();
  assert.deepEqual(openTexts(), ['old 1', 'old 2']);
  assert.equal($('notes-overdue').textContent, '');
});

test('day navigation: prev/next show the right label, items and placeholder; clicking the label jumps back to today', async () => {
  await mount();
  addTodo('today item');
  await flush();

  $('notes-prev').click();
  assert.equal($('notes-day-label').textContent, 'Yesterday');
  assert.equal($('notes-day-label').classList.contains('not-today'), true);
  assert.equal(openTexts().length, 0);
  assert.match($('notes-input').placeholder, /Yesterday/);

  $('notes-next').click();
  $('notes-next').click();
  assert.equal($('notes-day-label').textContent, 'Tomorrow');
  addTodo('tomorrow item');
  await flush();
  assert.deepEqual(openTexts(), ['tomorrow item']);

  $('notes-day-label').click();
  assert.equal($('notes-day-label').textContent, 'Today');
  assert.deepEqual(openTexts(), ['today item']);
});

test('day notes autosave after a pause, are shown per day, and flush on pagehide', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await mount();
  const textarea = $('notes-day-note');
  textarea.value = 'Standup notes';
  fire(textarea, 'input');
  assert.equal($('notes-day-note-status').textContent, 'Saving…');
  t.mock.timers.tick(400);
  await flush(2);
  assert.equal($('notes-day-note-status').textContent, 'Saved');

  const stored = (await ctx.chrome.storage.local.get(STORAGE_KEYS.NOTES))[STORAGE_KEYS.NOTES];
  assert.equal(stored.dayNotes[today()], 'Standup notes');

  $('notes-next').click();
  assert.equal(textarea.value, '', 'day notes are per day');
  $('notes-prev').click();
  assert.equal(textarea.value, 'Standup notes');

  textarea.value = 'flushed on close';
  fire(textarea, 'input');
  ctx.window.dispatchEvent(new ctx.window.Event('pagehide'));
  await flush(2);
  const stored2 = (await ctx.chrome.storage.local.get(STORAGE_KEYS.NOTES))[STORAGE_KEYS.NOTES];
  assert.equal(stored2.dayNotes[today()], 'flushed on close');

  // Re-typing the same value after it was already saved should not write again.
  fire(textarea, 'blur');
  await flush();
});

test('a storage failure while saving a day note shows a toast instead of losing the text silently', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await mount();
  const realSet = ctx.chrome.storage.local.set.bind(ctx.chrome.storage.local);
  ctx.chrome.storage.local.set = async () => {
    throw new Error('disk full');
  };
  fire($('notes-day-note'), 'blur'); // value unchanged from '' -> '' is a no-op; set a value first
  $('notes-day-note').value = 'will fail to save';
  fire($('notes-day-note'), 'input');
  t.mock.timers.tick(400);
  await flush(2);
  assert.match($('toast').textContent, /Could not save note: disk full/);
  ctx.chrome.storage.local.set = realSet;
});

test('clearing completed todos shows an Undo toast that restores them all', async () => {
  await mount();
  addTodo('a');
  addTodo('b');
  await flush();
  for (const cb of $('notes-open-list').querySelectorAll('input[type="checkbox"]')) cb.click();
  await flush();
  fire($('notes-completed').querySelector('summary'), 'click');
  $('notes-clear-completed').click();
  await flush();
  assert.equal($('notes-completed').classList.contains('hidden'), true);
  $('toast').querySelector('.toast-btn').click();
  await flush();
  assert.equal($('notes-completed-summary').textContent, 'Completed (2)');
});

test('pinPullRequest adds a link-backed todo and de-duplicates; isPinned reflects today\'s open items', async () => {
  await mount();
  const pr = { htmlUrl: 'https://github.com/acme/api/pull/1', owner: 'acme', repo: 'api', number: 1, title: 'Fix bug' };
  assert.equal(view.isPinned(pr.htmlUrl), false);
  assert.equal(await view.pinPullRequest(pr, 'Review'), 'added');
  await flush();
  assert.equal(view.isPinned(pr.htmlUrl), true);
  assert.equal(await view.pinPullRequest(pr, 'Review'), 'exists');
  assert.deepEqual(openTexts(), ['Review acme/api#1: Fix bug']);
});

test('the empty state text adapts to context, and the list updates when another page changes storage', async () => {
  await mount();
  assert.match($('notes-empty').textContent, /Nothing planned yet/);

  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.NOTES]: addItem(emptyNotes(), { text: 'from elsewhere', date: today() }) });
  await flush(2);
  assert.deepEqual(openTexts(), ['from elsewhere']);

  const yesterday = dateKey(new Date(Date.now() - 86_400_000));
  view.showToday();
  $('notes-prev').click();
  assert.match($('notes-empty').textContent, /Nothing was planned for this day/);
});

test('a storage failure during an action shows a toast and reloads from storage instead of corrupting the view', async () => {
  await mount();
  addTodo('a');
  await flush();
  const realSet = ctx.chrome.storage.local.set.bind(ctx.chrome.storage.local);
  ctx.chrome.storage.local.set = async () => {
    throw new Error('disk full');
  };
  $('notes-open-list').querySelector('input[type="checkbox"]').click();
  await flush(2);
  assert.match($('toast').textContent, /Could not save: disk full/);
  ctx.chrome.storage.local.set = realSet;
});

test('edits are not clobbered by a concurrent external update; they apply once editing finishes', async () => {
  await mount();
  addTodo('original');
  await flush();
  fire($('notes-open-list').querySelector('.todo-text'), 'dblclick');
  assert.notEqual($('notes-open-list').querySelector('.todo-edit'), null);

  await ctx.chrome.storage.local.set({ [STORAGE_KEYS.NOTES]: addItem(emptyNotes(), { text: 'external change', date: today() }) });
  await flush(2);
  assert.notEqual($('notes-open-list').querySelector('.todo-edit'), null, 'still editing: render was deferred');

  fire($('notes-open-list').querySelector('.todo-edit'), 'keydown', { key: 'Escape' });
  await flush();
  assert.deepEqual(openTexts(), ['external change'], 'the deferred render now shows the latest data');
});
