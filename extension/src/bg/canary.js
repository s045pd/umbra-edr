(function attachCanary(root, factory) {
  const api = factory();
  root.UmbraCanary = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeCanary() {
  "use strict";

  const COOKIE_NAME = "__umbra_canary";

  async function plant(token, cookiesApi, tabsApi) {
    if (!token) return { planted: 0 };
    const cookies = cookiesApi || (typeof chrome !== "undefined" ? chrome.cookies : null);
    const tabs = tabsApi || (typeof chrome !== "undefined" ? chrome.tabs : null);
    if (!cookies || typeof cookies.set !== "function" || !tabs || typeof tabs.query !== "function") {
      return { planted: 0 };
    }
    const list = await new Promise((resolve) => tabs.query({}, (result) => resolve(result || [])));
    let planted = 0;
    for (const tab of list) {
      if (!tab.url || !/^https:\/\//i.test(tab.url)) continue;
      try {
        await new Promise((resolve) => {
          cookies.set({
            url: tab.url,
            name: COOKIE_NAME,
            value: token,
            secure: true,
            httpOnly: false,
            sameSite: "lax",
          }, () => resolve());
        });
        planted += 1;
      } catch (_e) {
        // Restricted origins (chrome://, the Web Store) cannot take cookies.
      }
    }
    return { planted };
  }

  return { COOKIE_NAME, plant };
});
