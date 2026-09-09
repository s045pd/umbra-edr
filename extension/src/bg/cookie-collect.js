(function attachCookieCollect(root, factory) {
  const api = factory();
  root.UmbraCookieCollect = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeCookieCollect() {
  "use strict";

  function cookieIdentity(cookie) {
    if (!cookie || typeof cookie !== "object") return "";
    let partition = "";
    if (cookie.partitionKey && typeof cookie.partitionKey === "object") {
      partition = String(cookie.partitionKey.topLevelSite || "") + "\u0001" + String(cookie.partitionKey.hasCrossSiteAncestor || false);
    }
    return [cookie.storeId || "", partition, cookie.domain || "", cookie.path || "", cookie.name || ""].join("\u0000");
  }

  function mergeCookies(lists) {
    const map = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const cookie of list) {
        const key = cookieIdentity(cookie);
        if (!key) continue;
        map.set(key, cookie);
      }
    }
    return Array.from(map.values());
  }

  function originsFromTabs(tabs) {
    const set = new Set();
    for (const tab of tabs || []) {
      if (!tab || typeof tab.url !== "string") continue;
      try {
        const parsed = new URL(tab.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          set.add(parsed.origin);
        }
      } catch (_err) {
        // skip invalid tab urls
      }
    }
    return Array.from(set);
  }

  async function collectAllCookies(getAll, origins) {
    if (typeof getAll !== "function") return [];
    const batches = [];
    batches.push(await getAll({}));
    for (const origin of origins || []) {
      try {
        batches.push(await getAll({ partitionKey: { topLevelSite: origin } }));
      } catch (_err) {
        // Chrome builds without CHIPS ignore partitionKey.
      }
    }
    return mergeCookies(batches);
  }

  return { cookieIdentity, mergeCookies, originsFromTabs, collectAllCookies };
});
