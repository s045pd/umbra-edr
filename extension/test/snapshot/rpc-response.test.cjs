const assert = require("node:assert/strict");
const test = require("node:test");

const rpc = require("../../src/bg/snapshot/rpc-response.js");

test("Sensor snapshot RPC failures keep the protocol shape and a sanitized code", async () => {
  const request = { snapshot_id: "00000000-0000-4000-8000-000000000001" };
  const result = await rpc.invoke(
    { async begin() { throw Object.assign(new Error("raw IndexedDB payload"), { code: "snapshot_storage_error" }); } },
    "begin",
    request,
  );
  assert.deepEqual(result, {
    status: "failed",
    snapshot_id: request.snapshot_id,
    error_code: "snapshot_storage_error",
  });
  assert.equal(JSON.stringify(result).includes("raw IndexedDB payload"), false);
});

test("Sensor snapshot RPC keeps snapshot deadline failures as their own code", async () => {
  const request = { snapshot_id: "00000000-0000-4000-8000-000000000003" };
  const result = await rpc.invoke(
    { async begin() { throw Object.assign(new Error("deadline"), { code: "invalid_snapshot_deadline" }); } },
    "begin",
    request,
  );
  assert.equal(result.error_code, "invalid_snapshot_deadline");
});

test("Sensor snapshot RPC maps unknown exceptions without leaking their text", async () => {
  const request = { snapshot_id: "00000000-0000-4000-8000-000000000002" };
  const result = await rpc.invoke(
    { async status() { throw new Error("secret local path and runtime details"); } },
    "status",
    request,
  );
  assert.deepEqual(result, {
    status: "failed",
    snapshot_id: request.snapshot_id,
    error_code: "sensor_snapshot_runtime_error",
  });
  assert.equal(JSON.stringify(result).includes("secret local path"), false);
});
