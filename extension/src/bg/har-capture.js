(function attachHARCapture(root, factory) {
  const api = factory();
  root.UmbraHARCapture = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeHARCapture() {
  "use strict";

  function emptyHAR(pageURL) {
    return {
      log: {
        version: "1.2",
        creator: { name: "Umbra Sensor", version: "0.4.2" },
        pages: [{ startedDateTime: new Date().toISOString(), id: "page_1", title: pageURL || "", pageTimings: {} }],
        entries: [],
      },
    };
  }

  function toEntry(req, res) {
    const started = req && req.wallTime ? new Date(req.wallTime * 1000).toISOString() : new Date().toISOString();
    return {
      startedDateTime: started,
      time: res && res.encodedDataLength ? 0 : 0,
      request: {
        method: (req && req.method) || "GET",
        url: (req && req.url) || "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: (res && res.status) || 0,
        statusText: (res && res.statusText) || "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        content: { size: (res && res.encodedDataLength) || 0, mimeType: (res && res.mimeType) || "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: (res && res.encodedDataLength) || 0,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  }

  async function capture(options) {
    const duration = Math.min(Math.max(Number(options && options.duration_ms) || 15000, 1000), 60000);
    const dbg = options && options.debuggerApi ? options.debuggerApi : (typeof chrome !== "undefined" ? chrome.debugger : null);
    const tabs = options && options.tabsApi ? options.tabsApi : (typeof chrome !== "undefined" ? chrome.tabs : null);
    if (!dbg || typeof dbg.attach !== "function") {
      return { error: "debugger_unavailable" };
    }
    const list = await new Promise((resolve) => tabs.query({ active: true, currentWindow: true }, (result) => resolve(result || [])));
    const tab = list[0];
    if (!tab || !tab.id) return { error: "no_active_tab" };
    const target = { tabId: tab.id };
    const requests = new Map();
    const har = emptyHAR(tab.url);

    function onEvent(source, method, params) {
      if (!source || source.tabId !== tab.id) return;
      if (method === "Network.requestWillBeSent" && params && params.request) {
        requests.set(params.requestId, params.request);
      }
      if (method === "Network.responseReceived" && params && params.response) {
        const req = requests.get(params.requestId);
        har.log.entries.push(toEntry(req, params.response));
      }
    }

    try {
      await new Promise((resolve, reject) => {
        dbg.attach(target, "1.3", () => {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    }

    dbg.onEvent.addListener(onEvent);
    await new Promise((resolve) => {
      dbg.sendCommand(target, "Network.enable", {}, () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, duration));
    dbg.onEvent.removeListener(onEvent);
    await new Promise((resolve) => {
      dbg.detach(target, () => resolve());
    });
    return { har, entries: har.log.entries.length };
  }

  return { emptyHAR, toEntry, capture };
});
