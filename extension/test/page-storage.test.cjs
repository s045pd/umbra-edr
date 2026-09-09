const assert = require("node:assert/strict");
const test = require("node:test");
const storage = require("../src/bg/page-storage.js");

function fakeStorage(map) {
  const keys = Object.keys(map);
  return {
    get length() { return keys.length; },
    key(i) { return keys[i]; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
  };
}

test("dumpStorage copies enumerable key/value pairs", () => {
  assert.deepEqual(storage.dumpStorage(fakeStorage({ token: "abc", theme: "dark" })), {
    token: "abc",
    theme: "dark",
  });
});

test("harvestFromWindow records origin plus both web storage bags", () => {
  const win = {
    location: { origin: "https://app.example", href: "https://app.example/app" },
    localStorage: fakeStorage({ sid: "1" }),
    sessionStorage: fakeStorage({ nonce: "2" }),
  };
  assert.deepEqual(storage.harvestFromWindow(win), {
    origin: "https://app.example",
    href: "https://app.example/app",
    localStorage: { sid: "1" },
    sessionStorage: { nonce: "2" },
  });
});
