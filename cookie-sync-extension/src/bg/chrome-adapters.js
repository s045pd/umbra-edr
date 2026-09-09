import { SNAPSHOT_MAX_CATEGORY_ITEMS } from "../lib/constants.js";

export class ChromeAdapterError extends Error {
  constructor(code = "chrome_api_error") {
    super("Chrome browser operation failed");
    this.name = "ChromeAdapterError";
    this.code = code;
  }
}

function adapterError(code = "chrome_api_error") {
  return new ChromeAdapterError(code);
}

function isThenable(value) {
  return value && typeof value.then === "function";
}

export function strictChromeCall(chromeAPI, owner, methodName, args = [], options = {}) {
  const method = owner?.[methodName];
  if (typeof method !== "function") return Promise.reject(adapterError("chrome_api_unavailable"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    const validate = (value) => {
      if (value === undefined && options.allowUndefined !== true) {
        throw adapterError("chrome_api_invalid_result");
      }
      if (value === null && options.allowNull !== true) {
        throw adapterError("chrome_api_invalid_result");
      }
      return options.validate ? options.validate(value) : value;
    };
    const callback = (value) => {
      // Chrome documents runtime.lastError as callback-scoped; it must be read
      // before the callback returns or the signal is lost.
      if (chromeAPI?.runtime?.lastError) {
        finish(reject, adapterError());
        return;
      }
      try {
        finish(resolve, validate(value));
      } catch (error) {
        finish(reject, error instanceof ChromeAdapterError ? error : adapterError("chrome_api_invalid_result"));
      }
    };

    let returned;
    try {
      returned = method.apply(owner, [...args, callback]);
    } catch {
      finish(reject, adapterError());
      return;
    }
    if (isThenable(returned)) {
      returned.then(
        (value) => {
          try {
            finish(resolve, validate(value));
          } catch (error) {
            finish(reject, error instanceof ChromeAdapterError ? error : adapterError("chrome_api_invalid_result"));
          }
        },
        () => finish(reject, adapterError()),
      );
    }
  });
}

function arrayResult(value) {
  if (!Array.isArray(value)) throw adapterError("chrome_api_invalid_result");
  return value;
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function stableObjectText(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableObjectText).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableObjectText(value[key])}`)
    .join(",")}}`;
}

function mergeHistoryItem(existing, incoming) {
  if (!existing) return { ...incoming };
  const oldVisit = numeric(existing.lastVisitTime);
  const newVisit = numeric(incoming.lastVisitTime);
  let selected;
  if (newVisit > oldVisit) selected = incoming;
  else if (newVisit < oldVisit) selected = existing;
  else selected = stableObjectText(incoming) > stableObjectText(existing) ? incoming : existing;
  const merged = { ...selected, url: incoming.url };
  if (existing.lastVisitTime !== undefined || incoming.lastVisitTime !== undefined) {
    merged.lastVisitTime = Math.max(oldVisit, newVisit);
  }
  if (existing.typedCount !== undefined || incoming.typedCount !== undefined) {
    merged.typedCount = Math.max(numeric(existing.typedCount), numeric(incoming.typedCount));
  }
  if (existing.visitCount !== undefined || incoming.visitCount !== undefined) {
    merged.visitCount = Math.max(numeric(existing.visitCount), numeric(incoming.visitCount));
  }
  return merged;
}

function validateHistoryItem(item) {
  if (!item || typeof item !== "object" || typeof item.url !== "string") {
    throw adapterError("history_invalid_item");
  }
  try {
    new URL(item.url);
  } catch {
    throw adapterError("history_invalid_item");
  }
  for (const field of ["lastVisitTime", "typedCount", "visitCount"]) {
    if (item[field] !== undefined && (!Number.isFinite(item[field]) || item[field] < 0)) {
      throw adapterError("history_invalid_item");
    }
  }
  return item;
}

export function createChromeAdapters(chromeAPI = globalThis.chrome, options = {}) {
  const historyResultCeiling = options.historyResultCeiling || 10_000;
  const historyMinimumWindowMs = options.historyMinimumWindowMs || 60_000;
  const historyMaxItems = options.historyMaxItems || SNAPSHOT_MAX_CATEGORY_ITEMS;
  if (
    !Number.isSafeInteger(historyResultCeiling) ||
    historyResultCeiling <= 0 ||
    !Number.isSafeInteger(historyMinimumWindowMs) ||
    historyMinimumWindowMs <= 0 ||
    !Number.isSafeInteger(historyMaxItems) ||
    historyMaxItems <= 0
  ) {
    throw new TypeError("invalid Chrome adapter history limits");
  }

  const call = (owner, method, args, callOptions) =>
    strictChromeCall(chromeAPI, owner, method, args, callOptions);

  const adapters = {
    async enumerateTabs(query = { currentWindow: true }) {
      return call(chromeAPI?.tabs, "query", [query], { validate: arrayResult });
    },

    async getCurrentRegularCookieStore() {
      const [tabs, stores] = await Promise.all([
        adapters.enumerateTabs({ currentWindow: true }),
        call(chromeAPI?.cookies, "getAllCookieStores", [], { validate: arrayResult }),
      ]);
      const currentTabIDs = new Set(
        tabs
          .filter((tab) => tab?.incognito !== true)
          .map((tab) => tab?.id)
          .filter(Number.isSafeInteger),
      );
      if (currentTabIDs.size === 0) throw adapterError("regular_cookie_store_unavailable");
      const regular = stores.filter(
        (store) =>
          store &&
          typeof store.id === "string" &&
          Array.isArray(store.tabIds),
      );
      const matching = regular.filter((store) => store.tabIds.some((id) => currentTabIDs.has(id)));
      if (matching.length === 1) return matching[0];
      if (matching.length === 0 && regular.length === 1) return regular[0];
      throw adapterError("regular_cookie_store_unavailable");
    },

    async enumerateCookies(storeId) {
      if (typeof storeId !== "string" || storeId.length === 0) {
        throw adapterError("regular_cookie_store_unavailable");
      }
      const cookies = await call(chromeAPI?.cookies, "getAll", [{ storeId }], {
        validate: arrayResult,
      });
      if (cookies.some((cookie) => !cookie || typeof cookie !== "object")) {
        throw adapterError("chrome_api_invalid_result");
      }
      return cookies;
    },

    setCookie(params) {
      return call(chromeAPI?.cookies, "set", [params]);
    },

    async readCookies(params) {
      const cookies = await call(chromeAPI?.cookies, "getAll", [params], {
        validate: arrayResult,
      });
      if (cookies.some((cookie) => !cookie || typeof cookie !== "object")) {
        throw adapterError("chrome_api_invalid_result");
      }
      return cookies;
    },

    readCookie(params) {
      return call(chromeAPI?.cookies, "get", [params], { allowNull: true });
    },

    removeCookie(params) {
      return call(chromeAPI?.cookies, "remove", [params], { allowNull: true });
    },

    async enumerateHistory({ startTime = 0, endTime = Date.now() } = {}) {
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime < startTime) {
        throw adapterError("history_window_incomplete");
      }
      const windows = [{ startTime, endTime }];
      const itemsByURL = new Map();
      while (windows.length > 0) {
        const window = windows.shift();
        const items = await call(
          chromeAPI?.history,
          "search",
          [
            {
              text: "",
              startTime: window.startTime,
              endTime: window.endTime,
              maxResults: historyResultCeiling,
            },
          ],
          { validate: arrayResult },
        );
        for (const item of items) validateHistoryItem(item);
        if (items.length >= historyResultCeiling) {
          const width = window.endTime - window.startTime;
          if (width <= historyMinimumWindowMs) {
            throw adapterError("history_window_incomplete");
          }
          const midpoint = window.startTime + Math.floor(width / 2);
          if (midpoint <= window.startTime || midpoint >= window.endTime) {
            throw adapterError("history_window_incomplete");
          }
          windows.unshift(
            { startTime: window.startTime, endTime: midpoint },
            { startTime: midpoint, endTime: window.endTime },
          );
          continue;
        }
        for (const item of items) {
          itemsByURL.set(item.url, mergeHistoryItem(itemsByURL.get(item.url), item));
        }
        if (itemsByURL.size > historyMaxItems) throw adapterError("snapshot_too_large");
      }
      return Array.from(itemsByURL.keys())
        .sort()
        .map((url) => itemsByURL.get(url));
    },

    addHistoryUrl(url) {
      return call(chromeAPI?.history, "addUrl", [{ url }], { allowUndefined: true });
    },

    deleteHistoryUrl(url) {
      return call(chromeAPI?.history, "deleteUrl", [{ url }], { allowUndefined: true });
    },

    deleteAllHistory() {
      return call(chromeAPI?.history, "deleteAll", [], { allowUndefined: true });
    },

    enumerateBookmarks() {
      return call(chromeAPI?.bookmarks, "getTree", [], { validate: arrayResult });
    },

    createBookmark(params) {
      return call(chromeAPI?.bookmarks, "create", [params]);
    },

    updateBookmark(id, changes) {
      return call(chromeAPI?.bookmarks, "update", [id, changes]);
    },

    removeBookmarkTree(id) {
      return call(chromeAPI?.bookmarks, "removeTree", [id], { allowUndefined: true });
    },

    createTab(params) {
      return call(chromeAPI?.tabs, "create", [params]);
    },

    updateTab(id, changes) {
      return call(chromeAPI?.tabs, "update", [id, changes]);
    },

    removeTabs(ids) {
      return call(chromeAPI?.tabs, "remove", [ids], { allowUndefined: true });
    },

    moveTab(id, moveProperties) {
      return call(chromeAPI?.tabs, "move", [id, moveProperties]);
    },

    waitForTabComplete(tabId, expectedOrigin, timeoutMs = 30_000) {
      const tabsAPI = chromeAPI?.tabs;
      if (!Number.isSafeInteger(tabId) || typeof expectedOrigin !== "string" || expectedOrigin.length === 0) {
        return Promise.reject(adapterError("chrome_api_invalid_result"));
      }
      if (!tabsAPI) return Promise.reject(adapterError("chrome_api_unavailable"));
      return new Promise((resolve, reject) => {
        let settled = false;
        let listener;
        const finish = (action, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (listener && tabsAPI.onUpdated?.removeListener) {
            tabsAPI.onUpdated.removeListener(listener);
          }
          action(value);
        };
        const matches = (tab) => {
          if (!tab || tab.id !== tabId || tab.status !== "complete") return false;
          try {
            return new URL(tab.url).origin === expectedOrigin;
          } catch {
            return false;
          }
        };
        listener = (id, _info, tab) => {
          if (id === tabId && matches(tab)) finish(resolve, tab);
        };
        const timer = setTimeout(() => finish(reject, adapterError("tab_navigation_timeout")), timeoutMs);
        if (tabsAPI.onUpdated?.addListener) tabsAPI.onUpdated.addListener(listener);
        call(tabsAPI, "get", [tabId], { allowUndefined: true })
          .then((tab) => {
            if (matches(tab)) finish(resolve, tab);
          })
          .catch(() => {});
      });
    },

    async applyPageStorage(origin, options = {}) {
      if (!origin || typeof origin.origin !== "string") {
        throw adapterError("chrome_api_invalid_result");
      }
      const bags = options.bags === "session" ? "session" : "local";
      const href = origin.href || `${origin.origin}/`;
      let tab = options.tab;
      let created = false;
      if (!tab || !Number.isSafeInteger(tab.id)) {
        tab = await adapters.createTab({ url: href, active: false });
        created = true;
      }
      tab = await adapters.waitForTabComplete(tab.id, origin.origin);
      if (chromeAPI?.scripting?.executeScript) {
        const localBag = bags === "session" ? {} : origin.localStorage || {};
        const sessionBag = bags === "local" ? {} : origin.sessionStorage || {};
        await call(
          chromeAPI.scripting,
          "executeScript",
          [
            {
              target: { tabId: tab.id },
              world: "MAIN",
              func: (ls, ss) => {
                try {
                  Object.entries(ls || {}).forEach(([key, value]) => localStorage.setItem(key, String(value)));
                  Object.entries(ss || {}).forEach(([key, value]) => sessionStorage.setItem(key, String(value)));
                } catch (_err) {
                  // Origin may be opaque.
                }
              },
              args: [localBag, sessionBag],
            },
          ],
          { allowUndefined: true },
        );
      }
      if (created && bags === "local" && tab?.id != null) {
        await adapters.removeTabs([tab.id]);
      }
      return tab;
    },
  };

  return Object.freeze(adapters);
}
