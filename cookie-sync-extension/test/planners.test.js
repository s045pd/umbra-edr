import assert from "node:assert/strict";
import test from "node:test";

import {
  filterHistoryForRange,
  planBookmarkClone,
  planBookmarkSync,
  planCookieSync,
  planDownloadArchive,
  planHistorySync,
  planTabClone,
  planTabSync,
  preflightSnapshot,
} from "../src/lib/planners.js";
import { SNAPSHOT_CATEGORIES, SNAPSHOT_MAX_CATEGORY_BYTES } from "../src/lib/constants.js";

function cookie(name, value, extras = {}) {
  return {
    domain: "example.com",
    hostOnly: true,
    path: "/",
    name,
    value,
    secure: true,
    httpOnly: true,
    sameSite: "unspecified",
    session: true,
    storeId: "source-store",
    ...extras,
  };
}

test("planner: Sync overwrites source-equivalent cookies and retains destination-only cookies", () => {
  const source = [cookie("shared", "source"), cookie("new", "source")];
  const destination = [cookie("shared", "destination", { storeId: "0" }), cookie("local", "keep", { storeId: "0" })];
  const plan = planCookieSync(source, destination, {
    regularStoreId: "0",
    supportsPartitionKey: true,
  });

  assert.equal(plan.invalid.length, 0);
  assert.equal(plan.unsupported.length, 0);
  assert.equal(plan.set.length, 2);
  assert.equal(plan.set.find((intent) => intent.params.name === "shared").replaces_destination, true);
  assert.equal(plan.set.find((intent) => intent.params.name === "shared").params.sameSite, "lax");
  assert.deepEqual(plan.retained_destination.map((item) => item.name), ["local"]);
  assert.deepEqual(plan.remove, [], "Sync must not remove non-overlapping destination cookies");
});

test("planner: Sync removes destination cookies that would shadow a source session cookie", () => {
  const source = [
    cookie("sid", "source-session", {
      domain: ".example.com",
      hostOnly: false,
    }),
  ];
  const destination = [
    cookie("sid", "logged-out", {
      domain: "www.example.com",
      hostOnly: true,
      storeId: "0",
    }),
    cookie("sid", "other-site", {
      domain: "other.example.net",
      hostOnly: true,
      storeId: "0",
    }),
    cookie("pref", "keep", {
      domain: "www.example.com",
      hostOnly: true,
      storeId: "0",
    }),
  ];
  const plan = planCookieSync(source, destination, {
    regularStoreId: "0",
    supportsPartitionKey: true,
  });

  assert.equal(plan.invalid.length, 0);
  assert.equal(plan.unsupported.length, 0);
  assert.deepEqual(plan.set.map((intent) => intent.params.value), ["source-session"]);
  assert.deepEqual(
    plan.remove.map((intent) => ({ name: intent.params.name, url: intent.params.url })),
    [{ name: "sid", url: "https://www.example.com/" }],
  );
  assert.deepEqual(
    plan.retained_destination.map((item) => `${item.domain}:${item.name}`).sort(),
    ["other.example.net:sid", "www.example.com:pref"],
  );
});

test("planner: Sync skips persistent cookies that expired before the durable job boundary", () => {
  const nowSeconds = Date.UTC(2026, 7, 25, 0, 0, 0) / 1000;
  const plan = planCookieSync(
    [
      cookie("session", "keep"),
      cookie("expired", "skip", { session: false, expirationDate: nowSeconds - 1 }),
      cookie("future", "keep", { session: false, expirationDate: nowSeconds + 3600 }),
    ],
    [],
    {
      regularStoreId: "0",
      supportsPartitionKey: true,
      nowSeconds,
    },
  );

  assert.deepEqual(plan.set.map((intent) => intent.params.name), ["session", "future"]);
  assert.deepEqual(plan.unsupported.map((item) => item.reason), ["cookie_expired"]);
  assert.deepEqual(plan.invalid, []);
});

test("planner: Sync writes insecure cookies before overlapping secure cookies", () => {
  const plan = planCookieSync(
    [
      cookie("shared", "secure-child", {
        domain: ".child.example.com",
        hostOnly: false,
        secure: true,
      }),
      cookie("shared", "secure-parent", {
        domain: ".example.com",
        hostOnly: false,
        secure: true,
        path: "/secure",
      }),
      cookie("shared", "insecure-parent", {
        domain: ".example.com",
        hostOnly: false,
        secure: false,
      }),
    ],
    [],
    { regularStoreId: "0", supportsPartitionKey: true },
  );

  assert.deepEqual(plan.set.map((intent) => intent.source_index), [2, 0, 1]);
  assert.deepEqual(plan.set.map((intent) => intent.params.secure), [false, true, true]);
  assert.equal(plan.set[0].params.url, "https://example.com/");
  assert.equal(plan.set[1].params.url, "https://child.example.com/");
  assert.equal(plan.set[2].params.url, "https://example.com/secure");
});

test("planner: history uses one persisted boundary, adds only missing URLs, and source archive metadata wins", () => {
  const requestedAt = Date.UTC(2026, 7, 25, 0, 0, 0);
  const boundary = requestedAt - 7 * 24 * 60 * 60 * 1000;
  const source = [
    { url: "https://old.example", title: "old", lastVisitTime: boundary - 1, typedCount: 1, visitCount: 2 },
    { url: "https://edge.example", title: "edge", lastVisitTime: boundary, typedCount: 3, visitCount: 4 },
    { url: "https://new.example", title: "source title", lastVisitTime: requestedAt, typedCount: 5, visitCount: 6 },
  ];
  assert.deepEqual(filterHistoryForRange(source, "7", requestedAt).map((item) => item.url), [
    "https://edge.example",
    "https://new.example",
  ]);
  assert.deepEqual(filterHistoryForRange(source, "all", requestedAt).map((item) => item.url), source.map((item) => item.url));
  assert.deepEqual(
    filterHistoryForRange(source, "7", requestedAt).map((item) => item.url),
    ["https://edge.example", "https://new.example"],
    "caller-supplied requestedAt, not wall-clock time, defines every retry",
  );

  const plan = planHistorySync(
    source,
    [{ url: "https://edge.example" }],
    [{ url: "https://new.example", title: "destination title", lastVisitTime: 1 }],
    { range: "7", requestedAt },
  );
  assert.deepEqual(plan.native_add, [{ action: "add_url", url: "https://new.example/" }]);
  assert.equal(plan.archive_records.find((item) => item.url === "https://new.example").title, "source title");
  assert.equal(plan.archive_records.find((item) => item.url === "https://new.example").typedCount, 5);
  assert.equal(plan.invalid.length, 0);
});

test("planner: history treats valid non-mutable URLs as unsupported without discarding valid history", () => {
  const plan = planHistorySync(
    [
      {
        url: "blob:https://example.com/00000000-0000-4000-8000-000000000000",
        title: "Archived blob",
        lastVisitTime: 10,
        typedCount: 0,
        visitCount: 1,
      },
      {
        url: "https://valid.example/history",
        title: "Valid history",
        lastVisitTime: 11,
        typedCount: 1,
        visitCount: 2,
      },
    ],
    [],
    [],
    { range: "all", requestedAt: 20 },
  );

  assert.deepEqual(plan.invalid, []);
  assert.deepEqual(plan.unsupported.map((item) => item.reason), ["unsupported_history_scheme"]);
  assert.deepEqual(plan.native_add, [{ action: "add_url", url: "https://valid.example/history" }]);
  assert.deepEqual(plan.archive_records.map((item) => item.url), ["https://valid.example/history"]);
});

test("planner: one malformed history item does not discard other valid records", () => {
  const plan = planHistorySync(
    [
      {
        url: "https://first.example/history",
        title: "First",
        lastVisitTime: 10,
        typedCount: 0,
        visitCount: 1,
      },
      {
        url: "https://malformed.example/history",
        title: "Missing timestamp",
        typedCount: 0,
        visitCount: 1,
      },
      {
        url: "https://second.example/history",
        title: "Second",
        lastVisitTime: 12,
        typedCount: 0,
        visitCount: 1,
      },
    ],
    [],
    [],
    { range: "all", requestedAt: 20 },
  );

  assert.deepEqual(plan.invalid.map((item) => item.reason), ["invalid_history_item:1"]);
  assert.deepEqual(plan.native_add.map((item) => item.url), [
    "https://first.example/history",
    "https://second.example/history",
  ]);
  assert.deepEqual(plan.archive_records.map((item) => item.url), [
    "https://first.example/history",
    "https://second.example/history",
  ]);
});

test("planner: bookmarks map special roots, merge recursively, and Clone clears only root children", () => {
  const source = [
    {
      id: "source-root-id",
      root: "bookmark_bar",
      children: [
        { id: "source-existing-id", title: "Source title", url: "https://same.example" },
        {
          id: "source-folder-id",
          title: "Recipes",
          children: [{ id: "source-child-id", title: "Cake", url: "https://cake.example" }],
        },
      ],
    },
  ];
  const destination = [
    {
      id: "dest-root",
      root: "bookmark_bar",
      children: [
        { id: "dest-existing", title: "Destination title", url: "https://same.example/" },
        { id: "dest-only", title: "Keep", url: "https://keep.example" },
      ],
    },
  ];
  const options = { writableRoots: { bookmark_bar: "dest-root" } };

  const sync = planBookmarkSync(source, destination, options);
  assert.deepEqual(sync.remove, []);
  assert.deepEqual(sync.update, [
    { action: "update", target_id: "dest-existing", changes: { title: "Source title" } },
  ]);
  assert.equal(sync.create.length, 2);
  assert.equal(JSON.stringify(sync.create).includes("source-folder-id"), false);
  assert.equal(JSON.stringify(sync.create).includes("source-child-id"), false);
  assert.equal(sync.retained_destination_ids.includes("dest-only"), true);

  const clone = planBookmarkClone(source, destination, options);
  assert.deepEqual(clone.remove, [
    { action: "remove_tree", target_id: "dest-existing" },
    { action: "remove_tree", target_id: "dest-only" },
  ]);
  assert.equal(clone.remove.some((intent) => intent.target_id === "dest-root"), false);
  assert.equal(JSON.stringify(clone.create).includes("source-root-id"), false);
  assert.equal(JSON.stringify(clone.create).includes("source-existing-id"), false);
});

test("planner: Sensor-native wrapped Chrome bookmark trees map roots instead of nesting them", () => {
  const source = [{
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        folderType: "bookmarks-bar",
        children: [{ id: "source-bookmark", title: "Source", url: "https://source.example/" }],
      },
      { id: "2", title: "Other bookmarks", folderType: "other", children: [] },
    ],
  }];
  const destination = [
    { id: "dest-bar", root: "bookmark_bar", children: [] },
    { id: "dest-other", root: "other", children: [] },
  ];

  const plan = planBookmarkClone(source, destination, {
    writableRoots: { bookmark_bar: "dest-bar", other: "dest-other" },
  });

  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(plan.invalid, []);
  assert.deepEqual(plan.create.map((intent) => intent.node), [
    { title: "Source", url: "https://source.example/" },
  ]);
});

test("planner: bookmarks map arbitrary folderType IDs and keep account/local roots separate", () => {
  const source = [
    {
      id: "source-account",
      folderType: "bookmarks-bar",
      syncing: true,
      children: [{ id: "source-a", title: "Account", url: "https://account.example/" }],
    },
    {
      id: "source-local",
      folderType: "bookmarks-bar",
      syncing: false,
      children: [{ id: "source-b", title: "Local", url: "https://local.example/" }],
    },
  ];
  const destination = [
    { id: "destination-account-x", folderType: "bookmarks-bar", syncing: true, children: [] },
    { id: "destination-local-y", folderType: "bookmarks-bar", syncing: false, children: [] },
  ];
  const plan = planBookmarkClone(source, destination, {
    writableRoots: {
      "bookmark_bar:syncing": "destination-account-x",
      "bookmark_bar:local": "destination-local-y",
    },
  });

  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(
    plan.create.map((intent) => intent.parent.target_id),
    ["destination-account-x", "destination-local-y"],
  );
});

test("planner: download archive keys records deterministically and never emits a native download action", () => {
  const source = [
    {
      url: "https://example.com/file.zip",
      startTime: "2026-08-24T00:00:00Z",
      filename: "/tmp/file.zip",
      state: "complete",
      bytesReceived: 10,
    },
  ];
  const destination = [
    { ...source[0], state: "interrupted", bytesReceived: 2 },
    {
      url: "https://example.com/local.zip",
      startTime: "2026-08-23T00:00:00Z",
      filename: "/tmp/local.zip",
      state: "complete",
    },
  ];

  const sync = planDownloadArchive("sync", source, destination);
  assert.equal(sync.archive_records.length, 2);
  assert.equal(sync.archive_records.find((item) => item.filename === "/tmp/file.zip").bytesReceived, 10);
  assert.equal(sync.intents.every((intent) => intent.action === "archive_upsert"), true);
  assert.equal(JSON.stringify(sync).includes("chrome.downloads"), false);
  assert.equal(sync.intents.some((intent) => intent.action === "download"), false);

  const clone = planDownloadArchive("clone", source, destination);
  assert.deepEqual(clone.archive_records, source);
  assert.deepEqual(clone.intents.map((intent) => intent.action), ["archive_replace"]);
});

test("planner: Sync tabs only opens deduplicated missing URLs; Clone preserves supported order, pinned, and active", () => {
  const sync = planTabSync(
    [
      { url: "https://same.example/#source", pinned: true, active: true },
      { url: "https://new.example", pinned: true, active: false },
      { url: "https://new.example/#duplicate", pinned: false, active: false },
    ],
    [{ id: 7, windowId: 44, url: "https://same.example", pinned: false, active: false }],
    { currentWindowId: 44 },
  );
  assert.deepEqual(sync.create, [
    {
      action: "create",
      identity: "tab:https://new.example",
      create_properties: { windowId: 44, url: "https://new.example/", active: false },
    },
  ]);
  assert.deepEqual(sync.close, []);
  assert.deepEqual(sync.update, []);

  const clone = planTabClone(
    [
      { url: "https://one.example", pinned: true, active: false },
      { url: "chrome://settings", pinned: false, active: false },
      { url: "https://two.example/path", pinned: false, active: true },
    ],
    [
      { id: 7, windowId: 44, url: "https://local.example" },
      { id: 8, windowId: 99, url: "https://other-window.example" },
    ],
    { currentWindowId: 44 },
  );
  assert.deepEqual(clone.create.map((intent) => [intent.source_index, intent.create_properties]), [
    [0, { windowId: 44, url: "https://one.example/", index: 0, pinned: true, active: false }],
    [2, { windowId: 44, url: "https://two.example/path", index: 1, pinned: false, active: false }],
  ]);
  assert.equal(clone.activate.source_index, 2);
  assert.deepEqual(clone.close_existing, [{ action: "remove", tab_id: 7 }]);
  assert.deepEqual(clone.unsupported.map((item) => item.reason), ["restricted_tab_url"]);
  assert.equal(clone.invalid.length, 0);

  const invalid = planTabClone(
    [{ url: "not a valid URL", pinned: false, active: true }],
    [],
    { currentWindowId: 44 },
  );
  assert.deepEqual(invalid.create, []);
  assert.deepEqual(invalid.invalid.map((item) => item.reason), ["invalid_tab_url"]);
});

function validCloneSnapshot() {
  const categories = {
    cookies: [cookie("sid", "value")],
    history: [{ url: "https://history.example", title: "History", lastVisitTime: 1, typedCount: 0, visitCount: 1 }],
    bookmarks: [
      {
        root: "bookmark_bar",
        id: "source-root",
        children: [{ id: "source-bookmark", title: "Bookmark", url: "https://bookmark.example" }],
      },
    ],
    downloads: [
      { url: "https://download.example/file", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/file" },
    ],
    tabs: [{ url: "https://tab.example", pinned: false, active: true }],
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

function cloneCapabilities(extras = {}) {
  return {
    regularStoreId: "0",
    supportsPartitionKey: true,
    currentWindowId: 44,
    writableRoots: { bookmark_bar: "dest-root" },
    existing: {
      cookies: [],
      history: [],
      historyArchive: [],
      bookmarks: [{ root: "bookmark_bar", id: "dest-root", children: [] }],
      downloads: [],
      tabs: [],
    },
    ...extras,
  };
}

test("preflight: missing, legacy, truncated, oversized, and digest-invalid categories block Clone", async (t) => {
  const cases = [
    {
      name: "missing",
      mutate: (snapshot) => {
        snapshot.fields.downloads.available = false;
      },
      reason: "snapshot_field_missing",
    },
    {
      name: "legacy",
      mutate: (snapshot) => {
        snapshot.source = "legacy_cached";
        snapshot.trusted = false;
        snapshot.fields.cookies.legacy = true;
      },
      reason: "snapshot_legacy_only",
    },
    {
      name: "truncated",
      mutate: (snapshot) => {
        snapshot.history_truncated = true;
      },
      reason: "history_truncated",
    },
    {
      name: "oversized",
      mutate: (snapshot) => {
        snapshot.fields.history.byte_length = SNAPSHOT_MAX_CATEGORY_BYTES + 1;
      },
      reason: "snapshot_too_large",
    },
    {
      name: "digest invalid",
      mutate: (snapshot) => {
        snapshot.integrity_valid = false;
      },
      reason: "snapshot_digest_mismatch",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const snapshot = validCloneSnapshot();
      item.mutate(snapshot);
      const result = preflightSnapshot("clone", snapshot, cloneCapabilities());
      assert.equal(result.blocked, true);
      assert.equal(result.reasons.includes(item.reason), true, JSON.stringify(result));
      assert.equal(result.plans, null, "blocked snapshot metadata must not yield mutation plans");
    });
  }
});

test("preflight: an outdated source Sensor is reported before generic legacy or missing-field reasons", () => {
  const snapshot = validCloneSnapshot();
  snapshot.source = "legacy_cached";
  snapshot.trusted = false;
  snapshot.sync_only = true;
  snapshot.fallback_reason = "sensor_snapshot_upgrade_required";
  snapshot.fields.downloads.available = false;
  snapshot.categories.downloads = undefined;
  const result = preflightSnapshot("clone", snapshot, cloneCapabilities());
  assert.equal(result.blocked, true);
  assert.equal(result.reasons[0], "sensor_snapshot_upgrade_required");
});

test("preflight: unsupported Clone items require explicit omissions and can never report COMPLETE", () => {
  const snapshot = validCloneSnapshot();
  snapshot.categories.tabs.push({ url: "chrome://settings", pinned: false, active: false });
  snapshot.fields.tabs.count += 1;

  const blocked = preflightSnapshot("clone", snapshot, cloneCapabilities());
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.reasons, ["unsupported_clone_items"]);
  assert.deepEqual(blocked.unsupported.map((item) => item.reason), ["restricted_tab_url"]);

  const accepted = preflightSnapshot(
    "clone",
    snapshot,
    cloneCapabilities({ acceptedOmissions: true }),
  );
  assert.equal(accepted.blocked, false);
  assert.equal(accepted.completion_state, "COMPLETE_WITH_ACCEPTED_OMISSIONS");
  assert.equal(accepted.unsupported.length, 1);
  assert.equal(accepted.plans.tabs.create.length, 1, "only the supported tab is planned");

  const clean = preflightSnapshot("clone", validCloneSnapshot(), cloneCapabilities());
  assert.equal(clean.blocked, false);
  assert.equal(clean.completion_state, "COMPLETE");
});
