import assert from "node:assert/strict";
import test from "node:test";

import {
  CLONE_STATE_SEQUENCE,
  confirmCloneJob,
  prepareCloneJob,
} from "../src/bg/clone-job.js";
import { ShadowLinkDB } from "../src/bg/idb.js";
import { SHADOWLINK_STORE_NAMES, SNAPSHOT_CATEGORIES, SNAPSHOT_MAX_CATEGORY_BYTES } from "../src/lib/constants.js";
import { FakeBrowser } from "./helpers/fake-browser.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

function makeDB() {
  return new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
}

function sourceCookie(name, value) {
  return {
    storeId: "source",
    domain: "source.example",
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

function cloneSnapshot() {
  const categories = {
    cookies: [sourceCookie("source", "source-value")],
    history: [
      { url: "https://source-history.example/", title: "Source", lastVisitTime: 10, typedCount: 1, visitCount: 2 },
    ],
    bookmarks: [
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            folderType: "bookmarks-bar",
            children: [{ id: "source-bookmark", title: "Source", url: "https://source-bookmark.example/" }],
          },
          { id: "2", title: "Other bookmarks", folderType: "other", children: [] },
        ],
      },
    ],
    downloads: [
      { url: "https://download.example/file", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/source-file" },
    ],
    tabs: [
      { url: "https://source-tab-one.example/", pinned: true, active: false },
      { url: "https://source-tab-two.example/", pinned: false, active: true },
    ],
  };
  const fields = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    fields[category] = {
      available: true,
      legacy: false,
      count: categories[category].length,
      byte_length: JSON.stringify(categories[category]).length,
      sha256: "a".repeat(64),
      chunk_count: 1,
    };
  }
  return {
    snapshot_id: "snapshot-clone",
    source: "live",
    trusted: true,
    sync_only: false,
    schema_version: 1,
    manifest_sha256: "b".repeat(64),
    history_coverage: "all",
    history_truncated: false,
    integrity_valid: true,
    fields,
    categories,
  };
}

function cloneRequest(jobId = "clone-job", extras = {}) {
  return {
    jobId,
    serverOrigin: "https://umbra.test",
    username: "proxy-user",
    password: "proxy-secret",
    ...extras,
  };
}

async function environment({ snapshot = cloneSnapshot(), browser = new FakeBrowser(), db = makeDB() } = {}) {
  let sequence = 0;
  const deps = {
    db,
    adapters: browser.adapters(),
    resolveSnapshot: async (request) => {
      assert.equal(request.historyRange, "all");
      assert.equal(request.preferLive, true);
      return structuredClone(snapshot);
    },
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
    randomUUID: () => `generated-${++sequence}`,
    writableRoots: { bookmark_bar: "1", other: "2" },
    currentWindowId: 44,
    cookieEnumerationComplete: true,
    supportsPartitionKey: true,
  };
  return { deps, db, browser, snapshot };
}

test("Clone follows the exact durable state sequence and mutation order", async () => {
  const { deps, db, browser } = await environment();
  const prepared = await prepareCloneJob(cloneRequest(), deps);
  assert.equal(prepared.state, "AWAITING_DESTRUCTIVE_CONFIRMATION");
  assert.equal(prepared.backup_id, "generated-1");
  browser.operations.length = 0;

  const completed = await confirmCloneJob(
    "clone-job",
    { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
    deps,
  );
  assert.equal(completed.state, "COMPLETE", completed.error_code || completed.rollback_error_code);
  assert.deepEqual(completed.state_history, [...CLONE_STATE_SEQUENCE, "COMPLETE"]);
  assert.equal(completed.credentials, undefined, "terminal jobs scrub endpoint credentials");
  assert.equal(completed.rollback_required, false);

  const mutationOrder = browser.operations
    .map((entry) => entry.method)
    .filter((method) =>
      ["cookies.remove", "cookies.set", "history.deleteAll", "history.addUrl", "bookmarks.removeTree", "bookmarks.create", "tabs.create"].includes(method),
    );
  const first = (prefix) => mutationOrder.findIndex((method) => method.startsWith(prefix));
  assert.equal(first("cookies." ) >= 0, true);
  assert.equal(first("cookies.") < first("history."), true);
  assert.equal(first("history.") < first("bookmarks."), true);
  assert.equal(first("bookmarks.") < first("tabs."), true);
  const downloadArchive = await db.readActiveArchive("downloads");
  assert.equal(downloadArchive.source_snapshot_id, "snapshot-clone");
  assert.deepEqual(browser.history.map((item) => new URL(item.url).href), ["https://source-history.example/"]);
  assert.deepEqual(browser.tabs.map((tab) => [tab.url, tab.pinned, tab.active]), [
    ["https://source-tab-one.example/", true, false],
    ["https://source-tab-two.example/", false, true],
  ]);
});

test("Clone removes history entries created as a side effect of opening source tabs", async () => {
  const browser = new FakeBrowser({ tabNavigationsAddHistory: true });
  const { deps } = await environment({ browser });
  const prepared = await prepareCloneJob(cloneRequest("clone-tab-history-side-effect"), deps);

  const completed = await confirmCloneJob(
    "clone-tab-history-side-effect",
    { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
    deps,
  );

  assert.equal(completed.state, "COMPLETE", completed.error_code || completed.rollback_error_code);
  assert.deepEqual(
    browser.history.map((item) => new URL(item.url).href),
    ["https://source-history.example/"],
  );
  assert.deepEqual(
    browser.operations
      .filter((entry) => entry.method === "history.deleteUrl")
      .map((entry) => new URL(entry.detail.url).href)
      .sort(),
    ["https://source-tab-one.example/", "https://source-tab-two.example/"],
  );
});

test("Clone accepted omissions can only finish COMPLETE_WITH_ACCEPTED_OMISSIONS", async () => {
  const snapshot = cloneSnapshot();
  snapshot.categories.tabs.push({ url: "chrome://settings/", pinned: false, active: false });
  snapshot.fields.tabs.count += 1;
  const { deps } = await environment({ snapshot });
  const prepared = await prepareCloneJob(cloneRequest("clone-omissions", { acceptedOmissions: true }), deps);
  assert.equal(prepared.unsupported.length, 1);
  const completed = await confirmCloneJob(
    "clone-omissions",
    { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
    deps,
  );
  assert.equal(completed.state, "COMPLETE_WITH_ACCEPTED_OMISSIONS");
  assert.equal(completed.result.unsupported.length, 1);
});

test("Clone blocks missing, legacy, truncated, oversized, and digest-invalid snapshots before backup or mutation", async (t) => {
  const cases = [
    ["missing", (snapshot) => (snapshot.fields.downloads.available = false), "snapshot_field_missing"],
    [
      "legacy",
      (snapshot) => {
        snapshot.source = "legacy_cached";
        snapshot.trusted = false;
        snapshot.fields.cookies.legacy = true;
      },
      "snapshot_legacy_only",
    ],
    ["truncated", (snapshot) => (snapshot.history_truncated = true), "history_truncated"],
    ["oversized", (snapshot) => (snapshot.fields.history.byte_length = SNAPSHOT_MAX_CATEGORY_BYTES + 1), "snapshot_too_large"],
    ["digest", (snapshot) => (snapshot.integrity_valid = false), "snapshot_digest_mismatch"],
  ];
  for (const [name, mutate, reason] of cases) {
    await t.test(name, async () => {
      const snapshot = cloneSnapshot();
      mutate(snapshot);
      const { deps, db, browser } = await environment({ snapshot });
      const result = await prepareCloneJob(cloneRequest(`blocked-${name}`), deps);
      assert.equal(result.state, "FAILED_BEFORE_MUTATION");
      assert.equal(result.error_code, reason);
      assert.equal(result.backup_id, undefined);
      assert.deepEqual(await db.listBackupChunks("none"), []);
      assert.deepEqual(browser.operations, []);
    });
  }
});

test("Clone binds confirmation to backup ID/digest and invalidates a stale destination with zero mutation", async () => {
  const { deps, browser } = await environment();
  const prepared = await prepareCloneJob(cloneRequest("clone-stale"), deps);
  await assert.rejects(
    () =>
      confirmCloneJob(
        "clone-stale",
        { backupId: prepared.backup_id, manifestSHA256: "0".repeat(64) },
        deps,
      ),
    { code: "backup_confirmation_mismatch" },
  );
  browser.cookies[0].value = "changed-after-confirmation-view";
  browser.operations.length = 0;
  const stale = await confirmCloneJob(
    "clone-stale",
    { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
    deps,
  );
  assert.equal(stale.state, "BACKUP_STALE");
  assert.equal(stale.requires_new_backup, true);
  assert.equal(stale.requires_confirmation, true);
  assert.deepEqual(browser.operations, []);
});

test("Clone durably marks rollback before using the active pre-Clone backup for failures in every phase", async (t) => {
  const cases = [
    ["cookie remove", "cookies.remove"],
    ["cookie write", "cookies.set"],
    ["history", "history.addUrl"],
    ["bookmark", "bookmarks.create"],
    ["tabs", "tabs.create"],
    ["verification", "verify"],
  ];
  for (const [name, failMethod] of cases) {
    await t.test(name, async () => {
      const { deps, db, browser } = await environment();
      const jobId = `rollback-${name}`;
      const prepared = await prepareCloneJob(cloneRequest(jobId), deps);
      if (failMethod === "verify") {
        deps.verifyDestination = async () => {
          throw Object.assign(new Error("raw verify failure"), { code: "destination_verify_failed" });
        };
      } else {
        browser.failNext(failMethod);
      }
      let durableBeforeRollback = false;
      deps.onRollbackStart = async () => {
        const job = await db.getJob(jobId);
        durableBeforeRollback = job.rollback_required === true && job.state === "ROLLING_BACK";
      };
      const result = await confirmCloneJob(
        jobId,
        { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
        deps,
      );
      assert.equal(durableBeforeRollback, true);
      assert.equal(result.state, "ROLLED_BACK");
      assert.equal(result.rollback_backup_id, prepared.backup_id);
      assert.equal(result.state === "COMPLETE" || result.state === "COMPLETE_WITH_ACCEPTED_OMISSIONS", false);
      assert.equal((await db.getBackupPointers()).active_backup_id, prepared.backup_id);
    });
  }
});

test("Clone reports ROLLBACK_INCOMPLETE instead of success when rollback itself fails", async () => {
  const { deps, browser } = await environment();
  const prepared = await prepareCloneJob(cloneRequest("rollback-incomplete"), deps);
  browser.failNext("cookies.set", 2);
  const result = await confirmCloneJob(
    "rollback-incomplete",
    { backupId: prepared.backup_id, manifestSHA256: prepared.backup_manifest_sha256 },
    deps,
  );
  assert.equal(result.state, "ROLLBACK_INCOMPLETE");
  assert.equal(result.rollback_required, true);
  assert.equal(result.credentials, undefined);
});
