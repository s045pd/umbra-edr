import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_CATEGORIES,
  cancelStagedBackup,
  confirmFreshnessAndPromote,
  readBackupCategory,
  stageDestinationBackup,
  verifyStagedBackup,
} from "../src/bg/backup.js";
import { ShadowLinkDB } from "../src/bg/idb.js";
import { sha256Hex } from "../src/lib/hash.js";
import { SHADOWLINK_STORE_NAMES } from "../src/lib/constants.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

function makeDB(driver = new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES)) {
  return new ShadowLinkDB(driver);
}

function destinationState() {
  return {
    cookies: [
      {
        storeId: "regular",
        domain: "example.com",
        hostOnly: true,
        path: "/",
        name: "sid",
        value: "cookie-value",
        secure: true,
        httpOnly: true,
        sameSite: "unspecified",
        session: true,
        partitionKey: { topLevelSite: "https://shop.example", hasCrossSiteAncestor: false },
      },
    ],
    history: [
      { url: "https://history.example/", title: "Alpha", lastVisitTime: 10, typedCount: 1, visitCount: 2 },
    ],
    bookmarkTree: [
      {
        id: "0",
        children: [
          {
            id: "1",
            root: "bookmark_bar",
            title: "Bookmarks bar",
            children: [{ id: "b1", title: "One", url: "https://bookmark.example/" }],
          },
          { id: "2", root: "other", title: "Other bookmarks", children: [] },
        ],
      },
    ],
    tabs: [
      { id: 11, windowId: 44, index: 0, url: "chrome://settings/", pinned: true, active: false },
      { id: 12, windowId: 44, index: 1, url: "https://tab.example/", pinned: false, active: true },
    ],
  };
}

function destinationAdapters(state, failures = {}) {
  return {
    async getCurrentRegularCookieStore() {
      if (failures.cookieStore) throw failures.cookieStore;
      return { id: "regular", incognito: false, tabIds: [11, 12] };
    },
    async enumerateCookies(storeId) {
      if (failures.cookies) throw failures.cookies;
      assert.equal(storeId, "regular");
      return structuredClone(state.cookies);
    },
    async enumerateHistory() {
      if (failures.history) throw failures.history;
      return structuredClone(state.history);
    },
    async enumerateBookmarks() {
      if (failures.bookmarks) throw failures.bookmarks;
      return structuredClone(state.bookmarkTree);
    },
    async enumerateTabs() {
      if (failures.tabs) throw failures.tabs;
      return structuredClone(state.tabs);
    },
  };
}

async function seedArchives(db) {
  await db.replaceActiveArchive(
    "history",
    [{ url: "https://archive-history.example", title: "Archived", lastVisitTime: 5, typedCount: 1, visitCount: 1 }],
    { archiveId: "history-active", createdAt: 1 },
  );
  await db.replaceActiveArchive(
    "downloads",
    [{ url: "https://download.example/file", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/file" }],
    { archiveId: "downloads-active", createdAt: 1 },
  );
}

function backupDeps(db, state, extras = {}) {
  return {
    db,
    adapters: destinationAdapters(state, extras.failures),
    writableRoots: { bookmark_bar: "1", other: "2" },
    currentWindowId: 44,
    cookieEnumerationComplete: true,
    now: () => 100,
    randomUUID: () => "backup-staged",
    ...extras,
  };
}

test("backup stages all six complete categories, including store/partition mapping, restricted tabs, and exact raw digests", async () => {
  const db = makeDB();
  const state = destinationState();
  await seedArchives(db);
  const staged = await stageDestinationBackup({ purpose: "clone" }, backupDeps(db, state));
  assert.deepEqual(Object.keys(staged.manifest.categories).sort(), [...BACKUP_CATEGORIES].sort());
  assert.equal(staged.manifest.state, "staged");
  assert.equal(staged.manifest.verified, false);
  assert.equal((await db.getBackupPointers()), undefined, "staging cannot change active pointers");

  const verified = await verifyStagedBackup(staged.backup_id, { db, now: () => 101 });
  assert.equal(verified.verified, true);
  assert.equal(verified.state, "staged");
  assert.equal(verified.awaiting_confirmation, true);

  const cookies = await readBackupCategory(db, staged.backup_id, "cookies");
  assert.equal(cookies.regular_store_id, "regular");
  assert.deepEqual(cookies.items[0].partitionKey, {
    topLevelSite: "https://shop.example",
    hasCrossSiteAncestor: false,
  });
  const history = await readBackupCategory(db, staged.backup_id, "native_history");
  assert.equal(history.coverage, "all");
  assert.equal(history.truncated, false);
  const bookmarks = await readBackupCategory(db, staged.backup_id, "bookmarks");
  assert.deepEqual(bookmarks.roots.map((root) => root.root), ["bookmark_bar", "other"]);
  assert.equal(JSON.stringify(bookmarks).includes('"id"'), false, "destination bookmark IDs are never restore IDs");
  const tabs = await readBackupCategory(db, staged.backup_id, "tabs");
  assert.deepEqual(tabs.items, [
    { url: "chrome://settings/", index: 0, pinned: true, active: false },
    { url: "https://tab.example/", index: 1, pinned: false, active: true },
  ]);
  assert.equal((await readBackupCategory(db, staged.backup_id, "history_archive")).records.length, 1);
  assert.equal((await readBackupCategory(db, staged.backup_id, "download_archive")).records.length, 1);

  for (const category of BACKUP_CATEGORIES) {
    const descriptor = verified.categories[category];
    const chunks = await db.listBackupChunks(staged.backup_id, category);
    const raw = new Uint8Array(descriptor.byte_length);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
      assert.equal(await sha256Hex(chunk.bytes), chunk.sha256);
    }
    assert.equal(offset, descriptor.byte_length);
    assert.equal(await sha256Hex(raw), descriptor.sha256, `${category} exact raw digest`);
  }
});

test("backup treats verified empty categories as authoritative rather than unavailable", async () => {
  const db = makeDB();
  const state = destinationState();
  state.cookies = [];
  state.history = [];
  state.bookmarkTree[0].children[0].children = [];
  state.bookmarkTree[0].children[1].children = [];
  state.tabs = [];
  const staged = await stageDestinationBackup(
    { purpose: "clone" },
    backupDeps(db, state, { currentWindowId: 44 }),
  );
  const verified = await verifyStagedBackup(staged.backup_id, { db, now: () => 101 });
  for (const category of BACKUP_CATEGORIES) {
    assert.equal(verified.categories[category].available, true, category);
    assert.equal(verified.categories[category].complete, true, category);
    assert.equal(verified.categories[category].count, 0, category);
    assert.equal(verified.categories[category].byte_length > 0, true, category);
    assert.equal(verified.categories[category].chunk_count, 1, category);
  }
});

test("backup preserves arbitrary-ID account and local bookmark roots as separate trees", async () => {
  const db = makeDB();
  const state = destinationState();
  state.bookmarkTree[0].children = [
    {
      id: "account-bar-x7",
      folderType: "bookmarks-bar",
      syncing: true,
      title: "Account bookmarks",
      children: [{ id: "account-item", title: "Account", url: "https://account.example/" }],
    },
    {
      id: "local-bar-y2",
      folderType: "bookmarks-bar",
      syncing: false,
      title: "Local bookmarks",
      children: [{ id: "local-item", title: "Local", url: "https://local.example/" }],
    },
    {
      id: "other-z9",
      folderType: "other",
      syncing: true,
      title: "Other bookmarks",
      children: [],
    },
  ];
  await seedArchives(db);
  const staged = await stageDestinationBackup(
    { purpose: "clone", backupId: "dual-root-backup" },
    backupDeps(db, state, {
      writableRoots: {
        "bookmark_bar:syncing": "account-bar-x7",
        "bookmark_bar:local": "local-bar-y2",
        other: "other-z9",
      },
    }),
  );
  await verifyStagedBackup(staged.backup_id, { db, now: () => 101 });
  const bookmarks = await readBackupCategory(db, staged.backup_id, "bookmarks");

  assert.deepEqual(bookmarks.roots.map((root) => root.root), [
    "bookmark_bar:syncing",
    "bookmark_bar:local",
    "other",
  ]);
  assert.deepEqual(bookmarks.roots.map((root) => root.children[0]?.title || ""), [
    "Account",
    "Local",
    "",
  ]);
});

test("backup blocks incomplete enumeration, missing tabs/roots, and item or byte limits before promotion", async (t) => {
  const cases = [
    {
      name: "cookie partition enumeration incomplete",
      configure: (deps) => {
        deps.cookieEnumerationComplete = false;
      },
      code: "backup_incomplete",
    },
    {
      name: "history incomplete",
      configure: (deps) => {
        deps.adapters = destinationAdapters(destinationState(), {
          history: Object.assign(new Error("raw history failure"), { code: "history_window_incomplete" }),
        });
      },
      code: "backup_incomplete",
    },
    {
      name: "bookmark root missing",
      configure: (deps) => {
        deps.writableRoots = { bookmark_bar: "1", other: "missing-root" };
      },
      code: "backup_incomplete",
    },
    {
      name: "tab URL missing",
      configure: (deps, state) => {
        delete state.tabs[0].url;
      },
      code: "backup_incomplete",
    },
    {
      name: "item limit",
      configure: (deps) => {
        deps.limits = { maxItemsPerCategory: 0, maxCategoryBytes: 1_000_000, maxTotalBytes: 2_000_000 };
      },
      code: "backup_incomplete",
    },
    {
      name: "byte limit",
      configure: (deps) => {
        deps.limits = { maxItemsPerCategory: 100, maxCategoryBytes: 8, maxTotalBytes: 48 };
      },
      code: "snapshot_too_large",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const db = makeDB();
      const state = destinationState();
      const deps = backupDeps(db, state);
      item.configure(deps, state);
      const error = await stageDestinationBackup({ purpose: "clone" }, deps).catch((caught) => caught);
      assert.equal(error.code, item.code);
      assert.equal((await db.getBackupPointers()), undefined);
      assert.equal(error.message.includes("raw"), false);
    });
  }
});

test("backup surfaces quota/write failures and preserves the previous active backup", async () => {
  const driver = new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES);
  const db = makeDB(driver);
  const state = destinationState();
  const first = await stageDestinationBackup(
    { purpose: "clone", backupId: "backup-active" },
    backupDeps(db, state, { randomUUID: () => "backup-active" }),
  );
  await verifyStagedBackup(first.backup_id, { db, now: () => 101 });
  await db.promoteBackup(first.backup_id, 102);

  driver.failNextPut(
    "backup_chunks",
    () => true,
    new DOMException("quota secret", "QuotaExceededError"),
  );
  const error = await stageDestinationBackup(
    { purpose: "clone", backupId: "backup-failed" },
    backupDeps(db, state, { randomUUID: () => "backup-failed" }),
  ).catch((caught) => caught);
  assert.equal(error.code, "backup_quota_exceeded");
  assert.equal((await db.getBackupPointers()).active_backup_id, "backup-active");
  assert.equal((await db.getBackupManifest("backup-active")).state, "active");
});

test("backup read-back rejects staged chunk and manifest mismatches", async (t) => {
  await t.test("chunk mismatch", async () => {
    const db = makeDB();
    const staged = await stageDestinationBackup(
      { purpose: "clone" },
      backupDeps(db, destinationState()),
    );
    const [chunk] = await db.listBackupChunks(staged.backup_id, "cookies");
    const tampered = new Uint8Array(chunk.bytes.slice(0));
    tampered[0] ^= 1;
    await db.putBackupChunk({ ...chunk, bytes: tampered.buffer });
    await assert.rejects(
      () => verifyStagedBackup(staged.backup_id, { db, now: () => 101 }),
      { code: "backup_verify_failed" },
    );
  });

  await t.test("manifest mismatch", async () => {
    const db = makeDB();
    const staged = await stageDestinationBackup(
      { purpose: "clone" },
      backupDeps(db, destinationState()),
    );
    const manifest = await db.getBackupManifest(staged.backup_id);
    await db.putBackupManifest({ ...manifest, manifest_sha256: "0".repeat(64) });
    await assert.rejects(
      () => verifyStagedBackup(staged.backup_id, { db, now: () => 101 }),
      { code: "backup_verify_failed" },
    );
  });
});

test("backup cancellation deletes only staged data and never the active/previous backup", async () => {
  const db = makeDB();
  const state = destinationState();
  const first = await stageDestinationBackup(
    { purpose: "clone", backupId: "backup-active" },
    backupDeps(db, state, { randomUUID: () => "backup-active" }),
  );
  await verifyStagedBackup(first.backup_id, { db, now: () => 101 });
  await db.promoteBackup(first.backup_id, 102);
  const second = await stageDestinationBackup(
    { purpose: "clone", backupId: "backup-cancel" },
    backupDeps(db, state, { randomUUID: () => "backup-cancel" }),
  );
  assert.equal((await db.listBackupChunks(second.backup_id)).length > 0, true);
  await cancelStagedBackup(second.backup_id, { db });
  assert.equal(await db.getBackupManifest(second.backup_id), undefined);
  assert.deepEqual(await db.listBackupChunks(second.backup_id), []);
  assert.equal((await db.getBackupPointers()).active_backup_id, "backup-active");
  assert.equal((await db.listBackupChunks(first.backup_id)).length > 0, true);
  await assert.rejects(() => cancelStagedBackup(first.backup_id, { db }), {
    code: "backup_in_use",
  });
});

test("freshness invalidates confirmation on identity, count, byte, or digest changes with zero mutation", async (t) => {
  const cases = [
    {
      name: "identity",
      mutate: (state) => {
        state.cookies[0].name = "different";
      },
    },
    {
      name: "count",
      mutate: (state) => {
        state.tabs.push({ id: 13, windowId: 44, index: 2, url: "https://third.example/", pinned: false, active: false });
      },
    },
    {
      name: "byte length",
      mutate: (state) => {
        state.cookies[0].value = "a-longer-cookie-value";
      },
    },
    {
      name: "digest only",
      mutate: (state) => {
        state.history[0].title = "Bravo";
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const db = makeDB();
      const state = destinationState();
      const deps = backupDeps(db, state);
      const staged = await stageDestinationBackup({ purpose: "clone" }, deps);
      const verified = await verifyStagedBackup(staged.backup_id, { db, now: () => 101 });
      item.mutate(state);
      let mutationCalls = 0;
      const result = await confirmFreshnessAndPromote(
        { backupId: staged.backup_id, manifestSHA256: verified.manifest_sha256 },
        deps,
        async () => {
          mutationCalls += 1;
        },
      );
      assert.equal(result.fresh, false);
      assert.equal(result.requires_new_backup, true);
      assert.equal(result.requires_confirmation, true);
      assert.equal(mutationCalls, 0);
      assert.equal((await db.getBackupPointers()), undefined);
      assert.equal((await db.getBackupManifest(staged.backup_id)).state, "invalidated");
    });
  }
});

test("freshness promotes only the confirmed unchanged backup immediately before the first mutation", async () => {
  const db = makeDB();
  const state = destinationState();
  const deps = backupDeps(db, state);
  const staged = await stageDestinationBackup({ purpose: "clone" }, deps);
  const verified = await verifyStagedBackup(staged.backup_id, { db, now: () => 101 });
  let mutationCalls = 0;
  const result = await confirmFreshnessAndPromote(
    { backupId: staged.backup_id, manifestSHA256: verified.manifest_sha256 },
    deps,
    async ({ backupId }) => {
      mutationCalls += 1;
      assert.equal(backupId, staged.backup_id);
      assert.equal((await db.getBackupPointers()).active_backup_id, staged.backup_id);
    },
  );
  assert.equal(result.fresh, true);
  assert.equal(result.promoted, true);
  assert.equal(mutationCalls, 1);
  assert.equal((await db.getBackupManifest(staged.backup_id)).state, "active");

  await assert.rejects(
    () =>
      confirmFreshnessAndPromote(
        { backupId: staged.backup_id, manifestSHA256: "0".repeat(64) },
        deps,
        async () => {
          throw new Error("must not execute");
        },
      ),
    { code: "backup_confirmation_mismatch" },
  );
});
