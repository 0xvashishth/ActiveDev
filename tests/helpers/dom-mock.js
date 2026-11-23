/**
 * Minimal DOM test harness for the extension's UI modules (popup/options).
 * Loads one of the real .html files into jsdom, exposes the usual browser
 * globals those modules expect, and gives each test a throwaway global scope
 * so DOM state from one test never leaks into the next.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { installChromeMock } from './chrome-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GLOBAL_PROPS = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'HTMLElement',
  'Node',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'confirm',
  'alert',
  'prompt',
];

let moduleCounter = 0;

/**
 * @param {string} htmlPath e.g. 'popup/popup.html'
 * @returns {{ dom, window, document, chrome, importFresh: (specifier: string) => Promise<any>, cleanup: () => void }}
 */
export function setupDom(htmlPath) {
  const html = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost/${htmlPath}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom implements neither layout nor scrolling; a no-op keeps code that
  // calls it (e.g. the settings page's quick-jump nav) from throwing.
  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  // jsdom doesn't implement drag-and-drop; a tiny stand-in is enough for our
  // handlers (they only read/write a few DataTransfer-like properties).
  class FakeDataTransfer {
    constructor() {
      this.data = {};
      this.effectAllowed = 'none';
    }
    setData(type, value) {
      this.data[type] = String(value);
    }
    getData(type) {
      return this.data[type] || '';
    }
  }
  window.DataTransfer = FakeDataTransfer;

  // Some of these (e.g. `navigator`) are read-only getters on Node's global
  // object, so they must be replaced with defineProperty rather than `=`.
  const previous = {};
  for (const prop of GLOBAL_PROPS) {
    previous[prop] = Object.getOwnPropertyDescriptor(globalThis, prop);
    Object.defineProperty(globalThis, prop, {
      value: window[prop],
      configurable: true,
      writable: true,
    });
  }

  const chrome = installChromeMock();

  // Modules under test run as plain Node ESM, not inside jsdom's sandbox, so
  // their setTimeout/setInterval calls are *real* Node timers. The popup
  // never explicitly tears those down (closing the popup window is enough in
  // a real browser), which would otherwise keep the test process alive
  // forever. Track every timer created while this DOM is "live" and clear
  // them all on cleanup.
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(fn, ms, ...args);
    timers.add(id);
    return id;
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    const id = realSetInterval(fn, ms, ...args);
    timers.add(id);
    return id;
  };

  function cleanup() {
    for (const id of timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    for (const prop of GLOBAL_PROPS) {
      if (previous[prop]) Object.defineProperty(globalThis, prop, previous[prop]);
      else delete globalThis[prop];
    }
    window.close();
  }

  /** Imports a module fresh (bypassing Node's ES module cache) so each test gets its own instance. */
  function importFresh(specifier) {
    const resolved = path.join(ROOT, specifier);
    return import(`${pathToFileUrl(resolved)}?t=${Date.now()}-${moduleCounter++}`);
  }

  return { dom, window, document: window.document, chrome, importFresh, cleanup };
}

function pathToFileUrl(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}

/**
 * Fires a real event so addEventListener-based code runs the same way it
 * would in a browser. `extra` (e.g. `key`, `altKey`, `dataTransfer`, the
 * `offsetY` our drag handlers read) is attached with defineProperty, since a
 * plain assignment would fail on jsdom's real KeyboardEvent/MouseEvent
 * getters; a base Event has none of those, so this always succeeds.
 */
export function fire(el, type, extra = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(extra)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  el.dispatchEvent(event);
  return event;
}

export function setValue(el, value) {
  el.value = value;
  fire(el, 'input');
}

/**
 * Waits for pending microtasks/async work to settle. Uses `setImmediate`
 * rather than `setTimeout(…, 0)` deliberately: tests that enable Node's
 * `t.mock.timers` fake `setTimeout`, which would otherwise capture flush()'s
 * own wait and leave it (and the test) hanging forever.
 */
export async function flush(times = 1) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}
