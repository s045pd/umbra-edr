import assert from "node:assert/strict";
import test from "node:test";

import { createChromeAdapters } from "../src/bg/chrome-adapters.js";

function callbackChrome({ failMethod = "", historySearch } = {}) {
  const calls = [];
  const runtime = { lastError: null };
  const callbackMethod = (name, value) => (...args) => {
    calls.push({ name, args: args.slice(0, -1) });
    const callback = args.at(-1);
    if (failMethod === name) {
      runtime.lastError = { message: "SENTINEL_RAW_CHROME_ERROR_WITH_SECRET" };
      callback(undefined);
      runtime.lastError = null;
      return undefined;
    }
    const result = typeof value === "function" ? value(...args.slice(0, -1)) : value;
    callback(structuredClone(result));
    return undefined;
  };
  const chrome = {
    runtime,
    cookies: {
      getAllCookieStores: callbackMethod("cookies.getAllCookieStores", [
        { id: "incognito", tabIds: [99], incognito: true },
        { id: "regular", tabIds: [22], incognito: false },
      ]),
      getAll: callbackMethod("cookies.getAll", [
        { storeId: "regular", domain: "example.com", path: "/", name: "sid", value: "value" },
      ]),
      set: callbackMethod("cookies.set", {
        storeId: "regular",
        domain: "example.com",
        path: "/",
        name: "sid",
        value: "new",
      }),
      remove: callbackMethod("cookies.remove", { name: "sid", storeId: "regular", url: "https://example.com/" }),
      get: callbackMethod("cookies.get", { storeId: "regular", domain: "example.com", path: "/", name: "sid", value: "new" }),
    },
    history: {
      search: callbackMethod("history.search", historySearch || []),
      addUrl: callbackMethod("history.addUrl", undefined),
      deleteUrl: callbackMethod("history.deleteUrl", undefined),
      deleteAll: callbackMethod("history.deleteAll", undefined),
    },
    bookmarks: {
      getTree: callbackMethod("bookmarks.getTree", [
        { id: "0", children: [{ id: "1", title: "Bookmarks bar", children: [] }] },
      ]),
      create: callbackMethod("bookmarks.create", { id: "new-bookmark", parentId: "1", title: "New", url: "https://new.example/" }),
      update: callbackMethod("bookmarks.update", { id: "existing", title: "Updated", url: "https://same.example/" }),
      removeTree: callbackMethod("bookmarks.removeTree", undefined),
    },
    tabs: {
      query: callbackMethod("tabs.query", (query) =>
        query.currentWindow
          ? [{ id: 22, windowId: 44, url: "https://local.example/", active: true, pinned: false }]
          : [],
      ),
      create: callbackMethod("tabs.create", { id: 23, windowId: 44, url: "https://new.example/", active: false, pinned: false }),
      update: callbackMethod("tabs.update", { id: 23, windowId: 44, url: "https://new.example/", active: true, pinned: false }),
      remove: callbackMethod("tabs.remove", undefined),
      move: callbackMethod("tabs.move", { id: 23, index: 0 }),
    },
    downloads: new Proxy(
      {},
      {
        get() {
          throw new Error("native download history must never be accessed");
        },
      },
    ),
  };
  return { chrome, calls };
}

test("Chrome adapter selects the current regular store and completely enumerates browser categories", async () => {
  const historyQueries = [];
  const { chrome, calls } = callbackChrome({
    historySearch: (query) => {
      historyQueries.push(query);
      if (query.startTime === 0 && query.endTime === 100) {
        return [
          { url: "https://saturated-1.example", lastVisitTime: 1 },
          { url: "https://saturated-2.example", lastVisitTime: 2 },
          { url: "https://saturated-3.example", lastVisitTime: 3 },
        ];
      }
      if (query.startTime === 0) {
        return [
          { url: "https://a.example", lastVisitTime: 10, typedCount: 1, visitCount: 1 },
          { url: "https://b.example", lastVisitTime: 20, typedCount: 0, visitCount: 1 },
        ];
      }
      return [
        { url: "https://a.example", lastVisitTime: 90, typedCount: 3, visitCount: 4 },
        { url: "https://c.example", lastVisitTime: 80, typedCount: 0, visitCount: 1 },
      ];
    },
  });
  const adapters = createChromeAdapters(chrome, {
    historyResultCeiling: 3,
    historyMinimumWindowMs: 50,
  });

  const store = await adapters.getCurrentRegularCookieStore();
  assert.equal(store.id, "regular");
  assert.equal(store.incognito, false);
  assert.equal((await adapters.enumerateCookies("regular")).length, 1);
  const history = await adapters.enumerateHistory({ startTime: 0, endTime: 100 });
  assert.deepEqual(history.map((item) => item.url), [
    "https://a.example",
    "https://b.example",
    "https://c.example",
  ]);
  assert.equal(history[0].lastVisitTime, 90);
  assert.equal(history[0].typedCount, 3);
  assert.equal(history[0].visitCount, 4);
  assert.deepEqual(historyQueries.map((query) => [query.startTime, query.endTime]), [
    [0, 100],
    [0, 50],
    [50, 100],
  ]);
  assert.equal((await adapters.enumerateBookmarks()).length, 1);
  assert.equal((await adapters.enumerateTabs()).length, 1);

  assert.equal((await adapters.setCookie({ url: "https://example.com/", name: "sid", value: "new" })).value, "new");
  assert.equal((await adapters.readCookies({ url: "https://example.com/", name: "sid", storeId: "regular" })).length, 1);
  assert.equal((await adapters.readCookie({ url: "https://example.com/", name: "sid", storeId: "regular" })).value, "new");
  assert.equal((await adapters.removeCookie({ url: "https://example.com/", name: "sid", storeId: "regular" })).name, "sid");
  chrome.cookies.remove = (...args) => {
    calls.push({ name: "cookies.remove.missing", args: args.slice(0, -1) });
    args.at(-1)(null);
  };
  assert.equal(await adapters.removeCookie({ url: "https://example.com/", name: "missing", storeId: "regular" }), null);
  await adapters.addHistoryUrl("https://new.example/");
  await adapters.deleteHistoryUrl("https://new.example/");
  assert.equal((await adapters.createBookmark({ parentId: "1", title: "New", url: "https://new.example/" })).id, "new-bookmark");
  assert.equal((await adapters.updateBookmark("existing", { title: "Updated" })).title, "Updated");
  assert.equal((await adapters.createTab({ windowId: 44, url: "https://new.example/", active: false })).id, 23);
  assert.equal(calls.some((call) => call.name.startsWith("downloads.")), false);
});

test("Chrome adapter accepts real CookieStore objects that omit a non-standard incognito field", async () => {
  const { chrome } = callbackChrome();
  chrome.cookies.getAllCookieStores = async () => [{ id: "0", tabIds: [22] }];
  const adapter = createChromeAdapters(chrome);

  assert.deepEqual(await adapter.getCurrentRegularCookieStore(), { id: "0", tabIds: [22] });
});

test("Chrome adapter supports Promise-returning API variants", async () => {
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      query: async () => [{ id: 1, windowId: 4, url: "https://one.example/", active: true, pinned: false }],
      create: async (params) => ({ id: 2, ...params }),
    },
    cookies: {
      getAllCookieStores: async () => [{ id: "0", tabIds: [1], incognito: false }],
      getAll: async () => [],
      set: async (params) => ({ ...params, domain: "example.com", path: "/" }),
      get: async () => null,
      remove: async () => ({ name: "sid", storeId: "0", url: "https://example.com/" }),
    },
    history: { search: async () => [], addUrl: async () => undefined },
    bookmarks: {
      getTree: async () => [],
      create: async (params) => ({ id: "b1", ...params }),
      update: async (id, changes) => ({ id, ...changes }),
    },
  };
  const adapters = createChromeAdapters(chrome);
  assert.equal((await adapters.getCurrentRegularCookieStore()).id, "0");
  assert.deepEqual(await adapters.enumerateCookies("0"), []);
  assert.equal((await adapters.setCookie({ url: "https://example.com/", name: "sid", value: "v" })).name, "sid");
  await adapters.addHistoryUrl("https://example.com/");
  assert.equal((await adapters.createBookmark({ parentId: "1", title: "One" })).id, "b1");
  assert.equal((await adapters.createTab({ windowId: 4, url: "https://two.example/" })).id, 2);

  chrome.cookies.set = async () => {
    throw new Error("SENTINEL_PROMISE_REJECTION_SECRET");
  };
  const error = await adapters
    .setCookie({ url: "https://example.com/", name: "sid", value: "secret" })
    .catch((caught) => caught);
  assert.equal(error.code, "chrome_api_error");
  assert.equal(error.message.includes("SENTINEL"), false);
});

test("Chrome adapter rejects every callback lastError synchronously and never exposes its raw message", async (t) => {
  const cases = [
    ["cookie stores", "cookies.getAllCookieStores", (adapter) => adapter.getCurrentRegularCookieStore()],
    ["cookies getAll", "cookies.getAll", (adapter) => adapter.enumerateCookies("regular")],
    ["cookies set", "cookies.set", (adapter) => adapter.setCookie({ url: "https://example.com/", name: "sid", value: "v" })],
    ["cookies targeted getAll", "cookies.getAll", (adapter) => adapter.readCookies({ url: "https://example.com/", name: "sid", storeId: "regular" })],
    ["cookies get", "cookies.get", (adapter) => adapter.readCookie({ url: "https://example.com/", name: "sid" })],
    ["cookies remove", "cookies.remove", (adapter) => adapter.removeCookie({ url: "https://example.com/", name: "sid" })],
    ["history search", "history.search", (adapter) => adapter.enumerateHistory({ startTime: 0, endTime: 10 })],
    ["history add", "history.addUrl", (adapter) => adapter.addHistoryUrl("https://example.com/")],
    ["history delete URL", "history.deleteUrl", (adapter) => adapter.deleteHistoryUrl("https://example.com/")],
    ["bookmarks tree", "bookmarks.getTree", (adapter) => adapter.enumerateBookmarks()],
    ["bookmarks create", "bookmarks.create", (adapter) => adapter.createBookmark({ parentId: "1", title: "One" })],
    ["bookmarks update", "bookmarks.update", (adapter) => adapter.updateBookmark("b1", { title: "One" })],
    ["tabs query", "tabs.query", (adapter) => adapter.enumerateTabs()],
    ["tabs create", "tabs.create", (adapter) => adapter.createTab({ windowId: 44, url: "https://example.com/" })],
  ];

  for (const [name, failMethod, invoke] of cases) {
    await t.test(name, async () => {
      const { chrome } = callbackChrome({ failMethod });
      const adapters = createChromeAdapters(chrome);
      const error = await invoke(adapters).catch((caught) => caught);
      assert.equal(error.code, "chrome_api_error");
      assert.equal(error.message.includes("SENTINEL"), false);
      assert.equal(chrome.runtime.lastError, null, "mock clears lastError after callback returns");
    });
  }
});
