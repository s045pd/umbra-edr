const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMemoryIDBAdapter,
  createSnapshotStore,
} = require("../../src/bg/snapshot/indexeddb-store.js");

test("IndexedDB snapshot store keeps cloned jobs, category bytes, and immutable chunks", async () => {
  const adapter = createMemoryIDBAdapter();
  const store = createSnapshotStore(adapter);
  const snapshotID = "11111111-2222-4333-8444-555555555555";
  const job = { snapshot_id: snapshotID, status: "pending", nested: { cursor: 1 } };
  await store.putJob(job);
  job.nested.cursor = 99;
  assert.equal((await store.getJob(snapshotID)).nested.cursor, 1, "store must use structured-clone semantics");

  const bytes = new TextEncoder().encode('[{"name":"sid"}]');
  await store.putCategoryBytes(snapshotID, "cookies", bytes);
  bytes[0] = 0;
  assert.equal(new TextDecoder().decode(await store.getCategoryBytes(snapshotID, "cookies")), '[{"name":"sid"}]');

  const chunk = {
    snapshot_id: snapshotID,
    category: "cookies",
    chunk_index: 0,
    chunk_count: 1,
    byte_length: 16,
    chunk_sha256: "a".repeat(64),
    category_sha256: "b".repeat(64),
    bytes: new Uint8Array([1, 2, 3]),
  };
  await store.putChunk(chunk);
  const read = await store.getChunk(snapshotID, "cookies", 0);
  read.bytes[0] = 9;
  assert.deepEqual(Array.from((await store.getChunk(snapshotID, "cookies", 0)).bytes), [1, 2, 3]);
  assert.deepEqual((await store.listJobs()).map((value) => value.snapshot_id), [snapshotID]);
});

test("IndexedDB snapshot deletion removes only one snapshot across every object store", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  for (const id of ["one", "two"]) {
    await store.putJob({ snapshot_id: id, status: "pending" });
    await store.putCategoryBytes(id, "cookies", new Uint8Array([id.length]));
    await store.putChunk({
      snapshot_id: id,
      category: "cookies",
      chunk_index: 0,
      bytes: new Uint8Array([id.length]),
    });
  }
  assert.equal(await store.deleteSnapshot("one"), true);
  assert.equal(await store.getJob("one"), undefined);
  assert.equal(await store.getCategoryBytes("one", "cookies"), undefined);
  assert.equal(await store.getChunk("one", "cookies", 0), undefined);
  assert.equal((await store.getJob("two")).snapshot_id, "two");
  assert.equal(await store.deleteSnapshot("one"), false, "release/delete is idempotent");
});

test("IndexedDB snapshot store validates fixed category and chunk keys", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  await assert.rejects(() => store.putCategoryBytes("id", "sessions", new Uint8Array()), /category/i);
  await assert.rejects(() => store.putChunk({ snapshot_id: "id", category: "cookies", chunk_index: -1 }), /chunk/i);
  await assert.rejects(() => store.putJob({ status: "pending" }), /snapshot/i);
});
