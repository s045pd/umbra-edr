import assert from "node:assert/strict";
import test from "node:test";

import { applyStorageOrigins, normalizeStorageOrigins } from "../src/bg/apply-storage.js";

test("normalizeStorageOrigins keeps http origins only", () => {
  const out = normalizeStorageOrigins([
    { origin: "https://app.example", localStorage: { a: "1" } },
    { origin: "chrome://extensions" },
    null,
    { origin: "http://intranet.example", sessionStorage: { b: "2" } },
  ]);
  assert.deepEqual(out.map((item) => item.origin), [
    "https://app.example",
    "http://intranet.example",
  ]);
});

test("applyStorageOrigins writes each origin through the adapter", async () => {
  const seen = [];
  const count = await applyStorageOrigins(
    [{ origin: "https://app.example", localStorage: { sid: "1" } }],
    async (origin) => {
      seen.push(origin.origin);
    },
  );
  assert.equal(count, 1);
  assert.deepEqual(seen, ["https://app.example"]);
});
