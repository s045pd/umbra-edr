import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteBackup,
  prepareRestoreJob,
  confirmRestoreJob,
} from "../src/bg/restore-job.js";
import { stageDestinationBackup, verifyStagedBackup } from "../src/bg/backup.js";
import { ShadowLinkDB } from "../src/bg/idb.js";
import { JobRunner } from "../src/bg/job-runner.js";
import { SHADOWLINK_STORE_NAMES } from "../src/lib/constants.js";
import { FakeBrowser } from "./helpers/fake-browser.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

function makeDB() {
  return new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
}

function replacementCookie(name, value) {
  return {
    storeId: "regular",
    domain: "replacement.example",
    hostOnly: true,
    path: "/",
    name,
    value,
    secure: true,
    httpOnly: true,
    sameSite: "unspecified",
    session: true,
  };
}

function sourceState(browser) {
  return {
    cookies: structuredClone(browser.cookies),
    history: structuredClone(browser.history),
    bookmarks: structuredClone(browser.bookmarks),
    tabs: structuredClone(browser.tabs),
  };
}

function replaceDestination(browser) {
  browser.cookies = [replacementCookie("replacement", "replacement-secret")];
  browser.history = [
    { url: "https://replacement-history.example/", title: "Replacement", lastVisitTime: 20, typedCount: 0, visitCount: 1 },
  ];
  browser.bookmarks[0].children[0].children = [
    { id: "replacement-bookmark", title: "Replacement", url: "https://replacement-bookmark.example/" },
  ];
  browser.tabs = [
    { id: 5, windowId: 44, index: 0, url: "https://replacement-tab.example/", pinned: true, active: true },
  ];
}

async function environment() {
  const db = makeDB();
  const browser = new FakeBrowser();
  const original = sourceState(browser);
  let clock = 100;
  let sequence = 0;
  const deps = {
    db,
    adapters: browser.adapters(),
    writableRoots: { bookmark_bar: "1", other: "2" },
    currentWindowId: 44,
    cookieEnumerationComplete: true,
    supportsPartitionKey: true,
    now: () => ++clock,
    randomUUID: () => `restore-generated-${++sequence}`,
  };
  const source = await stageDestinationBackup(
    { purpose: "clone", backupId: "restore-source" },
    deps,
  );
  const sourceManifest = await verifyStagedBackup(source.backup_id, { db, now: deps.now });
  await db.promoteBackup(source.backup_id, deps.now());
  replaceDestination(browser);
  await db.replaceActiveArchive(
    "history",
    [{ url: "https://replacement-archive.example/", title: "Replacement archive", lastVisitTime: 20, typedCount: 0, visitCount: 1 }],
    { archiveId: "replacement-history", createdAt: deps.now(), source: "test" },
  );
  await db.replaceActiveArchive(
    "downloads",
    [{ url: "https://replacement-download.example/file", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/replacement" }],
    { archiveId: "replacement-downloads", createdAt: deps.now(), source: "test" },
  );
  browser.operations.length = 0;
  return { db, browser, deps, original, source, sourceManifest };
}

function request(jobId = "restore-job") {
  return {
    jobId,
    restoreSourceBackupId: "restore-source",
    acceptedOmissions: false,
  };
}

function confirmation(prepared, changes = {}) {
  return {
    restoreSourceBackupId: prepared.restore_source_backup_id,
    restoreSourceManifestSHA256: prepared.restore_source_manifest_sha256,
    restoreRecoveryBackupId: prepared.restore_recovery_backup_id,
    restoreRecoveryManifestSHA256: prepared.restore_recovery_manifest_sha256,
    ...changes,
  };
}

test("Restore keeps source and recovery backup roles distinct and retains recovery as Undo Restore", async () => {
  const { db, browser, deps, original, sourceManifest } = await environment();
  const prepared = await prepareRestoreJob(request(), deps);
  assert.equal(prepared.state, "AWAITING_RESTORE_CONFIRMATION");
  assert.equal(prepared.restore_source_backup_id, "restore-source");
  assert.equal(prepared.restore_source_manifest_sha256, sourceManifest.manifest_sha256);
  assert.equal(prepared.restore_recovery_backup_id, "restore-generated-1");
  assert.notEqual(prepared.restore_recovery_backup_id, prepared.restore_source_backup_id);
  const recoveryBefore = await db.getBackupManifest(prepared.restore_recovery_backup_id);
  assert.equal(recoveryBefore.purpose, "restore_recovery");
  assert.equal(recoveryBefore.verified, true);
  assert.equal(recoveryBefore.awaiting_confirmation, true);

  const completed = await confirmRestoreJob("restore-job", confirmation(prepared), deps);
  assert.equal(completed.state, "COMPLETE");
  assert.equal(completed.restore_source_backup_id, "restore-source");
  assert.equal(completed.restore_recovery_backup_id, "restore-generated-1");
  assert.equal(completed.undo_restore_backup_id, "restore-generated-1");
  assert.equal(completed.result.operation, "restore");
  assert.equal((await db.getBackupPointers()).active_backup_id, "restore-generated-1");
  assert.equal((await db.getBackupPointers()).previous_backup_id, "restore-source");
  assert.ok(await db.getBackupManifest("restore-source"), "Restore source remains immutable and retained");
  assert.ok(await db.getBackupManifest("restore-generated-1"), "Undo Restore backup remains retained");
  assert.deepEqual(browser.cookies, original.cookies);
  assert.deepEqual(browser.history.map((item) => new URL(item.url).href), original.history.map((item) => new URL(item.url).href));
  assert.deepEqual(browser.tabs.map((tab) => [tab.url, tab.pinned, tab.active]), original.tabs.map((tab) => [tab.url, tab.pinned, tab.active]));
});

test("Restore confirmation is bound to both source and recovery IDs/digests", async () => {
  const { browser, deps } = await environment();
  const prepared = await prepareRestoreJob(request("restore-binding"), deps);
  browser.operations.length = 0;
  const invalid = [
    { restoreSourceBackupId: "wrong-source" },
    { restoreSourceManifestSHA256: "0".repeat(64) },
    { restoreRecoveryBackupId: "wrong-recovery" },
    { restoreRecoveryManifestSHA256: "0".repeat(64) },
  ];
  for (const changes of invalid) {
    await assert.rejects(
      () => confirmRestoreJob("restore-binding", confirmation(prepared, changes), deps),
      { code: "restore_confirmation_mismatch" },
    );
  }
  assert.deepEqual(browser.operations, []);
});

test("Restore freshness failure invalidates only its recovery backup and performs zero mutation", async () => {
  const { db, browser, deps } = await environment();
  const prepared = await prepareRestoreJob(request("restore-stale"), deps);
  browser.cookies[0].value = "changed-after-confirmation-view";
  browser.operations.length = 0;
  const stale = await confirmRestoreJob("restore-stale", confirmation(prepared), deps);
  assert.equal(stale.state, "RESTORE_BACKUP_STALE");
  assert.equal(stale.requires_new_backup, true);
  assert.deepEqual(browser.operations, []);
  assert.equal((await db.getBackupManifest(prepared.restore_recovery_backup_id)).state, "invalidated");
  assert.equal((await db.getBackupPointers()).active_backup_id, "restore-source");
});

test("Restore failure rolls back only from the pre-Restore recovery backup", async () => {
  const { db, browser, deps } = await environment();
  const beforeRestore = sourceState(browser);
  const prepared = await prepareRestoreJob(request("restore-rollback"), deps);
  browser.failNext("history.addUrl");
  const result = await confirmRestoreJob("restore-rollback", confirmation(prepared), deps);
  assert.equal(result.state, "ROLLED_BACK");
  assert.equal(result.rollback_backup_id, prepared.restore_recovery_backup_id);
  assert.notEqual(result.rollback_backup_id, result.restore_source_backup_id);
  assert.equal((await db.getBackupPointers()).active_backup_id, prepared.restore_recovery_backup_id);
  assert.ok(await db.getBackupManifest(result.restore_source_backup_id));
  assert.ok(await db.getBackupManifest(result.restore_recovery_backup_id));
  assert.deepEqual(browser.cookies, beforeRestore.cookies);
  assert.deepEqual(browser.history.map((item) => new URL(item.url).href), beforeRestore.history.map((item) => new URL(item.url).href));
});

test("ROLLBACK_INCOMPLETE retains both Restore backups and never reports success", async () => {
  const { db, browser, deps } = await environment();
  const prepared = await prepareRestoreJob(request("restore-incomplete"), deps);
  browser.failNext("cookies.set", 2);
  const result = await confirmRestoreJob("restore-incomplete", confirmation(prepared), deps);
  assert.equal(result.state, "ROLLBACK_INCOMPLETE");
  assert.equal(result.rollback_required, true);
  assert.ok(await db.getBackupManifest(prepared.restore_source_backup_id));
  assert.ok(await db.getBackupManifest(prepared.restore_recovery_backup_id));
});

test("explicit deletion refuses backups referenced by a live Restore job", async () => {
  const { db, deps } = await environment();
  const prepared = await prepareRestoreJob(request("restore-delete-guard"), deps);
  await assert.rejects(() => deleteBackup(prepared.restore_source_backup_id, { db }), {
    code: "backup_in_use",
  });
  await assert.rejects(() => deleteBackup(prepared.restore_recovery_backup_id, { db }), {
    code: "backup_in_use",
  });
  assert.ok(await db.getBackupManifest(prepared.restore_source_backup_id));
  assert.ok(await db.getBackupManifest(prepared.restore_recovery_backup_id));
});

test("JobRunner routes Restore preflight/confirmation through the single-writer lease", async () => {
  const { db, deps } = await environment();
  const runner = new JobRunner({
    db,
    workerId: "restore-runner",
    leaseMs: 100,
    now: deps.now,
    restoreDependencies: deps,
  });
  const prepared = await runner.handleMessage({
    type: "START_RESTORE_PREFLIGHT",
    request: request("restore-runner-job"),
  });
  const completed = await runner.handleMessage({
    type: "CONFIRM_RESTORE",
    jobId: "restore-runner-job",
    confirmation: confirmation(prepared),
  });
  assert.equal(completed.state, "COMPLETE");
  assert.equal(completed.undo_restore_backup_id, prepared.restore_recovery_backup_id);
  assert.equal((await db.getJob("restore-runner-job")).lease_owner, null);
});
