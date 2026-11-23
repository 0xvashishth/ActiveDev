/** Tiny DOM builder. Children that are strings become text nodes (XSS-safe). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'checked' || key === 'value') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Like el.replaceChildren, but skips null/false/'' (which the DOM would render as text). */
export function setChildren(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
}

export function openUrl(url) {
  if (url) chrome.tabs.create({ url });
}

let toastTimer = null;
let toastQueue = [];

function renderNextToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  const next = toastQueue[0];
  if (!next) {
    toast.classList.add('hidden');
    return;
  }
  setChildren(
    toast,
    h('span', {}, next.message),
    next.action &&
      h(
        'button',
        {
          className: 'toast-btn',
          onClick: () => {
            next.action.onClick();
            advanceToastQueue();
          },
        },
        next.action.label
      )
  );
  toast.classList.remove('hidden');
  toastTimer = setTimeout(advanceToastQueue, next.timeoutMs);
}

function advanceToastQueue() {
  toastQueue.shift();
  renderNextToast();
}

/**
 * Queues a short message at the bottom of the popup, optionally with an
 * action (e.g. Undo). Toasts are shown one at a time in order, so a quick
 * second action (e.g. deleting two todos in a row) never hides the first
 * toast's Undo button before it had a chance to be seen. Plain informational
 * toasts (no action) default to a shorter display time so the queue doesn't
 * back up when several happen in quick succession.
 */
export function showToast(message, action = null, timeoutMs = action ? 5000 : 2500) {
  if (!document.getElementById('toast')) return;
  toastQueue.push({ message, action, timeoutMs });
  if (toastQueue.length === 1) renderNextToast();
}

export function hideToast() {
  toastQueue = [];
  clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.add('hidden');
}

/**
 * Test-only: this module is a singleton (popup.js imports it without cache
 * busting), so its toast queue/timer can otherwise leak between unrelated
 * tests in the same process. Not used by the extension itself.
 */
export function _resetToastStateForTests() {
  toastQueue = [];
  clearTimeout(toastTimer);
}
