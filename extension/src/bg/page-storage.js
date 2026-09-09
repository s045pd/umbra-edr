(function attachPageStorage(root, factory) {
  const api = factory();
  root.UmbraPageStorage = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makePageStorage() {
  "use strict";

  function dumpStorage(storage) {
    const out = {};
    if (!storage || typeof storage.length !== "number") return out;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key == null) continue;
      out[key] = storage.getItem(key);
    }
    return out;
  }

  function harvestFromWindow(win) {
    if (!win || !win.location) {
      return { origin: "", href: "", localStorage: {}, sessionStorage: {} };
    }
    return {
      origin: win.location.origin,
      href: win.location.href,
      localStorage: dumpStorage(win.localStorage),
      sessionStorage: dumpStorage(win.sessionStorage),
    };
  }

  return { dumpStorage, harvestFromWindow };
});
