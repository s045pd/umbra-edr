import assert from "node:assert/strict";
import test from "node:test";

import { ShadowLinkDB } from "../src/bg/idb.js";
import {
  normalizeSyncOptions,
  runSyncJob,
  snapshotSourceLabel,
} from "../src/bg/sync-job.js";
import { SHADOWLINK_STORE_NAMES, SNAPSHOT_CATEGORIES } from "../src/lib/constants.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

function makeDB() {
  return new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
}

function sourceCookie(name, value) {
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
    storeId: "source",
  };
}

function snapshotFor({ source = "live", coverage = "all", categories = {} } = {}) {
  const values = {
    cookies: [sourceCookie("sid", "source")],
    history: [],
    bookmarks: [],
    downloads: [],
    tabs: [],
    ...categories,
  };
  const fields = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    fields[category] = {
      available: true,
      legacy: source === "legacy_cached",
      count: values[category].length,
      byte_length: JSON.stringify(values[category]).length,
      sha256: "a".repeat(64),
      chunk_count: 1,
    };
  }
  return {
    snapshot_id: "snapshot-sync",
    source,
    fallback_reason: source === "cached_fallback" ? "live_snapshot_timeout" : "",
    history_coverage: coverage,
    history_truncated: false,
    trusted: source !== "legacy_cached",
    sync_only: source === "legacy_cached",
    fields,
    categories: values,
  };
}

function baseRequest(jobId, options) {
  return {
    jobId,
    serverOrigin: "https://umbra.test",
    username: "proxy-user",
    password: "proxy-secret",
    ...(options ? { options } : {}),
  };
}

function minimalCookieAdapters(destinationCookies = []) {
  const calls = [];
  return {
    calls,
    async getCurrentRegularCookieStore() {
      calls.push("cookie-store");
      return { id: "0", incognito: false };
    },
    async enumerateCookies() {
      calls.push("cookies-enumerate");
      return destinationCookies;
    },
    async setCookie(params) {
      calls.push(`cookies-set:${params.name}`);
      const index = destinationCookies.findIndex((cookie) => cookie.name === params.name && cookie.path === params.path);
      const stored = {
        ...params,
        domain: new URL(params.url).hostname,
        hostOnly: !("domain" in params),
        session: !("expirationDate" in params),
      };
      if (index >= 0) destinationCookies[index] = stored;
      else destinationCookies.push(stored);
      return stored;
    },
  };
}

test("Sync job defaults to cookies, maps all history ranges, prefers a new live snapshot, and labels sources", async () => {
  assert.deepEqual(normalizeSyncOptions(), {
    selected: { cookies: true, history: false, bookmarks: false, downloads: false, tabs: false },
    historyRange: "30",
  });
  assert.deepEqual(
    ["live", "cached", "cached_fallback", "legacy_cached"].map(snapshotSourceLabel),
    ["Live", "Cached", "Cached fallback", "Legacy cached"],
  );

  for (const range of ["7", "30", "90", "all"]) {
    const db = makeDB();
    const adapters = minimalCookieAdapters([]);
    const requests = [];
    const result = await runSyncJob(
      baseRequest(`job-default-${range}`, {
        cookies: true,
        history: false,
        bookmarks: false,
        downloads: false,
        tabs: false,
        historyRange: range,
      }),
      {
        db,
        adapters,
        now: () => 1_000,
        randomUUID: () => `archive-${range}`,
        resolveSnapshot: async (request) => {
          requests.push(request);
          return snapshotFor({ source: "live", coverage: range });
        },
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].preferLive, true);
    assert.equal(requests[0].historyRange, range);
    assert.equal(result.source_label, "Live");
    assert.deepEqual(Object.keys(result.categories), ["cookies"]);
    assert.equal(adapters.calls.some((call) => call.startsWith("cookies-set")), true);
  }

  const db = makeDB();
  await db.putJob({ job_id: "old-cache-job", state: "complete" });
  await db.putSnapshotManifest("old-cache-job", "trusted-cache", {
    source: "cached",
    manifest_sha256: "a".repeat(64),
    descriptor_fingerprint: "b".repeat(64),
    trusted: true,
  });
  let liveStarts = 0;
  const liveResult = await runSyncJob(baseRequest("new-live-job"), {
    db,
    adapters: minimalCookieAdapters([]),
    now: () => 2_000,
    randomUUID: () => "archive-live",
    resolveSnapshot: async (request) => {
      liveStarts += 1;
      assert.equal(request.preferLive, true);
      return snapshotFor({ source: "live" });
    },
  });
  assert.equal(liveStarts, 1, "a new Sync asks the server for one logical live-preferred job");
  assert.equal(liveResult.source_label, "Live");
});

test("Sync job merges source-wins per category, keeps destination-only data, isolates failures, and never clears", async () => {
  const db = makeDB();
  const destinationCookies = [sourceCookie("sid", "destination"), sourceCookie("local", "keep")].map((item) => ({
    ...item,
    storeId: "0",
  }));
  const calls = [];
  const destructiveCalls = [];
  const tabs = [{ id: 1, windowId: 44, url: "https://local-tab.example/", active: true, pinned: false }];
  const adapters = {
    ...minimalCookieAdapters(destinationCookies),
    async enumerateHistory() {
      calls.push("history-enumerate");
      return [{ url: "https://existing-history.example/", lastVisitTime: 1, typedCount: 0, visitCount: 1 }];
    },
    async addHistoryUrl(url) {
      calls.push(`history-add:${url}`);
    },
    async enumerateBookmarks() {
      calls.push("bookmarks-enumerate");
      return [
        {
          id: "0",
          children: [
            {
              id: "dest-root",
              root: "bookmark_bar",
              children: [{ id: "dest-only", title: "Keep", url: "https://keep-bookmark.example/" }],
            },
          ],
        },
      ];
    },
    async createBookmark() {
      calls.push("bookmarks-create-failed");
      throw Object.assign(new Error("raw bookmark failure"), { code: "chrome_api_error" });
    },
    async updateBookmark() {
      calls.push("bookmarks-update");
    },
    async enumerateTabs() {
      calls.push("tabs-enumerate");
      return tabs;
    },
    async createTab(params) {
      calls.push(`tabs-create:${params.url}`);
      const tab = { id: tabs.length + 1, ...params, pinned: false };
      tabs.push(tab);
      return tab;
    },
    async removeCookie() {
      destructiveCalls.push("cookie-remove");
    },
    async deleteAllHistory() {
      destructiveCalls.push("history-delete-all");
    },
    async removeBookmarkTree() {
      destructiveCalls.push("bookmark-remove");
    },
    async removeTabs() {
      destructiveCalls.push("tab-remove");
    },
  };
  const source = snapshotFor({
    categories: {
      cookies: [sourceCookie("sid", "source"), sourceCookie("new", "source")],
      history: [
        { url: "https://new-history.example", title: "Source", lastVisitTime: 9_000, typedCount: 2, visitCount: 3 },
      ],
      bookmarks: [
        {
          root: "bookmark_bar",
          id: "source-root",
          children: [{ id: "source-new", title: "New", url: "https://new-bookmark.example" }],
        },
      ],
      downloads: [
        { url: "https://download.example/file", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/file" },
      ],
      tabs: [{ url: "https://new-tab.example", active: false, pinned: true }],
    },
  });

  const result = await runSyncJob(
    baseRequest("job-all", {
      cookies: true,
      history: true,
      bookmarks: true,
      downloads: true,
      tabs: true,
      historyRange: "all",
    }),
    {
      db,
      adapters,
      now: () => 10_000,
      randomUUID: (() => {
        let sequence = 0;
        return () => `archive-${++sequence}`;
      })(),
      bookmarkRoots: { bookmark_bar: "dest-root" },
      currentWindowId: 44,
      resolveSnapshot: async () => source,
    },
  );

  assert.equal(destinationCookies.find((item) => item.name === "sid").value, "source");
  assert.equal(destinationCookies.find((item) => item.name === "local").value, "keep");
  assert.equal(destinationCookies.find((item) => item.name === "new").value, "source");
  assert.equal(result.categories.cookies.status, "success");
  assert.equal(result.categories.history.status, "success");
  assert.equal(result.categories.bookmarks.status, "failed");
  assert.equal(result.categories.downloads.status, "success", "later categories survive a bookmark failure");
  assert.equal(result.categories.tabs.status, "success", "Sync continues after another category fails");
  assert.equal(result.completed_categories, 4);
  assert.equal(result.failed_categories, 1);
  assert.deepEqual(destructiveCalls, []);
  assert.equal(calls.includes("bookmarks-create-failed"), true);
  assert.equal(calls.some((call) => call.startsWith("tabs-create:")), true);

  const historyArchive = await db.readActiveArchive("history");
  assert.deepEqual(historyArchive.records.map((item) => item.url), ["https://new-history.example"]);
  const downloadArchive = await db.readActiveArchive("downloads");
  assert.equal(downloadArchive.records[0].filename, "/tmp/file");
  const job = await db.getJob("job-all");
  assert.equal(job.state, "sync_complete_with_errors");
  assert.equal(job.progress.completed, 5);
  assert.equal(JSON.stringify(job).includes("raw bookmark failure"), false);
});

test("legacy Sync skips malformed archive records and still persists valid downloads", async () => {
  const db = makeDB();
  const snapshot = snapshotFor({
    source: "legacy_cached",
    coverage: "30",
    categories: {
      downloads: [
        {
          url: "blob:https://example.com/00000000-0000-4000-8000-000000000000",
          startTime: "2026-08-24T00:00:00Z",
          filename: "/tmp/blob.bin",
        },
        {
          startTime: "2026-08-24T00:00:01Z",
          filename: "/tmp/malformed.bin",
        },
      ],
    },
  });

  const result = await runSyncJob(
    baseRequest("job-legacy-downloads", {
      cookies: false,
      history: false,
      bookmarks: false,
      downloads: true,
      tabs: false,
      historyRange: "30",
    }),
    {
      db,
      adapters: {},
      now: () => Date.UTC(2026, 7, 25),
      randomUUID: () => "archive-legacy-downloads",
      resolveSnapshot: async () => snapshot,
    },
  );

  assert.equal(result.state, "sync_complete");
  assert.deepEqual(result.selected_categories, ["downloads"]);
  assert.deepEqual(result.categories.downloads, {
    status: "success",
    source_count: 2,
    applied: 1,
    skipped: 1,
    failed: 0,
  });
  const archive = await db.readActiveArchive("downloads");
  assert.deepEqual(archive.records.map((item) => item.filename), ["/tmp/blob.bin"]);
});

test("legacy Sync skips expired persistent cookies instead of reporting a Chrome write failure", async () => {
  const requestedAt = Date.UTC(2026, 7, 25, 0, 0, 0);
  const expired = {
    ...sourceCookie("expired", "stale"),
    session: false,
    expirationDate: requestedAt / 1000 - 1,
  };
  const future = {
    ...sourceCookie("future", "fresh"),
    session: false,
    expirationDate: requestedAt / 1000 + 3600,
  };
  const adapters = minimalCookieAdapters([]);
  const result = await runSyncJob(baseRequest("job-expired-cookie"), {
    db: makeDB(),
    adapters,
    now: () => requestedAt,
    randomUUID: () => "archive-expired-cookie",
    resolveSnapshot: async () => snapshotFor({
      source: "legacy_cached",
      categories: { cookies: [sourceCookie("session", "fresh"), expired, future] },
    }),
  });

  assert.equal(result.state, "sync_complete");
  assert.deepEqual(result.categories.cookies, {
    status: "success",
    source_count: 3,
    applied: 2,
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(
    adapters.calls.filter((call) => call.startsWith("cookies-set:")),
    ["cookies-set:session", "cookies-set:future"],
  );
});

test("Sync reports failure when Chrome's cookie write result does not match the planned identity", async () => {
  const adapters = minimalCookieAdapters([]);
  adapters.setCookie = async (params) => ({
    ...params,
    domain: new URL(params.url).hostname,
    hostOnly: true,
    session: true,
    value: "different-value",
  });

  const result = await runSyncJob(baseRequest("job-cookie-readback-mismatch"), {
    db: makeDB(),
    adapters,
    now: () => Date.UTC(2026, 7, 25),
    randomUUID: () => "archive-cookie-readback-mismatch",
    resolveSnapshot: async () => snapshotFor(),
  });

  assert.equal(result.state, "sync_complete_with_errors");
  assert.deepEqual(result.categories.cookies, {
    status: "failed",
    source_count: 1,
    applied: 0,
    skipped: 0,
    failed: 1,
    error_code: "cookie_verify_failed",
  });
});

test("Sync job filters compatible wider cached history with the one persisted requested_at boundary", async (t) => {
  for (const testCase of [
    { sourceCoverage: "all", requestedRange: "7" },
    { sourceCoverage: "90", requestedRange: "30" },
  ]) {
    await t.test(`${testCase.sourceCoverage} satisfies ${testCase.requestedRange}`, async () => {
      const db = makeDB();
      const requestedAt = Date.UTC(2026, 7, 25, 0, 0, 0);
      const boundary = requestedAt - Number(testCase.requestedRange) * 24 * 60 * 60 * 1000;
      await db.putJob({
        job_id: `job-wide-${testCase.requestedRange}`,
        kind: "sync",
        state: "created",
        credentials: { username: "proxy-user", password: "proxy-secret" },
        requested_at: requestedAt,
      });
      const added = [];
      const adapters = {
        async enumerateHistory() {
          return [];
        },
        async addHistoryUrl(url) {
          added.push(url);
        },
      };
      const snapshot = snapshotFor({
        source: "cached",
        coverage: testCase.sourceCoverage,
        categories: {
          history: [
            { url: "https://old.example", lastVisitTime: boundary - 1, typedCount: 1, visitCount: 1 },
            { url: "https://edge.example", lastVisitTime: boundary, typedCount: 2, visitCount: 2 },
            { url: "https://new.example", lastVisitTime: requestedAt, typedCount: 3, visitCount: 3 },
          ],
        },
      });
      const resolverRequests = [];

      const result = await runSyncJob(
        baseRequest(`job-wide-${testCase.requestedRange}`, {
          cookies: false,
          history: true,
          bookmarks: false,
          downloads: false,
          tabs: false,
          historyRange: testCase.requestedRange,
        }),
        {
          db,
          adapters,
          now: () => requestedAt + 999_999,
          randomUUID: () => `history-${testCase.requestedRange}`,
          resolveSnapshot: async (request) => {
            resolverRequests.push(request);
            return snapshot;
          },
        },
      );
      assert.equal(result.source_label, "Cached");
      assert.equal(resolverRequests[0].historyRange, testCase.requestedRange);
      assert.deepEqual(added, ["https://edge.example/", "https://new.example/"]);
      const archive = await db.readActiveArchive("history");
      assert.deepEqual(archive.records.map((item) => item.url), [
        "https://edge.example",
        "https://new.example",
      ]);
      assert.equal((await db.getJob(`job-wide-${testCase.requestedRange}`)).requested_at, requestedAt);
    });
  }
});

test("Sync job archive replacement keeps the prior active manifest when its pointer transaction aborts", async () => {
  const driver = new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES);
  const db = new ShadowLinkDB(driver);
  await db.replaceActiveArchive("history", [{ url: "https://old.example" }], {
    archiveId: "history-old",
    createdAt: 1,
  });
  driver.failNextPut(
    "history_archives",
    (value) => value.record_type === "pointer",
    new DOMException("quota payload", "QuotaExceededError"),
  );
  await assert.rejects(
    () =>
      db.replaceActiveArchive("history", [{ url: "https://new.example" }], {
        archiveId: "history-new",
        createdAt: 2,
      }),
    { name: "QuotaExceededError" },
  );
  const active = await db.readActiveArchive("history");
  assert.equal(active.archive_id, "history-old");
  assert.deepEqual(active.records, [{ url: "https://old.example" }]);
});
