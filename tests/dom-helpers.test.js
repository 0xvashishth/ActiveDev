import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, flush } from './helpers/dom-mock.js';

const domModule = await import('../popup/dom.js');

let ctx;
beforeEach(() => {
  ctx = setupDom('popup/popup.html');
});
afterEach(() => {
  domModule._resetToastStateForTests();
  ctx.cleanup();
});

test('h() builds elements, sets attrs/classes/styles, and skips empty children', async () => {
  const { document } = ctx;
  const { h } = domModule;

  let clicked = 0;
  const el = h(
    'div',
    { className: 'a b', id: 'x', style: { color: 'red' }, title: 'hi', disabled: false, hidden: undefined, onClick: () => clicked++ },
    'hello ',
    null,
    false,
    '',
    ['world', ['!']]
  );
  document.body.append(el);
  assert.equal(el.className, 'a b');
  assert.equal(el.id, 'x');
  assert.equal(el.style.color, 'red');
  assert.equal(el.getAttribute('title'), 'hi');
  assert.equal(el.hasAttribute('disabled'), false);
  assert.equal(el.hasAttribute('hidden'), false);
  assert.equal(el.textContent, 'hello world!');

  el.click();
  assert.equal(clicked, 1);

  const boolAttr = h('input', { checked: true, value: 'v' });
  assert.equal(boolAttr.checked, true, 'checked is set as a live property, not an attribute');
  assert.equal(boolAttr.value, 'v');
});

test('h() nests real DOM nodes as children as-is', async () => {
  const { document } = ctx;
  const { h } = domModule;
  const child = document.createElement('span');
  const parent = h('div', {}, child);
  assert.equal(parent.firstChild, child);
});

test('openUrl opens a tab only when given a url', async () => {
  const { chrome } = ctx;
  const { openUrl } = domModule;
  openUrl('https://example.com');
  openUrl(null);
  openUrl(undefined);
  assert.deepEqual(chrome.tabs._created, ['https://example.com']);
});

test('setChildren filters out null/false/empty values that replaceChildren would render as text', async () => {
  const { document } = ctx;
  const { h, setChildren } = domModule;
  const container = document.createElement('div');
  setChildren(container, h('span', {}, 'a'), null, false, '', undefined, [h('span', {}, 'b'), false]);
  assert.equal(container.children.length, 2);
  assert.equal(container.textContent, 'ab');
});

test('showToast renders a message with an optional action and auto-hides after the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document } = ctx;
  const { showToast, hideToast } = domModule;

  let undone = false;
  showToast('Deleted', { label: 'Undo', onClick: () => (undone = true) }, 1000);
  const toast = document.getElementById('toast');
  assert.equal(toast.classList.contains('hidden'), false);
  assert.equal(toast.textContent, 'DeletedUndo');

  toast.querySelector('button').click();
  assert.equal(undone, true);
  assert.equal(toast.classList.contains('hidden'), true, 'clicking the action dismisses the toast');

  showToast('Just a message');
  assert.equal(toast.querySelector('button'), null, 'no button when there is no action');
  t.mock.timers.tick(5000);
  assert.equal(toast.classList.contains('hidden'), true, 'auto-hides after the default timeout');

  showToast('first');
  hideToast();
  assert.equal(toast.classList.contains('hidden'), true);
});

test('showToast queues messages so a quick second toast does not swallow the first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document } = ctx;
  const { showToast } = domModule;
  const toast = document.getElementById('toast');

  showToast('first', null, 1000);
  showToast('second', null, 1000);
  assert.equal(toast.textContent, 'first', 'first toast is still showing');

  t.mock.timers.tick(1000);
  assert.equal(toast.textContent, 'second', 'second toast appears once the first has had its turn');
  t.mock.timers.tick(1000);
  assert.equal(toast.classList.contains('hidden'), true);
});

test('showToast is a no-op when the popup has no #toast element', async () => {
  const { document } = ctx;
  document.getElementById('toast').remove();
  const { showToast } = domModule;
  assert.doesNotThrow(() => showToast('no-op'));
});
