const assert = require("node:assert/strict");
const test = require("node:test");
const collect = require("../src/bg/cookie-collect.js");

test("mergeCookies keeps partitioned cookies distinct from host cookies of the same name", () => {
  const merged = collect.mergeCookies([
    [{ name: "sid", domain: ".example.com", path: "/", storeId: "0" }],
    [{
      name: "sid",
      domain: ".example.com",
      path: "/",
      storeId: "0",
      partitionKey: { topLevelSite: "https://ads.example", hasCrossSiteAncestor: true },
    }],
  ]);
  assert.equal(merged.length, 2);
});

test("originsFromTabs keeps unique http(s) origins and drops chrome urls", () => {
  const origins = collect.originsFromTabs([
    { url: "https://mail.example.com/inbox" },
    { url: "https://mail.example.com/sent" },
    { url: "chrome://extensions" },
    { url: "http://intranet.test/" },
  ]);
  assert.deepEqual(origins.sort(), ["http://intranet.test", "https://mail.example.com"]);
});

test("collectAllCookies unions unpartitioned cookies with per-origin CHIPS jars", async () => {
  const calls = [];
  const getAll = async (details) => {
    calls.push(details);
    if (details.partitionKey) {
      return [{ name: "chip", domain: ".example.com", path: "/", partitionKey: details.partitionKey }];
    }
    return [{ name: "sid", domain: ".example.com", path: "/" }];
  };
  const cookies = await collect.collectAllCookies(getAll, ["https://app.example"]);
  assert.equal(cookies.length, 2);
  assert.equal(calls.length, 2);
});
