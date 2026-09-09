const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Sensor manifest exposes snapshot v1 runtime storage and classic bootstrap", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.4.1");
  assert.ok(manifest.permissions.includes("alarms"));
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.deepEqual(manifest.background, { service_worker: "src/bg/background.js" });
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.equal(manifest.permissions.filter((permission) => permission === "unlimitedStorage").length, 1);
  const bootstrap = fs.readFileSync(path.resolve(__dirname, "../../src/bg/background.js"), "utf8");
  assert.match(bootstrap, /snapshot\/rpc-response\.js/);
  assert.match(bootstrap, /cookie-collect\.js/);
});
