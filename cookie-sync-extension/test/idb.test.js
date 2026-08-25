import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_POINTER_RECORD_ID,
  SHADOWLINK_STORE_NAMES,
  SNAPSHOT_MANIFEST_CATEGORY,
  SNAPSHOT_MANIFEST_CHUNK_INDEX,
} from "../src/lib/constants.js";
import { ShadowLinkDB, upgradeShadowLinkDatabase } from "../src/bg/idb.js";
import { MemoryTransactionDriver, SchemaDatabaseFake } from "./helpers/memory-driver.js";

function makeDB() {
  return new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
}

test("IndexedDB upgrade creates exactly the six versioned stores with compound chunk keys", () => {
  const database = new SchemaDatabaseFake();
  upgradeShadowLinkDatabase(database);

  assert.deepEqual([...database.schemas.keys()].sort(), [...SHADOWLINK_STORE_NAMES].sort());
  assert.deepEqual(database.schemas.get("jobs").keyPath, "job_id");
  assert.deepEqual(database.schemas.get("backup_chunks").keyPath, [
    "backup_id",
    "category",
    "chunk_index",
  ]);
  assert.deepEqual(database.schemas.get("snapshot_cache").keyPath, [
    "job_id",
    "snapshot_id",
    "category",
    "chunk_index",
  ]);

  upgradeShadowLinkDatabase(database);
  assert.equal(database.schemas.size, SHADOWLINK_STORE_NAMES.length, "upgrade is idempotent");
});

test("IndexedDB backup promotion swaps active/previous pointers atomically", async () => {
  const driver = new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES);
  const db = new ShadowLinkDB(driver);
  await db.putBackupManifest({ backup_id: "backup-1", state: "staged", verified: true });
  await db.promoteBackup("backup-1", 100);
  assert.deepEqual(await db.getBackupPointers(), {
    backup_id: BACKUP_POINTER_RECORD_ID,
    record_type: "pointers",
    active_backup_id: "backup-1",
    previous_backup_id: null,
    updated_at: 100,
  });

  await db.putBackupManifest({ backup_id: "backup-2", state: "staged", verified: true });
  driver.failNextPut(
    "backup_manifests",
    (value) => value.backup_id === BACKUP_POINTER_RECORD_ID,
    new DOMException("disk full: secret payload must not be swallowed", "QuotaExceededError"),
  );
  await assert.rejects(() => db.promoteBackup("backup-2", 200), { name: "QuotaExceededError" });
  assert.equal((await db.getBackupPointers()).active_backup_id, "backup-1");
  assert.equal((await db.getBackupManifest("backup-1")).state, "active");
  assert.equal((await db.getBackupManifest("backup-2")).state, "staged");

  await db.promoteBackup("backup-2", 300);
  assert.equal((await db.getBackupPointers()).active_backup_id, "backup-2");
  assert.equal((await db.getBackupPointers()).previous_backup_id, "backup-1");
  assert.equal((await db.getBackupManifest("backup-1")).state, "previous");
  assert.equal((await db.getBackupManifest("backup-2")).state, "active");
});

test("IndexedDB leases are renewable and only expire into a new owner", async () => {
  const db = makeDB();
  await db.putJob({ job_id: "job-1", state: "running" });

  assert.equal(await db.claimJobLease("job-1", "worker-a", 1000, 100), true);
  assert.equal(await db.claimJobLease("job-1", "worker-b", 1000, 500), false);
  assert.equal(await db.renewJobLease("job-1", "worker-b", 1000, 600), false);
  assert.equal(await db.renewJobLease("job-1", "worker-a", 1000, 700), true);
  assert.equal((await db.getJob("job-1")).snapshot_lease_expires_at, 1700);
  assert.equal(await db.claimJobLease("job-1", "worker-b", 1000, 1701), true);
  assert.equal((await db.getJob("job-1")).snapshot_lease_owner, "worker-b");
});

test("IndexedDB snapshot downloads use a lease independent from the mutation writer", async () => {
  const db = makeDB();
  await db.putJob({ job_id: "job-independent-leases", state: "running" });

  assert.equal(
    await db.claimMutationLease("job-independent-leases", "mutation-worker", 1000, 100),
    true,
  );
  assert.equal(
    await db.claimJobLease("job-independent-leases", "snapshot-worker", 1000, 100),
    true,
  );

  const job = await db.getJob("job-independent-leases");
  assert.equal(job.lease_owner, "mutation-worker");
  assert.equal(job.snapshot_lease_owner, "snapshot-worker");
  assert.equal(job.lease_expires_at, 1100);
  assert.equal(job.snapshot_lease_expires_at, 1100);
  assert.equal(
    await db.claimJobLease("job-independent-leases", "second-snapshot-worker", 1000, 500),
    false,
  );
  assert.equal(
    await db.renewMutationLease("job-independent-leases", "mutation-worker", 1000, 600),
    true,
  );
});

test("snapshot completion and failure never release another mutation writer", async () => {
  const db = makeDB();
  await db.putJob({
    job_id: "job-snapshot-terminal",
    state: "downloading",
    lease_owner: "mutation-worker",
    lease_expires_at: 9000,
    snapshot_lease_owner: "snapshot-worker",
    snapshot_lease_expires_at: 8000,
  });

  assert.equal(
    await db.failJob("job-snapshot-terminal", "snapshot_transport_error", 1000, "losing-worker"),
    false,
  );
  let job = await db.getJob("job-snapshot-terminal");
  assert.equal(job.state, "downloading");
  assert.equal(job.lease_owner, "mutation-worker");
  assert.equal(job.snapshot_lease_owner, "snapshot-worker");

  await db.completeSnapshotJob("job-snapshot-terminal", { snapshot_id: "snapshot-1" }, 1100);
  job = await db.getJob("job-snapshot-terminal");
  assert.equal(job.lease_owner, "mutation-worker");
  assert.equal(job.lease_expires_at, 9000);
  assert.equal(job.snapshot_lease_owner, null);
  assert.equal(job.snapshot_lease_expires_at, null);
});

test("IndexedDB snapshot checkpoints keep raw ArrayBuffers and preserve job cursor atomically", async () => {
  const driver = new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES);
  const db = new ShadowLinkDB(driver);
  await db.putJob({ job_id: "job-1", state: "downloading", snapshot_lease_owner: "worker-a" });
  const bytes = Uint8Array.from([1, 2, 3]).buffer;

  await db.checkpointSnapshotChunk(
    "job-1",
    {
      job_id: "job-1",
      snapshot_id: "snapshot-1",
      category: "history",
      chunk_index: 2,
      bytes,
      chunk_sha256: "abc",
    },
    { leaseOwner: "worker-a", leaseExpiresAt: 4000, nextCategory: "history", nextIndex: 3 },
  );
  const stored = await db.getSnapshotChunk("job-1", "snapshot-1", "history", 2);
  assert.ok(stored.bytes instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(stored.bytes)], [1, 2, 3]);
  assert.deepEqual((await db.getJob("job-1")).snapshot_download, {
    snapshot_id: "snapshot-1",
    next_category: "history",
    next_index: 3,
  });
  assert.equal((await db.getJob("job-1")).snapshot_lease_owner, "worker-a");
  assert.equal((await db.getJob("job-1")).snapshot_lease_expires_at, 4000);

  driver.failNextPut(
    "jobs",
    (value) => value.job_id === "job-1" && value.snapshot_download?.next_index === 4,
    new DOMException("quota", "QuotaExceededError"),
  );
  await assert.rejects(
    () =>
      db.checkpointSnapshotChunk(
        "job-1",
        {
          job_id: "job-1",
          snapshot_id: "snapshot-1",
          category: "history",
          chunk_index: 3,
          bytes: Uint8Array.of(4).buffer,
          chunk_sha256: "def",
        },
        { leaseOwner: "worker-a", leaseExpiresAt: 5000, nextCategory: "history", nextIndex: 4 },
      ),
    { name: "QuotaExceededError" },
  );
  assert.equal(await db.getSnapshotChunk("job-1", "snapshot-1", "history", 3), undefined);
  assert.equal((await db.getJob("job-1")).snapshot_download.next_index, 3);
});

test("IndexedDB cleanup refuses snapshots referenced by active jobs or backups", async () => {
  const db = makeDB();
  await db.putJob({ job_id: "job-1", state: "mutating", snapshot_id: "snapshot-1" });
  await db.checkpointSnapshotChunk(
    "job-1",
    {
      job_id: "job-1",
      snapshot_id: "snapshot-1",
      category: "cookies",
      chunk_index: 0,
      bytes: Uint8Array.of(91, 93).buffer,
      chunk_sha256: "digest",
    },
    { nextCategory: "history", nextIndex: 0 },
  );
  await assert.rejects(() => db.cleanupSnapshot("snapshot-1"), { code: "snapshot_in_use" });

  await db.putJob({ job_id: "job-1", state: "complete", snapshot_id: "snapshot-1" });
  await db.putBackupManifest({
    backup_id: "backup-1",
    state: "active",
    verified: true,
    source_snapshot_id: "snapshot-1",
  });
  await assert.rejects(() => db.cleanupSnapshot("snapshot-1"), { code: "snapshot_in_use" });

  await db.putBackupManifest({
    backup_id: "backup-1",
    state: "previous",
    verified: true,
    source_snapshot_id: "snapshot-1",
  });
  assert.equal(await db.cleanupSnapshot("snapshot-1"), 1);
  assert.equal(await db.getSnapshotChunk("job-1", "snapshot-1", "cookies", 0), undefined);

  assert.equal(SNAPSHOT_MANIFEST_CATEGORY, "__manifest__");
  assert.equal(SNAPSHOT_MANIFEST_CHUNK_INDEX, -1);
});
