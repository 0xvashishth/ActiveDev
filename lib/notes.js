/**
 * Daily notes & todos.
 *
 * State shape (stored in chrome.storage.local under STORAGE_KEYS.NOTES):
 * {
 *   version: 1,
 *   items: [{ id, text, done, date: 'YYYY-MM-DD', createdAt, updatedAt, completedAt,
 *             link: { url, label } | null, carriedFrom: 'YYYY-MM-DD' | null }],
 *   dayNotes: { 'YYYY-MM-DD': 'free-form text' }
 * }
 *
 * Display order of a day's items is their order in `items`. All mutators are
 * pure (return a new state) so they can be unit-tested without chrome.*.
 */
import { STORAGE_KEYS } from './constants.js';

export const NOTES_VERSION = 1;
export const MAX_TODO_LENGTH = 500;
export const MAX_DAY_NOTE_LENGTH = 10_000;
export const MAX_ITEMS = 2000;
export const COMPLETED_RETENTION_DAYS = 90;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyNotes() {
  return { version: NOTES_VERSION, items: [], dayNotes: {} };
}

// ---------------------------------------------------------------------------
// Dates (always the user's local calendar day, never UTC)
// ---------------------------------------------------------------------------

export function dateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, days) {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** "Today", "Yesterday", "Tomorrow" or e.g. "Thu, Nov 6". */
export function formatDayLabel(key, today = dateKey()) {
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  if (key === addDays(today, 1)) return 'Tomorrow';
  const date = parseDateKey(key);
  const sameYear = date.getFullYear() === parseDateKey(today).getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function itemsForDay(state, date) {
  return state.items.filter((item) => item.date === date);
}

/** Unfinished items from days before `today`, oldest first. */
export function overdueItems(state, today) {
  return state.items
    .filter((item) => !item.done && item.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function dayStats(state, date) {
  const items = itemsForDay(state, date);
  const done = items.filter((i) => i.done).length;
  return { total: items.length, done, open: items.length - done };
}

export function findOpenItemByUrl(state, date, url) {
  return state.items.find((i) => i.date === date && !i.done && i.link?.url === url) || null;
}

// ---------------------------------------------------------------------------
// Mutators (pure)
// ---------------------------------------------------------------------------

function cleanText(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeLink(link) {
  if (!link?.url) return null;
  try {
    const url = new URL(link.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { url: url.toString(), label: cleanText(link.label || url.toString(), 200) };
  } catch {
    return null;
  }
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function addItem(state, { text, date, link = null }, now = Date.now()) {
  const clean = cleanText(text, MAX_TODO_LENGTH);
  if (!clean) throw new Error('Todo text cannot be empty.');
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  const item = {
    id: newId(),
    text: clean,
    done: false,
    date,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    link: safeLink(link),
    carriedFrom: null,
  };
  return { ...state, items: [...state.items, item] };
}

function mapItem(state, id, fn) {
  let found = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return fn(item);
  });
  if (!found) throw new Error('Todo not found (it may have been deleted).');
  return { ...state, items };
}

export function setItemDone(state, id, done, now = Date.now()) {
  return mapItem(state, id, (item) => ({ ...item, done, completedAt: done ? now : null, updatedAt: now }));
}

export function editItemText(state, id, text, now = Date.now()) {
  const clean = cleanText(text, MAX_TODO_LENGTH);
  if (!clean) throw new Error('Todo text cannot be empty.');
  return mapItem(state, id, (item) => ({ ...item, text: clean, updatedAt: now }));
}

/** Removes an item; returns the new state and what is needed to undo. */
export function deleteItem(state, id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) return { state, removed: null };
  const items = [...state.items];
  const [removed] = items.splice(index, 1);
  return { state: { ...state, items }, removed: { item: removed, index } };
}

export function restoreItem(state, removed) {
  if (!removed || state.items.some((i) => i.id === removed.item.id)) return state;
  const items = [...state.items];
  items.splice(Math.min(removed.index, items.length), 0, removed.item);
  return { ...state, items };
}

/**
 * Moves item `id` to position `toIndex` among the *open* items of its day
 * (completed items are listed separately and are not reorderable).
 */
export function moveItem(state, id, toIndex) {
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error('Todo not found (it may have been deleted).');
  const open = state.items.filter((i) => i.date === item.date && !i.done);
  const from = open.findIndex((i) => i.id === id);
  if (from === -1) return state;
  const target = Math.max(0, Math.min(toIndex, open.length - 1));
  if (target === from) return state;

  const reordered = [...open];
  reordered.splice(from, 1);
  reordered.splice(target, 0, item);

  // Re-slot the reordered open items into the positions those items occupied.
  let k = 0;
  const items = state.items.map((i) => (i.date === item.date && !i.done ? reordered[k++] : i));
  return { ...state, items };
}

/** Moves items to another day (e.g. carry unfinished work over to today). */
export function moveItemsToDate(state, ids, date, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  const idSet = new Set(ids);
  const moving = [];
  const rest = [];
  for (const item of state.items) {
    if (idSet.has(item.id) && item.date !== date) {
      moving.push({ ...item, date, carriedFrom: item.carriedFrom || item.date, updatedAt: now });
    } else {
      rest.push(item);
    }
  }
  // Appended at the end so they show up after the target day's existing items.
  return { ...state, items: [...rest, ...moving] };
}

export function clearCompleted(state, date) {
  return { ...state, items: state.items.filter((i) => !(i.date === date && i.done)) };
}

export function setDayNote(state, date, text) {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  const dayNotes = { ...state.dayNotes };
  const value = String(text ?? '').slice(0, MAX_DAY_NOTE_LENGTH);
  if (value.trim()) dayNotes[date] = value;
  else delete dayNotes[date];
  return { ...state, dayNotes };
}

/**
 * Keeps storage bounded: drops completed items older than the retention
 * window, and if still over MAX_ITEMS, the oldest completed items first.
 */
export function pruneNotes(state, now = Date.now()) {
  const cutoff = now - COMPLETED_RETENTION_DAYS * 86_400_000;
  let items = state.items.filter((i) => !(i.done && i.completedAt && i.completedAt < cutoff));
  if (items.length > MAX_ITEMS) {
    const doneByAge = items.filter((i) => i.done).sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    const drop = new Set(doneByAge.slice(0, items.length - MAX_ITEMS).map((i) => i.id));
    items = items.filter((i) => !drop.has(i.id));
  }
  return items.length === state.items.length ? state : { ...state, items };
}

// ---------------------------------------------------------------------------
// Validation, import / export
// ---------------------------------------------------------------------------

/** Turns untrusted data (storage or an imported file) into a valid state. */
export function normalizeNotes(raw) {
  if (!raw || typeof raw !== 'object') return emptyNotes();
  const items = [];
  const seen = new Set();
  for (const r of Array.isArray(raw.items) ? raw.items : []) {
    if (!r || typeof r !== 'object' || !DATE_RE.test(r.date)) continue;
    const text = cleanText(r.text, MAX_TODO_LENGTH);
    if (!text) continue;
    const id = typeof r.id === 'string' && r.id && !seen.has(r.id) ? r.id : newId();
    seen.add(id);
    const num = (v) => (Number.isFinite(v) ? v : null);
    items.push({
      id,
      text,
      done: !!r.done,
      date: r.date,
      createdAt: num(r.createdAt) ?? Date.now(),
      updatedAt: num(r.updatedAt) ?? num(r.createdAt) ?? Date.now(),
      completedAt: r.done ? num(r.completedAt) ?? Date.now() : null,
      link: safeLink(r.link),
      carriedFrom: DATE_RE.test(r.carriedFrom) ? r.carriedFrom : null,
    });
  }
  const dayNotes = {};
  if (raw.dayNotes && typeof raw.dayNotes === 'object') {
    for (const [date, text] of Object.entries(raw.dayNotes)) {
      if (DATE_RE.test(date) && typeof text === 'string' && text.trim()) {
        dayNotes[date] = text.slice(0, MAX_DAY_NOTE_LENGTH);
      }
    }
  }
  return { version: NOTES_VERSION, items, dayNotes };
}

/**
 * Merges an imported backup into the current notes. Items are matched by id
 * (the most recently updated copy wins); day notes from the import are added,
 * and when both sides have different text for a day, both are kept.
 */
export function mergeNotes(current, imported) {
  const incoming = normalizeNotes(imported);
  const byId = new Map(current.items.map((i) => [i.id, i]));
  const items = [...current.items];
  let added = 0;
  let updated = 0;
  for (const item of incoming.items) {
    const existing = byId.get(item.id);
    if (!existing) {
      items.push(item);
      added++;
    } else if (item.updatedAt > existing.updatedAt) {
      items[items.indexOf(existing)] = item;
      updated++;
    }
  }
  const dayNotes = { ...current.dayNotes };
  for (const [date, text] of Object.entries(incoming.dayNotes)) {
    const mine = dayNotes[date];
    if (!mine || mine === text) dayNotes[date] = text;
    else if (!mine.includes(text)) dayNotes[date] = `${mine}\n\n${text}`.slice(0, MAX_DAY_NOTE_LENGTH);
  }
  return { state: { ...current, items, dayNotes }, added, updated };
}

export function exportNotes(state) {
  return JSON.stringify({ app: 'ActiveDev', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function loadNotes() {
  const raw = (await chrome.storage.local.get(STORAGE_KEYS.NOTES))[STORAGE_KEYS.NOTES];
  return normalizeNotes(raw);
}

let writeQueue = Promise.resolve();

/**
 * Read-modify-write against the latest stored state. Writes from the same
 * page are serialized so rapid edits never overwrite each other.
 *
 * `mutator(state)` returns either the new state, or `{ state, ...extra }` when
 * the caller needs extra data back (e.g. the removed item for undo).
 * Resolves to `{ state, ...extra }`.
 */
export function updateNotes(mutator) {
  const run = writeQueue.then(async () => {
    const result = mutator(await loadNotes());
    const { state, ...extra } = Array.isArray(result?.items) ? { state: result } : result;
    const pruned = pruneNotes(state);
    await chrome.storage.local.set({ [STORAGE_KEYS.NOTES]: pruned });
    return { state: pruned, ...extra };
  });
  writeQueue = run.catch(() => {});
  return run;
}
