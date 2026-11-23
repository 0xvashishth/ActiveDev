/**
 * Minimal in-memory mock of the chrome.* APIs used by ActiveDev.
 * Install with installChromeMock(); it sets globalThis.chrome.
 */
function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1),
    // Real chrome.* events don't let listeners block dispatch either, but
    // returning Promise.all(...) lets tests `await dispatch(...)` to settle
    // any async listeners before making assertions.
    dispatch: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
  };
}

function memoryArea(store, onChanged, areaName) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    _store: store,
    async get(keys) {
      if (keys == null) return clone(store);
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = clone(store[k]);
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      }
      onChanged.dispatch(changes, areaName);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
}

export function installChromeMock({ extensionId = 'abcdefghijklmnopabcdefghijklmnop' } = {}) {
  const store = {};
  const onChanged = event();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  // Simulated browser state for the focus monitor; tests mutate it directly.
  const browser = {
    tab: null, // { id, windowId, url, audible }
    windowFocused: true,
    idleState: 'active',
    grantedOrigins: new Set(),
  };

  const storageLocal = {
    _store: store,
    async get(keys) {
      if (keys == null) return clone(store);
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = clone(store[k]);
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      }
      onChanged.dispatch(changes, 'local');
    },
    async remove(keys) {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in store) {
          changes[k] = { oldValue: store[k] };
          delete store[k];
        }
      }
      if (Object.keys(changes).length) onChanged.dispatch(changes, 'local');
    },
  };

  const alarms = {};
  const notifications = [];
  const badge = { text: '', color: null };
  const tabs = [];

  const chrome = {
    runtime: {
      id: extensionId,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      openOptionsPage: () => {},
      getManifest: () => ({ version: 'test' }),
      getURL: (path) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, '')}`,
      /** Simulates chrome.runtime.sendMessage to the background's onMessage listeners. */
      sendMessage: (message) =>
        new Promise((resolve) => {
          let handled = false;
          for (const fn of chrome.runtime.onMessage.listeners) {
            const keepOpen = fn(message, {}, (resp) => {
              handled = true;
              resolve(resp);
            });
            if (keepOpen === true) return;
          }
          if (!handled) resolve(undefined);
        }),
    },
    _browser: browser,
    storage: { local: storageLocal, session: memoryArea({}, onChanged, 'session'), onChanged },
    alarms: {
      _alarms: alarms,
      onAlarm: event(),
      async get(name) {
        return alarms[name] ? { ...alarms[name] } : undefined;
      },
      async create(name, info) {
        alarms[name] = { name, periodInMinutes: info.periodInMinutes, scheduledTime: Date.now() };
      },
      async clear(name) {
        const had = !!alarms[name];
        delete alarms[name];
        return had;
      },
    },
    notifications: {
      _created: notifications,
      onClicked: event(),
      onButtonClicked: event(),
      onClosed: event(),
      async create(id, options) {
        notifications.push({ id, ...options });
        return id;
      },
      async clear() {
        return true;
      },
    },
    action: {
      _badge: badge,
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
    },
    tabs: {
      _created: tabs,
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      async create({ url }) {
        tabs.push(url);
      },
      async query() {
        if (!browser.tab) return [];
        const { url, ...rest } = browser.tab;
        // Like Chrome: the URL is only visible with a matching host permission.
        const host = url ? new URL(url).hostname : '';
        const visible = host === 'github.com' || [...browser.grantedOrigins].some((pattern) => {
          const site = pattern.replace('*://*.', '').replace('/*', '');
          return host === site || host.endsWith(`.${site}`);
        });
        return [{ windowId: 1, audible: false, ...rest, active: true, ...(visible ? { url } : {}) }];
      },
    },
    windows: {
      onFocusChanged: event(),
      async get() {
        return { id: 1, focused: browser.windowFocused };
      },
    },
    idle: {
      onStateChanged: event(),
      setDetectionInterval() {},
      async queryState() {
        return browser.idleState;
      },
    },
    permissions: {
      async contains({ origins = [] }) {
        return origins.every((o) => browser.grantedOrigins.has(o));
      },
      async request({ origins = [] }) {
        origins.forEach((o) => browser.grantedOrigins.add(o));
        return true;
      },
      async remove({ origins = [] }) {
        origins.forEach((o) => browser.grantedOrigins.delete(o));
        return true;
      },
    },
    identity: {
      getRedirectURL: () => `https://${extensionId}.chromiumapp.org/`,
      launchWebAuthFlow: async () => {
        throw new Error('launchWebAuthFlow not mocked');
      },
    },
  };

  globalThis.chrome = chrome;
  return chrome;
}
