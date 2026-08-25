const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const canonicalize = require("../../src/bg/snapshot/canonicalize.js");

const fixture = (name) =>
  path.resolve(__dirname, "../../../testdata/browser_snapshot", name);

test("Sensor JCS matches every shared valid vector", () => {
  const vectors = JSON.parse(fs.readFileSync(fixture("jcs_vectors.json"), "utf8"));
  for (const vector of vectors.valid) {
    assert.equal(canonicalize(JSON.parse(vector.input)), vector.canonical, vector.name);
  }
});

test("Sensor JCS rejects every shared invalid vector", () => {
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

test("Sensor JCS produces the shared manifest bytes", () => {
  const fixtureData = JSON.parse(fs.readFileSync(fixture("manifest_v1.json"), "utf8"));
  assert.equal(canonicalize(fixtureData.manifest), fixtureData.canonical);
});
