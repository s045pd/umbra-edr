function clone(value) {
  return structuredClone(value);
}

function findBookmark(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) {
    const found = findBookmark(child, id);
    if (found) return found;
  }
  return null;
}

function removeBookmark(node, id) {
  if (!Array.isArray(node?.children)) return false;
  const index = node.children.findIndex((child) => child.id === id);
  if (index >= 0) {
    node.children.splice(index, 1);
    return true;
  }
  return node.children.some((child) => removeBookmark(child, id));
}

export class FakeBrowser {
  constructor({ tabNavigationsAddHistory = false } = {}) {
    this.tabNavigationsAddHistory = tabNavigationsAddHistory;
    this.cookies = [
      {
        storeId: "regular",
        domain: "local.example",
        hostOnly: true,
        path: "/",
        name: "local",
        value: "local-value",
        secure: true,
        httpOnly: true,
        sameSite: "unspecified",
        session: true,
      },
    ];
    this.history = [
      { url: "https://local-history.example/", title: "Local", lastVisitTime: 1, typedCount: 0, visitCount: 1 },
    ];
    this.bookmarks = [
      {
        id: "0",
        children: [
          {
            id: "1",
            root: "bookmark_bar",
            title: "Bookmarks bar",
            children: [{ id: "local-bookmark", title: "Local", url: "https://local-bookmark.example/" }],
          },
          { id: "2", root: "other", title: "Other bookmarks", children: [] },
        ],
      },
    ];
    this.tabs = [
      { id: 1, windowId: 44, index: 0, url: "https://local-tab.example/", pinned: false, active: true },
    ];
    this.nextBookmarkID = 100;
    this.nextTabID = 10;
    this.operations = [];
    this.failures = new Map();
    this.operationHook = null;
  }

  failNext(method, count = 1) {
    this.failures.set(method, count);
  }

  async effect(method, detail, action) {
    this.operations.push({ method, detail: clone(detail) });
    await this.operationHook?.(method, detail);
    const remaining = this.failures.get(method) || 0;
    if (remaining > 0) {
      this.failures.set(method, remaining - 1);
      throw Object.assign(new Error(`raw ${method} failure`), { code: `${method.replaceAll(".", "_")}_failed` });
    }
    return action();
  }

  adapters() {
    return {
      getCurrentRegularCookieStore: async () => ({ id: "regular", incognito: false, tabIds: this.tabs.map((tab) => tab.id) }),
      enumerateCookies: async () => clone(this.cookies),
      setCookie: async (params) =>
        this.effect("cookies.set", params, () => {
          const domain = params.domain || new URL(params.url).hostname;
          const partition = JSON.stringify(params.partitionKey || null);
          const index = this.cookies.findIndex(
            (cookie) =>
              cookie.storeId === params.storeId &&
              cookie.domain.toLowerCase() === domain.toLowerCase() &&
              cookie.path === params.path &&
              cookie.name === params.name &&
              JSON.stringify(cookie.partitionKey || null) === partition,
          );
          const cookie = {
            storeId: params.storeId,
            domain,
            hostOnly: !("domain" in params),
            path: params.path,
            name: params.name,
            value: params.value,
            secure: params.secure,
            httpOnly: params.httpOnly,
            sameSite: params.sameSite,
            session: !("expirationDate" in params),
            ...(params.expirationDate ? { expirationDate: params.expirationDate } : {}),
            ...(params.partitionKey ? { partitionKey: clone(params.partitionKey) } : {}),
          };
          if (index >= 0) this.cookies[index] = cookie;
          else this.cookies.push(cookie);
          return clone(cookie);
        }),
      readCookie: async (params) => {
        const host = new URL(params.url).hostname;
        return clone(
          this.cookies.find(
            (cookie) =>
              cookie.storeId === params.storeId &&
              cookie.domain.replace(/^\./, "").toLowerCase() === host.toLowerCase() &&
              cookie.name === params.name &&
              JSON.stringify(cookie.partitionKey || null) === JSON.stringify(params.partitionKey || null),
          ) || null,
        );
      },
      removeCookie: async (params) =>
        this.effect("cookies.remove", params, () => {
          const host = new URL(params.url).hostname;
          const index = this.cookies.findIndex(
            (cookie) =>
              cookie.storeId === params.storeId &&
              cookie.domain.replace(/^\./, "").toLowerCase() === host.toLowerCase() &&
              cookie.name === params.name &&
              JSON.stringify(cookie.partitionKey || null) === JSON.stringify(params.partitionKey || null),
          );
          if (index < 0) return null;
          const [removed] = this.cookies.splice(index, 1);
          return { url: params.url, name: removed.name, storeId: removed.storeId };
        }),
      enumerateHistory: async () => clone(this.history),
      deleteAllHistory: async () =>
        this.effect("history.deleteAll", {}, () => {
          this.history = [];
        }),
      addHistoryUrl: async (url) =>
        this.effect("history.addUrl", { url }, () => {
          if (!this.history.some((item) => new URL(item.url).href === new URL(url).href)) {
            this.history.push({ url, title: "", lastVisitTime: Date.now(), typedCount: 0, visitCount: 1 });
          }
        }),
      deleteHistoryUrl: async (url) =>
        this.effect("history.deleteUrl", { url }, () => {
          const normalized = new URL(url).href;
          this.history = this.history.filter((item) => new URL(item.url).href !== normalized);
        }),
      enumerateBookmarks: async () => clone(this.bookmarks),
      createBookmark: async (params) =>
        this.effect("bookmarks.create", params, () => {
          const parent = findBookmark(this.bookmarks[0], params.parentId);
          if (!parent || !Array.isArray(parent.children)) throw new Error("parent unavailable");
          const node = {
            id: String(this.nextBookmarkID++),
            parentId: params.parentId,
            title: params.title,
            ...(params.url ? { url: params.url } : { children: [] }),
          };
          parent.children.push(node);
          return clone(node);
        }),
      updateBookmark: async (id, changes) =>
        this.effect("bookmarks.update", { id, changes }, () => {
          const node = findBookmark(this.bookmarks[0], id);
          if (!node) throw new Error("bookmark unavailable");
          Object.assign(node, changes);
          return clone(node);
        }),
      removeBookmarkTree: async (id) =>
        this.effect("bookmarks.removeTree", { id }, () => {
          if (!removeBookmark(this.bookmarks[0], id)) throw new Error("bookmark unavailable");
        }),
      enumerateTabs: async () => clone(this.tabs),
      createTab: async (params) =>
        this.effect("tabs.create", params, () => {
          if (params.active) this.tabs.forEach((tab) => (tab.active = false));
          const at = Number.isSafeInteger(params.index)
            ? Math.max(0, Math.min(params.index, this.tabs.length))
            : this.tabs.length;
          const tab = {
            id: this.nextTabID++,
            windowId: params.windowId,
            index: at,
            url: params.url || "about:blank",
            pinned: params.pinned === true,
            active: params.active === true,
          };
          this.tabs.splice(at, 0, tab);
          this.tabs.forEach((item, index) => (item.index = index));
          if (
            this.tabNavigationsAddHistory &&
            /^https?:/.test(tab.url) &&
            !this.history.some((item) => new URL(item.url).href === new URL(tab.url).href)
          ) {
            this.history.push({
              url: tab.url,
              title: "",
              lastVisitTime: Date.now(),
              typedCount: 0,
              visitCount: 1,
            });
          }
          return clone(tab);
        }),
      updateTab: async (id, changes) =>
        this.effect("tabs.update", { id, changes }, () => {
          const tab = this.tabs.find((item) => item.id === id);
          if (!tab) throw new Error("tab unavailable");
          if (changes.active) this.tabs.forEach((item) => (item.active = false));
          Object.assign(tab, changes);
          return clone(tab);
        }),
      removeTabs: async (ids) =>
        this.effect("tabs.remove", { ids: Array.isArray(ids) ? ids : [ids] }, () => {
          const set = new Set(Array.isArray(ids) ? ids : [ids]);
          this.tabs = this.tabs.filter((tab) => !set.has(tab.id));
          this.tabs.forEach((item, index) => (item.index = index));
          if (this.tabs.length && !this.tabs.some((tab) => tab.active)) this.tabs[0].active = true;
        }),
      applyPageStorage: async (origin) =>
        this.effect("storage.apply", origin, () => {
          if (!this.pageStorage) this.pageStorage = {};
          this.pageStorage[origin.origin] = {
            localStorage: { ...(origin.localStorage || {}) },
            sessionStorage: { ...(origin.sessionStorage || {}) },
          };
          return { origin: origin.origin };
        }),
    };
  }
}
