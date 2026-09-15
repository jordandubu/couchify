// Firefox exposes `browser` (promise-based). Chromium exposes only `chrome`
// with callback APIs; shim a minimal promise wrapper so the same code runs on
// both browsers.
if (typeof browser === "undefined" && typeof chrome !== "undefined") {
  globalThis.browser = {
    storage: {
      local: { get: (o) => chrome.storage.local.get(o), set: (o) => chrome.storage.local.set(o) },
      sync: { get: (o) => chrome.storage.sync.get(o), set: (o) => chrome.storage.sync.set(o), remove: (k) => chrome.storage.sync.remove(k) },
    },
    runtime: {
      sendMessage: (m) => new Promise((res, rej) => chrome.runtime.sendMessage(m, (r) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))),
      onMessage: { addListener: (f) => chrome.runtime.onMessage.addListener((m, s, send) => {
        const r = f(m, s);
        // If the listener wants to respond asynchronously, keep the channel open.
        if (r === true) return true;
        if (r !== undefined) send(r);
      })},
    },
    tabs: {
      query: (o) => chrome.tabs.query(o),
      sendMessage: (id, m) => new Promise((res) => chrome.tabs.sendMessage(id, m, () => res())),
    },
  };
}
