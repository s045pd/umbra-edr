import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import canonicalize from "../src/lib/canonicalize.js";
import { sha256Hex } from "../src/lib/hash.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  path.resolve(here, "../../testdata/browser_snapshot", name);

test("ShadowLink JCS matches every shared valid vector", () => {
  const vectors = JSON.parse(fs.readFileSync(fixture("jcs_vectors.json"), "utf8"));
  for (const vector of vectors.valid) {
    assert.equal(canonicalize(JSON.parse(vector.input)), vector.canonical, vector.name);
  }
});

test("ShadowLink JCS rejects every shared invalid vector", () => {
  const vectors = JSON.parse(fs.readFileSync(fixture("jcs_vectors.json"), "utf8"));
  for (const vector of vectors.invalid) {
    assert.throws(() => canonicalize(JSON.parse(vector.input)), undefined, vector.name);
  }
  const invalidObjects = {
    nan: Number.NaN,
    positive_infinity: Number.POSITIVE_INFINITY,
    negative_infinity: Number.NEGATIVE_INFINITY,
  };
  for (const vector of vectors.object_invalid) {
    assert.throws(() => canonicalize(invalidObjects[vector.kind]), undefined, vector.name);
  }
});

test("ShadowLink JCS and SHA-256 produce the shared manifest digest", async () => {
  const fixtureData = JSON.parse(fs.readFileSync(fixture("manifest_v1.json"), "utf8"));
  const canonical = canonicalize(fixtureData.manifest);
  assert.equal(canonical, fixtureData.canonical);
  assert.equal(await sha256Hex(new TextEncoder().encode(canonical)), fixtureData.sha256);
});
