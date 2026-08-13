/**
 * Minimal chrome.* stub for unit tests (storage + windows + runtime).
 */

/**
 * @returns {{
 *   store: Map<string, unknown>,
 *  reset: () => void,
 * }}
 */
export function installChromeMock() {
  /** @type {Map<string, unknown>} */
  const store = new Map();

  /** @type {Set<(changes: object, areaName: string) => void>} */
  const storageChangedListeners = new Set();

  /**
   * @param {Record<string, { oldValue?: unknown, newValue?: unknown }>} changes
   */
  function emitStorageChanged(changes) {
    if (Object.keys(changes).length === 0) return;
    for (const listener of storageChangedListeners) {
      listener(changes, "local");
    }
  }

  const storageLocal = {
    async get(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of keyList) {
        if (store.has(key)) out[key] = structuredClone(store.get(key));
      }
      return out;
    },
    async set(values) {
      /** @type {Record<string, { oldValue?: unknown, newValue?: unknown }>} */
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        const had = store.has(key);
        const oldValue = had ? structuredClone(store.get(key)) : undefined;
        const newValue = structuredClone(value);
        store.set(key, newValue);
        changes[key] = had ? { oldValue, newValue } : { newValue };
      }
      emitStorageChanged(changes);
    },
    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      /** @type {Record<string, { oldValue?: unknown, newValue?: unknown }>} */
      const changes = {};
      for (const key of keyList) {
        if (!store.has(key)) continue;
        changes[key] = { oldValue: structuredClone(store.get(key)) };
        store.delete(key);
      }
      emitStorageChanged(changes);
    },
  };

  const chrome = {
    storage: {
      local: storageLocal,
      onChanged: {
        addListener(listener) {
          storageChangedListeners.add(listener);
        },
        removeListener(listener) {
          storageChangedListeners.delete(listener);
        },
      },
    },
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://test-id/${path}`,
    },
    windows: {
      create: (opts, cb) => {
        queueMicrotask(() => cb?.({ id: 1001 }));
      },
      update: (_id, _opts, cb) => {
        queueMicrotask(() => cb?.());
      },
      get: (id, cb) => {
        queueMicrotask(() => cb?.({ id }));
      },
      remove: (_id, cb) => {
        queueMicrotask(() => cb?.());
      },
    },
    declarativeNetRequest: {
      updateDynamicRules: async () => {},
    },
  };

  globalThis.chrome = chrome;

  return {
    store,
    reset() {
      store.clear();
      chrome.runtime.lastError = undefined;
    },
  };
}
