import { STORAGE_KEYS } from '../lib/constants.js';
import {
  MAX_DAY_NOTE_LENGTH,
  MAX_TODO_LENGTH,
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
  moveItem,
  moveItemsToDate,
  overdueItems,
  restoreItem,
  setDayNote,
  setItemDone,
  updateNotes,
} from '../lib/notes.js';
import { h, openUrl, showToast } from './dom.js';

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Renders todo text with clickable http(s) links. */
function linkify(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const url = match[0];
    parts.push(
      h(
        'a',
        {
          href: url,
          className: 'todo-link',
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openUrl(url);
          },
        },
        url.replace(/^https?:\/\/(www\.)?/, '')
      )
    );
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Mounts the Notes tab.
 * @param {{ onCountChange?: (count: number) => void, onNotesChange?: (state) => void }} hooks
 */
export function mountNotesView({ onCountChange = () => {}, onNotesChange = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const el = {
    prev: $('notes-prev'),
    next: $('notes-next'),
    dayLabel: $('notes-day-label'),
    progress: $('notes-progress'),
    form: $('notes-add-form'),
    input: $('notes-input'),
    overdue: $('notes-overdue'),
    openList: $('notes-open-list'),
    empty: $('notes-empty'),
    completed: $('notes-completed'),
    completedSummary: $('notes-completed-summary'),
    completedList: $('notes-completed-list'),
    clearCompleted: $('notes-clear-completed'),
    dayNote: $('notes-day-note'),
    dayNoteStatus: $('notes-day-note-status'),
  };

  let state = emptyNotes();
  let viewDate = dateKey();
  let editingId = null;
  let pendingRender = false;
  let dragId = null;

  el.input.maxLength = MAX_TODO_LENGTH;
  el.dayNote.maxLength = MAX_DAY_NOTE_LENGTH;

  // ---- mutations --------------------------------------------------------

  async function mutate(mutator, { errorPrefix = 'Could not save' } = {}) {
    try {
      const result = await updateNotes(mutator);
      state = result.state;
      render();
      return result;
    } catch (error) {
      showToast(`${errorPrefix}: ${error.message}`);
      await reload();
      return null;
    }
  }

  async function remove(item) {
    const result = await mutate((s) => deleteItem(s, item.id));
    if (result?.removed) {
      showToast('Todo deleted', { label: 'Undo', onClick: () => mutate((s) => restoreItem(s, result.removed)) });
    }
  }

  // ---- rendering ----------------------------------------------------------

  function todoRow(item, { reorderable }) {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: item.done,
      title: item.done ? 'Mark as not done' : 'Mark as done',
      'aria-label': `Done: ${item.text}`,
      onChange: (e) => mutate((s) => setItemDone(s, item.id, e.target.checked)),
    });

    const text = h('span', { className: 'todo-text', title: 'Double-click to edit' }, linkify(item.text));
    text.addEventListener('dblclick', () => startEdit(item, row, text));

    const row = h(
      'li',
      { className: `todo-item${item.done ? ' done' : ''}`, 'data-id': item.id, tabindex: '0' },
      reorderable && h('span', { className: 'drag-handle', title: 'Drag to reorder (or Alt+↑/↓)', 'aria-hidden': 'true' }, '⋮⋮'),
      checkbox,
      h(
        'div',
        { className: 'todo-body' },
        text,
        (item.link || item.carriedFrom) &&
          h(
            'div',
            { className: 'todo-meta' },
            item.link &&
              h(
                'a',
                {
                  href: item.link.url,
                  className: 'todo-pr-link',
                  onClick: (e) => {
                    e.preventDefault();
                    openUrl(item.link.url);
                  },
                },
                `↗ ${item.link.label}`
              ),
            item.carriedFrom && h('span', { title: `Originally planned for ${item.carriedFrom}` }, `↪ from ${formatDayLabel(item.carriedFrom)}`)
          )
      ),
      h(
        'div',
        { className: 'todo-actions' },
        !item.done && h('button', { className: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', onClick: () => startEdit(item, row, text) }, '✎'),
        h('button', { className: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', onClick: () => remove(item) }, '✕')
      )
    );

    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === ' ') {
        e.preventDefault();
        mutate((s) => setItemDone(s, item.id, !item.done));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(item);
      } else if (e.key === 'Enter' && !item.done) {
        e.preventDefault();
        startEdit(item, row, text);
      } else if (reorderable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const open = itemsForDay(state, viewDate).filter((i) => !i.done);
        const index = open.findIndex((i) => i.id === item.id);
        mutate((s) => moveItem(s, item.id, index + (e.key === 'ArrowUp' ? -1 : 1))).then(() =>
          el.openList.querySelector(`[data-id="${item.id}"]`)?.focus()
        );
      }
    });

    if (reorderable) attachDrag(row, item);
    return row;
  }

  function startEdit(item, row, textEl) {
    if (item.done || editingId) return;
    editingId = item.id;
    row.draggable = false;
    const input = h('input', { type: 'text', className: 'todo-edit', value: item.text, maxlength: String(MAX_TODO_LENGTH) });
    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      editingId = null;
      if (save && input.value.trim() && input.value.trim() !== item.text) {
        await mutate((s) => editItemText(s, item.id, input.value));
      } else {
        render();
      }
      el.openList.querySelector(`[data-id="${item.id}"]`)?.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    textEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function attachDrag(row, item) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragId = item.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      el.openList.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = dragId || e.dataTransfer.getData('text/plain');
      const after = row.classList.contains('drop-after');
      row.classList.remove('drop-before', 'drop-after');
      if (!id || id === item.id) return;
      const open = itemsForDay(state, viewDate).filter((i) => !i.done);
      const from = open.findIndex((i) => i.id === id);
      let to = open.findIndex((i) => i.id === item.id) + (after ? 1 : 0);
      if (from < to) to -= 1;
      mutate((s) => moveItem(s, id, to));
    });
  }

  function renderOverdue(today) {
    el.overdue.replaceChildren();
    if (viewDate !== today) return;
    const overdue = overdueItems(state, today);
    if (overdue.length === 0) return;

    el.overdue.append(
      h(
        'details',
        { className: 'overdue', open: true },
        h(
          'summary',
          {},
          h('span', {}, `⚠ ${overdue.length} unfinished from earlier days`),
          h(
            'button',
            {
              className: 'link-btn',
              onClick: (e) => {
                e.preventDefault();
                mutate((s) => moveItemsToDate(s, overdue.map((i) => i.id), today));
              },
            },
            'Move all to today'
          )
        ),
        h(
          'ul',
          { className: 'todo-list' },
          overdue.map((item) => {
            const row = todoRow(item, { reorderable: false });
            row.querySelector('.todo-actions').prepend(
              h(
                'button',
                { className: 'icon-btn', title: 'Move to today', onClick: () => mutate((s) => moveItemsToDate(s, [item.id], today)) },
                '→ Today'
              )
            );
            row.querySelector('.todo-body').append(h('div', { className: 'todo-meta' }, `planned ${formatDayLabel(item.date, today)}`));
            return row;
          })
        )
      )
    );
  }

  function render() {
    if (editingId) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const today = dateKey();
    const items = itemsForDay(state, viewDate);
    const open = items.filter((i) => !i.done);
    const done = items.filter((i) => i.done);
    const stats = dayStats(state, viewDate);

    el.dayLabel.textContent = formatDayLabel(viewDate, today);
    el.dayLabel.title = viewDate === today ? viewDate : `${viewDate} — click to go back to today`;
    el.dayLabel.classList.toggle('not-today', viewDate !== today);
    el.progress.textContent = stats.total ? `${stats.done}/${stats.total} done` : '';
    el.input.placeholder = viewDate === today ? 'Add a todo for today…' : `Add a todo for ${formatDayLabel(viewDate, today)}…`;

    renderOverdue(today);

    el.openList.replaceChildren(...open.map((item) => todoRow(item, { reorderable: open.length > 1 })));
    el.empty.classList.toggle('hidden', open.length > 0);
    el.empty.textContent = done.length
      ? 'All done for this day 🎉'
      : viewDate < today
        ? 'Nothing was planned for this day.'
        : 'Nothing planned yet. Add a todo above, or pin a PR with 📌.';

    el.completed.classList.toggle('hidden', done.length === 0);
    el.completedSummary.textContent = `Completed (${done.length})`;
    el.completedList.replaceChildren(...done.map((item) => todoRow(item, { reorderable: false })));

    if (document.activeElement !== el.dayNote) {
      el.dayNote.value = state.dayNotes[viewDate] || '';
    }
    el.dayNote.placeholder = `Free-form notes for ${formatDayLabel(viewDate, today).toLowerCase()}: standup points, links, reminders…`;

    onCountChange(dayStats(state, today).open + overdueItems(state, today).length);
    onNotesChange(state);
  }

  async function reload() {
    state = await loadNotes();
    render();
  }

  // ---- wiring -------------------------------------------------------------

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.input.value;
    if (!text.trim()) return;
    const result = await mutate((s) => addItem(s, { text, date: viewDate }));
    if (result) el.input.value = '';
    el.input.focus();
  });

  const goTo = (date) => {
    viewDate = date;
    render();
  };
  el.prev.addEventListener('click', () => goTo(addDays(viewDate, -1)));
  el.next.addEventListener('click', () => goTo(addDays(viewDate, 1)));
  el.dayLabel.addEventListener('click', () => goTo(dateKey()));

  el.clearCompleted.addEventListener('click', async () => {
    const before = state;
    const count = dayStats(state, viewDate).done;
    await mutate((s) => clearCompleted(s, viewDate));
    const removedIds = new Set(state.items.map((i) => i.id));
    const removed = before.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !removedIds.has(item.id));
    showToast(`Cleared ${count} completed`, {
      label: 'Undo',
      onClick: () => mutate((s) => removed.reduce((acc, r) => restoreItem(acc, r), s)),
    });
  });

  let noteTimer = null;
  const saveDayNote = async () => {
    clearTimeout(noteTimer);
    const date = viewDate;
    const value = el.dayNote.value;
    if ((state.dayNotes[date] || '') === value) return;
    const result = await updateNotes((s) => setDayNote(s, date, value)).catch((error) => {
      showToast(`Could not save note: ${error.message}`);
      return null;
    });
    if (result) {
      state = result.state;
      el.dayNoteStatus.textContent = 'Saved';
      setTimeout(() => (el.dayNoteStatus.textContent = ''), 1200);
    }
  };
  el.dayNote.addEventListener('input', () => {
    el.dayNoteStatus.textContent = 'Saving…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveDayNote, 400);
  });
  el.dayNote.addEventListener('blur', saveDayNote);
  // The popup can close at any moment; flush the note right away.
  window.addEventListener('pagehide', saveDayNote);

  // Changes from other extension pages (e.g. importing a backup in Settings).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.NOTES]) {
      loadNotes().then((fresh) => {
        state = fresh;
        render();
      });
    }
  });

  // ---- public API -----------------------------------------------------------

  return {
    reload,
    focusInput: () => el.input.focus(),
    isPinned: (url) => !!findOpenItemByUrl(state, dateKey(), url),
    /** Adds a PR to today's todos. Returns 'added' | 'exists'. */
    async pinPullRequest(pr, verb) {
      const today = dateKey();
      const url = pr.htmlUrl;
      if (findOpenItemByUrl(await loadNotes(), today, url)) return 'exists';
      const label = `${pr.owner}/${pr.repo}#${pr.number}`;
      await mutate((s) => addItem(s, { text: `${verb} ${label}: ${pr.title}`, date: today, link: { url, label } }));
      return 'added';
    },
    showToday: () => goTo(dateKey()),
  };
}
